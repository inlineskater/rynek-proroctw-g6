-- ════════════════════════════════════════════════════════════════════════════
--  🎪 „Festyn plonów" — the Spichlerz fills a bar, the bar buys everyone +10%
--  (2026-10-29)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm-granary.sql and farm-nft-social.sql. Idempotent.
--  ⚠️ Supersedes farm_harvest_yield() from farm-nft-social.sql and
--     farm_granary_state() from farm-granary.sql — re-run this after re-running
--     either of those.
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  The Spichlerz alone gave only rankings and a title, which nobody but the top
--  donor cares about (owner's feedback). The Wspólny Cel worked because one
--  player's surplus bought something for the whole office. This puts that loop
--  back, endlessly and without anyone having to invent the next goal:
--
--    every farm_festival_threshold() (50 000 🪙) of crops given to the Spichlerz
--    → a 24-hour „Festyn plonów": +10% on every harvest, for every player.
--
--  The bar counts only donations made to the Spichlerz itself (the carried-over
--  Wspólny Cel rows already bought the office its five plots). A donation that
--  overfills the bar queues the next festival straight after the current one, at
--  most farm_festival_max_queued() (3) ahead; past that the bar just waits full.
--
--  ── Why it is safe for the economy ─────────────────────────────────────────
--  It mints no coin. More crop units still sell through the demand-throttled
--  NPC budget and the fair-share tiers (farm-fair-share.sql), so a festival
--  changes WHO gets the budget a little and how much rots, not how many coins
--  the farm prints. The multiplier sits OUTSIDE the neighbours bonus cap on
--  purpose: inside it, the players already at the cap would get nothing.
--
--  A festival is decided when it is HARVESTED, not planted: grow time is floored
--  at 24 h, so every growing plot ripens once inside a 24-hour window and every
--  player can catch it.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Policy (one-line functions, served to the client by the state RPC) ──────
CREATE OR REPLACE FUNCTION public.farm_festival_threshold() RETURNS bigint
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 50000::bigint $fn$;
CREATE OR REPLACE FUNCTION public.farm_festival_hours() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 24 $fn$;
CREATE OR REPLACE FUNCTION public.farm_festival_bonus() RETURNS numeric
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.10::numeric $fn$;
CREATE OR REPLACE FUNCTION public.farm_festival_max_queued() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 3 $fn$;


CREATE TABLE IF NOT EXISTS public.farm_festivals (
  n          integer PRIMARY KEY,          -- 1st, 2nd, … filled bar
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  donors     text,                         -- who filled this bar, for the UI/chat
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_festivals_ends_idx ON public.farm_festivals (ends_at DESC);

ALTER TABLE public.farm_festivals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_festivals_select" ON public.farm_festivals;
CREATE POLICY "farm_festivals_select" ON public.farm_festivals
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_festivals FROM anon, authenticated;
GRANT SELECT ON public.farm_festivals TO authenticated;


-- Value given to the Spichlerz itself (not the carried-over goal rows).
CREATE OR REPLACE FUNCTION public.farm_festival_raised()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(sum(value), 0)::bigint FROM public.farm_granary_donations
   WHERE goal_contribution_id IS NULL;
$fn$;


-- Turns every full bar into a festival. Called by the state RPC (which the
-- client calls straight after each donation) and by an hourly cron, so a bar
-- that waited on a full queue still fires once the queue frees.
CREATE OR REPLACE FUNCTION public.farm_festival_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_t       bigint := public.farm_festival_threshold();
  v_raised  bigint;
  v_n       integer;
  v_start   timestamptz;
  v_end     timestamptz;
  v_donors  text;
  v_admin   uuid;
  v_made    integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('farm_festival_tick'));
  v_raised := public.farm_festival_raised();

  LOOP
    SELECT COALESCE(max(n), 0) INTO v_n FROM public.farm_festivals;
    EXIT WHEN v_raised < (v_n + 1) * v_t;
    EXIT WHEN (SELECT count(*) FROM public.farm_festivals WHERE ends_at > now())
              >= public.farm_festival_max_queued();

    SELECT GREATEST(now(), COALESCE(max(ends_at), now())) INTO v_start FROM public.farm_festivals;
    v_end := v_start + make_interval(hours => public.farm_festival_hours());

    -- Donors whose running total fell inside this bar's slice of the ledger.
    SELECT string_agg(nick, ', ' ORDER BY amt DESC) INTO v_donors FROM (
      SELECT p.nick, sum(least(r.cum, (v_n + 1) * v_t) - greatest(r.cum - r.value, v_n * v_t)) AS amt
        FROM (SELECT user_id, value,
                     sum(value) OVER (ORDER BY created_at, id) AS cum
                FROM public.farm_granary_donations
               WHERE goal_contribution_id IS NULL) r
        JOIN public.profiles p ON p.id = r.user_id
       WHERE r.cum > v_n * v_t AND r.cum - r.value < (v_n + 1) * v_t
       GROUP BY p.nick) d;

    INSERT INTO public.farm_festivals (n, starts_at, ends_at, donors)
    VALUES (v_n + 1, v_start, v_end, v_donors);
    v_made := v_made + 1;

    SELECT id INTO v_admin FROM public.profiles WHERE is_admin ORDER BY created_at LIMIT 1;
    IF v_admin IS NOT NULL THEN
      INSERT INTO public.chat_messages (sender_id, recipient_id, sender_nick, body)
      VALUES (v_admin, NULL, '🌾 Ogródek', left(
        '🎪 Spichlerz pełny! ' ||
        CASE WHEN v_start <= now() + interval '1 minute'
             THEN 'Festyn plonów trwa do ' || to_char(v_end AT TIME ZONE 'Europe/Warsaw', 'DD.MM HH24:MI')
             ELSE 'Kolejny Festyn plonów od ' || to_char(v_start AT TIME ZONE 'Europe/Warsaw', 'DD.MM HH24:MI')
                  || ' do ' || to_char(v_end AT TIME ZONE 'Europe/Warsaw', 'DD.MM HH24:MI') END ||
        ': +' || round(public.farm_festival_bonus() * 100) || '% do każdego zbioru dla wszystkich.' ||
        COALESCE(' Dzięki: ' || v_donors || '!', ''), 1000));
    END IF;
  END LOOP;

  RETURN v_made;
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_festival_tick() FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.farm_festival_mult()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.farm_festivals
                            WHERE starts_at <= now() AND ends_at > now())
              THEN 1 + public.farm_festival_bonus() ELSE 1 END;
$fn$;
GRANT EXECUTE ON FUNCTION public.farm_festival_mult() TO authenticated;


-- ── Harvest hook: farm-nft-social.sql's body × the festival ────────────────
-- Verbatim copy of the live definition with ONLY v_fest added.
CREATE OR REPLACE FUNCTION public.farm_harvest_yield(p_tile public.farm_tiles, p_user uuid, p_core numeric, p_crop_type text)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_weather   numeric := public.farm_weather_yield_mult(p_crop_type, p_tile.planted_at, p_tile.ready_at);
  v_land      numeric := public.farm_yield_bonus(p_user);
  v_combo     numeric := 0;
  v_combos    json;
  v_species   integer := 0;
  v_div_plus  integer := 0;
  v_div       numeric := 0;
  v_t_crop    numeric := 0;
  v_t_all     numeric := 0;
  v_shield    boolean := false;
  v_wdouble   boolean := false;
  v_waters    integer := 0;
  v_water     numeric := 0;
  v_talent    boolean := false;
  v_bonus     numeric;
  v_cap       numeric;
  v_gross     integer;
  v_stolen    integer := 0;
  v_sets      numeric := public.farm_nft_set_bonus(p_user);
  v_fest      numeric := public.farm_festival_mult();
BEGIN
  -- Talents
  SELECT COALESCE(max(value) FILTER (WHERE kind = 'crop_boost' AND crop_type = p_crop_type), 0),
         COALESCE(max(value) FILTER (WHERE kind = 'all_boost'), 0),
         bool_or(kind = 'weather_shield'),
         bool_or(kind = 'water_double'),
         COALESCE(max(value) FILTER (WHERE kind = 'diversity_plus'), 0)::integer
    INTO v_t_crop, v_t_all, v_shield, v_wdouble, v_div_plus
    FROM public.farm_active_talents(p_user);
  v_shield  := COALESCE(v_shield, false);
  v_wdouble := COALESCE(v_wdouble, false);
  IF v_shield THEN v_weather := GREATEST(1.0, v_weather); END IF;

  -- Companion pairs: partner crop planted on ANOTHER of the owner's plots.
  SELECT COALESCE(sum(cp.bonus), 0),
         COALESCE(json_agg(json_build_object('name', cp.name, 'bonus', cp.bonus)), '[]'::json)
    INTO v_combo, v_combos
    FROM public.farm_companion_pairs cp
   WHERE p_crop_type IN (cp.a, cp.b)
     AND EXISTS (
       SELECT 1 FROM public.farm_tiles t
         JOIN public.farm_card_defs d ON d.species = t.planted_species
        WHERE t.owner_id = p_user AND t.planted_species IS NOT NULL
          AND NOT (t.x = p_tile.x AND t.y = p_tile.y)
          AND d.crop_type = CASE WHEN cp.a = p_crop_type THEN cp.b ELSE cp.a END);

  -- Diversity
  SELECT count(DISTINCT planted_species) INTO v_species
    FROM public.farm_tiles WHERE owner_id = p_user AND planted_species IS NOT NULL;
  v_div := public.farm_diversity_bonus(v_species + v_div_plus);

  -- Watering this cycle
  SELECT count(*) INTO v_waters FROM public.farm_tile_events
   WHERE x = p_tile.x AND y = p_tile.y AND planted_at = p_tile.planted_at AND kind = 'water';
  v_water := v_waters * public.farm_water_bonus() * CASE WHEN v_wdouble THEN 2 ELSE 1 END;

  v_talent := (v_t_crop > 0 OR v_t_all > 0);
  v_cap    := public.farm_bonus_cap(v_talent);
  v_bonus  := LEAST(v_cap, v_combo + v_div + v_t_crop + v_t_all + v_water + v_sets);

  -- 🎪 The festival multiplies OUTSIDE the cap (see the header).
  v_gross := round(p_core * (1 + v_land) * v_weather * (1 + v_bonus) * v_fest)::integer;

  SELECT COALESCE(sum(qty), 0) INTO v_stolen FROM public.farm_tile_events
   WHERE x = p_tile.x AND y = p_tile.y AND planted_at = p_tile.planted_at AND kind = 'steal';

  RETURN json_build_object(
    'yield', GREATEST(0, v_gross - v_stolen),
    'gross', v_gross,
    'stolen', v_stolen,
    'weather_mult', v_weather,
    'weather_shield', v_shield,
    'land', v_land,
    'combo', v_combo, 'combos', v_combos,
    'species', v_species + v_div_plus, 'diversity', v_div,
    'talent_crop', v_t_crop, 'talent_all', v_t_all,
    'waters', v_waters, 'water', v_water,
    'sets', v_sets,
    'festival', v_fest,
    'bonus', v_bonus, 'bonus_cap', v_cap);
END;
$fn$;


-- ── Read model: farm-granary.sql's state + the festival bar ────────────────
-- Now plpgsql and VOLATILE, because it ticks the festivals first.
DROP FUNCTION IF EXISTS public.farm_granary_state();
CREATE FUNCTION public.farm_granary_state()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wk     timestamptz := date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw';
  v_t      bigint := public.farm_festival_threshold();
  v_raised bigint;
  v_n      integer;
  v_out    json;
BEGIN
  PERFORM public.farm_festival_tick();
  v_raised := public.farm_festival_raised();
  SELECT COALESCE(max(n), 0) INTO v_n FROM public.farm_festivals;

  SELECT json_build_object(
    'titles',      public.farm_granary_titles(),
    'total',       (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations),
    'total_qty',   (SELECT COALESCE(sum(qty), 0)   FROM public.farm_granary_donations),
    'week_total',  (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations WHERE created_at >= v_wk),
    'my_total',    (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations WHERE user_id = auth.uid()),
    'my_week',     (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations
                     WHERE user_id = auth.uid() AND created_at >= v_wk),
    'all_time', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.id AS user_id, p.nick, gt.total, gt.qty, gt.title
          FROM public.farm_granary_totals gt
          JOIN public.profiles p ON p.id = gt.user_id
         ORDER BY gt.total DESC LIMIT 20) t), '[]'::json),
    'week', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.id AS user_id, p.nick, sum(d.value)::bigint AS total, sum(d.qty)::bigint AS qty
          FROM public.farm_granary_donations d
          JOIN public.profiles p ON p.id = d.user_id
         WHERE d.created_at >= v_wk
         GROUP BY p.id, p.nick
         ORDER BY sum(d.value) DESC LIMIT 20) t), '[]'::json),
    'festival', json_build_object(
      'threshold', v_t,
      'bonus',     public.farm_festival_bonus(),
      'hours',     public.farm_festival_hours(),
      'max_queued', public.farm_festival_max_queued(),
      'count',     v_n,
      -- Progress toward the NEXT bar; may exceed the threshold while the queue is full.
      'progress',  GREATEST(0, v_raised - v_n * v_t),
      'active',    (SELECT row_to_json(f) FROM (SELECT n, starts_at, ends_at, donors
                      FROM public.farm_festivals WHERE starts_at <= now() AND ends_at > now()
                      ORDER BY n LIMIT 1) f),
      'queued',    COALESCE((SELECT json_agg(row_to_json(f)) FROM (SELECT n, starts_at, ends_at, donors
                      FROM public.farm_festivals WHERE starts_at > now() ORDER BY n) f), '[]'::json),
      'last',      (SELECT row_to_json(f) FROM (SELECT n, starts_at, ends_at, donors
                      FROM public.farm_festivals ORDER BY n DESC LIMIT 1) f))
  ) INTO v_out;
  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_granary_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_granary_state() TO authenticated;


-- Backstop: a bar that waited on a full queue fires once the queue frees, even
-- if nobody opens the Ogródek. Minute 50 is clear of every other farm job.
DO $$
BEGIN
  PERFORM cron.unschedule('farm_festival_tick')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'farm_festival_tick');
  PERFORM cron.schedule('farm_festival_tick', '50 * * * *', 'SELECT public.farm_festival_tick()');
END $$;

-- Live bar: everyone watching sees a festival start the moment it does.
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_festivals; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
