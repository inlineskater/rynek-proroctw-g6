-- ════════════════════════════════════════════════════════════════════════════
--  NFT social layer — 📖 Album, 🔥 Ołtarz, 🏛️ Wystawa, 🖼️ Wizytówka  (2026-10-03)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm-nft-monthly.sql (and after farm-neighbours.sql). Idempotent.
--
--  ⚠️ SUPERSEDES farm_harvest_yield() from farm-neighbours.sql (adds the album
--     set bonus inside the same cap) — re-run this file after re-running that.
--  ⚠️ Owns the farm_nft_transfers kind CHECK ('altar' added); farm-nft-breeding.sql
--     carries the same list so a re-run there keeps it.
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  Measured 2026-10-03: 55 live NFTs, 17 planted, 0 listed, 3 sales ever — the
--  cards had nothing to do once drawn. Four things to do with one, none of
--  which mints a coin (so docs/anti-inflation.md and the four coin-reason
--  consumers in CLAUDE.md are untouched):
--
--  📖 Album — sets of species. A set is complete while you HOLD one live copy of
--     every species in it (a one-time touch doesn't count, so a group can't pass
--     one card around). Each complete set adds +2% yield on all your plots,
--     INSIDE the existing neighbours cap (+25% / +35%), so it can never push a
--     harvest past a ceiling that already exists. A missing piece is the first
--     real reason to buy an NFT from someone else.
--  🔥 Ołtarz — burn an NFT for ⭐ Złote Skrzynie: max(1, ceil(value / 1000)).
--     Below face value on purpose (a gold box is worth 500 in net worth): it is
--     a sink for trophies, not an exchange.
--  🏛️ Wystawa — one card per player per Warsaw week, the office votes (secret
--     ballot, counts public), the winner gets a ⭐ Złota Skrzynia and a permanent
--     🏆 on the card. Settled lazy-on-read, like bank_settle_due().
--  🖼️ Wizytówka — pick one NFT to show next to your nick in Biuro and the chat.
--     Its own table, deliberately NOT a profiles column with a FK: an
--     ON DELETE SET NULL there would lock ANOTHER player's profiles row whenever
--     a sold-on card is burned — the cross-user lock last-active.sql warns about.
-- ════════════════════════════════════════════════════════════════════════════


-- ══ 📖 Album ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.farm_nft_sets (
  code     text PRIMARY KEY,
  name     text NOT NULL,
  emoji    text NOT NULL,
  blurb    text,
  species  text[] NOT NULL,
  sort     integer NOT NULL DEFAULT 0
);
ALTER TABLE public.farm_nft_sets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_nft_sets_select" ON public.farm_nft_sets;
CREATE POLICY "farm_nft_sets_select" ON public.farm_nft_sets FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_nft_sets FROM anon, authenticated;
GRANT SELECT ON public.farm_nft_sets TO authenticated;

INSERT INTO public.farm_nft_sets (code, name, emoji, blurb, species, sort) VALUES
  ('classic',  'Klasyka',                        '💎', 'Pierwsze cztery legendy Ogródka.',
     ARRAY['diamond_rose','golden_sunflower','crystal_lotus','aeae_banana'], 10),
  ('summer26', 'Lato 2026',                      '☀️', 'Tygodniowe kolekcje od lipca do sierpnia.',
     ARRAY['lavender_provence','golden_harvest','garden_hollyhock','imperial_dahlia','golden_marigold','vine_grape'], 20),
  ('autumn26', 'Jesień 2026',                    '🍂', 'Ostatnie tygodniowe kolekcje, wrzesień–październik.',
     ARRAY['noble_boletus','autumn_heather','sweet_chestnut','giant_pumpkin','fiery_maple','royal_chrysanth'], 30),
  ('hybrids',  'Hybrydy z przepisu',             '🧬', 'Sześć kultowych krzyżówek Klasyki.',
     ARRAY['sunrose','paradise_lotus','crystal_peony','golden_nenufar','royal_rose_banana','sunny_banana'], 40),
  ('prl_q1',   'Złota Polska Jesień i Święta',   '🎄', 'Złota Kolekcja PRL: listopad, grudzień, styczeń.',
     ARRAY['prl_pumpkin','prl_pineapple','prl_carrot'], 50),
  ('prl_q2',   'Przedwiośnie z Goździkiem',      '🌷', 'Złota Kolekcja PRL: luty, marzec, kwiecień.',
     ARRAY['prl_chili','prl_potato','prl_tomato'], 60),
  ('prl_q3',   'Wczasy pod Gruszą',              '🏖️', 'Złota Kolekcja PRL: maj, czerwiec, lipiec.',
     ARRAY['prl_corn','prl_strawberry','prl_grapes'], 70),
  ('prl_all',  'Pełny Rok PRL',                  '🏆', 'Wszystkie dziewięć miesięcy Złotej Kolekcji PRL naraz.',
     ARRAY['prl_pumpkin','prl_pineapple','prl_carrot','prl_chili','prl_potato','prl_tomato','prl_corn','prl_strawberry','prl_grapes'], 80)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, emoji = EXCLUDED.emoji, blurb = EXCLUDED.blurb,
  species = EXCLUDED.species, sort = EXCLUDED.sort;

-- First completion per player, for the „ukończyli" list (the bonus itself is
-- always computed from what you hold right now).
CREATE TABLE IF NOT EXISTS public.farm_nft_set_completions (
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  set_code           text NOT NULL REFERENCES public.farm_nft_sets(code) ON DELETE CASCADE,
  first_completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, set_code)
);
ALTER TABLE public.farm_nft_set_completions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_nft_set_completions_select" ON public.farm_nft_set_completions;
CREATE POLICY "farm_nft_set_completions_select" ON public.farm_nft_set_completions FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_nft_set_completions FROM anon, authenticated;
GRANT SELECT ON public.farm_nft_set_completions TO authenticated;

-- Policy knob. Client mirror: FNFT_SET_BONUS in tabs/farm-nft.js.
CREATE OR REPLACE FUNCTION public.farm_nft_set_bonus_per_set()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.02::numeric; $$;

CREATE OR REPLACE FUNCTION public.farm_nft_complete_sets(p_user uuid)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(s.code ORDER BY s.sort), '{}')
    FROM public.farm_nft_sets s
   WHERE p_user IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM unnest(s.species) sp
        WHERE NOT EXISTS (SELECT 1 FROM public.farm_nft_instances i
                           WHERE i.owner_id = p_user AND i.species = sp));
$$;
REVOKE ALL ON FUNCTION public.farm_nft_complete_sets(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_nft_complete_sets(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.farm_nft_set_bonus(p_user uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.farm_nft_set_bonus_per_set() * cardinality(public.farm_nft_complete_sets(p_user));
$$;
REVOKE ALL ON FUNCTION public.farm_nft_set_bonus(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_nft_set_bonus(uuid) TO authenticated;

-- The album page: every set with its species, what the caller holds, and who
-- has completed it. Stamps the caller's first completions as a side effect.
CREATE OR REPLACE FUNCTION public.farm_nft_album_state()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_done text[];
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  v_done := public.farm_nft_complete_sets(v_user);
  INSERT INTO public.farm_nft_set_completions (user_id, set_code)
  SELECT v_user, unnest(v_done)
  ON CONFLICT DO NOTHING;

  RETURN json_build_object(
    'per_set', public.farm_nft_set_bonus_per_set(),
    'complete', to_json(v_done),
    'bonus', public.farm_nft_set_bonus_per_set() * cardinality(v_done),
    'sets', COALESCE((
      SELECT json_agg(json_build_object(
        'code', s.code, 'name', s.name, 'emoji', s.emoji, 'blurb', s.blurb,
        'complete', s.code = ANY(v_done),
        'species', (
          SELECT json_agg(json_build_object(
            'species', sp, 'name', d.name, 'emoji', d.emoji,
            'edition_size', d.edition_size, 'minted', d.minted_count,
            'is_active', d.is_active, 'series_month', d.series_month,
            'live', (SELECT count(*) FROM public.farm_nft_instances i WHERE i.species = sp),
            'mine', (SELECT count(*) FROM public.farm_nft_instances i WHERE i.species = sp AND i.owner_id = v_user)
          ) ORDER BY o)
          FROM unnest(s.species) WITH ORDINALITY AS u(sp, o)
          LEFT JOIN public.farm_card_defs d ON d.species = u.sp),
        'completed_by', COALESCE((
          SELECT json_agg(json_build_object('nick', p.nick, 'at', c.first_completed_at) ORDER BY c.first_completed_at)
            FROM public.farm_nft_set_completions c
            JOIN public.profiles p ON p.id = c.user_id
           WHERE c.set_code = s.code), '[]'::json)
      ) ORDER BY s.sort)
      FROM public.farm_nft_sets s), '[]'::json)
  );
END $$;
REVOKE ALL ON FUNCTION public.farm_nft_album_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_nft_album_state() TO authenticated;


-- ══ The yield hook, now with the album set bonus ═══════════════════════════
-- Verbatim copy of farm-neighbours.sql's version; the only change is the
-- `v_sets` term, added inside LEAST(v_cap, …) so the ceiling is unchanged.
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

  v_gross := round(p_core * (1 + v_land) * v_weather * (1 + v_bonus))::integer;

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
    'bonus', v_bonus, 'bonus_cap', v_cap);
END;
$fn$;
REVOKE ALL ON FUNCTION public.farm_harvest_yield(public.farm_tiles, uuid, numeric, text) FROM PUBLIC, anon, authenticated;

-- ══ 🖼️ Wizytówka ════════════════════════════════════════════════════════════
-- No FK to farm_nft_instances on purpose (see the header): a stale pointer is
-- harmless — the client shows it only while the card still belongs to you, and
-- sacrifice_nft() clears its own.
CREATE TABLE IF NOT EXISTS public.farm_nft_showcase (
  user_id     uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_nft_showcase_instance_idx ON public.farm_nft_showcase (instance_id);
ALTER TABLE public.farm_nft_showcase ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_nft_showcase_select" ON public.farm_nft_showcase;
CREATE POLICY "farm_nft_showcase_select" ON public.farm_nft_showcase FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_nft_showcase FROM anon, authenticated;
GRANT SELECT ON public.farm_nft_showcase TO authenticated;

CREATE OR REPLACE FUNCTION public.set_showcase_nft(p_instance_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_instance_id IS NULL THEN
    DELETE FROM public.farm_nft_showcase WHERE user_id = v_user;
    RETURN json_build_object('ok', true, 'cleared', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.farm_nft_instances WHERE id = p_instance_id AND owner_id = v_user) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  INSERT INTO public.farm_nft_showcase (user_id, instance_id) VALUES (v_user, p_instance_id)
  ON CONFLICT (user_id) DO UPDATE SET instance_id = EXCLUDED.instance_id, set_at = now();
  RETURN json_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_showcase_nft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_showcase_nft(uuid) TO authenticated;

-- Everyone's showcase with the card it points at, valid only while the shower
-- still owns it — one call for the Biuro list and the chat.
CREATE OR REPLACE VIEW public.farm_nft_showcase_cards WITH (security_invoker = true) AS
  SELECT s.user_id, i.id AS instance_id, i.species, i.serial_no, i.edition_size, i.nft_name, i.level,
         d.name, d.emoji, d.nft_collection
    FROM public.farm_nft_showcase s
    JOIN public.farm_nft_instances i ON i.id = s.instance_id AND i.owner_id = s.user_id
    JOIN public.farm_card_defs d ON d.species = i.species;
GRANT SELECT ON public.farm_nft_showcase_cards TO authenticated;


-- ══ 🔥 Ołtarz ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  ALTER TABLE public.farm_nft_transfers DROP CONSTRAINT IF EXISTS farm_nft_transfers_kind_check;
  ALTER TABLE public.farm_nft_transfers
    ADD CONSTRAINT farm_nft_transfers_kind_check
    CHECK (kind IN ('mint','sale','merge_fuel','merge_hero','breed_parent','altar'));
END $$;

-- Gold boxes for a sacrifice of net-worth `p_value`. Client mirror:
-- fnftAltarBoxes() in tabs/farm-nft.js.
CREATE OR REPLACE FUNCTION public.farm_altar_boxes(p_value integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(1, ceil(GREATEST(0, COALESCE(p_value, 0)) / 1000.0))::integer;
$$;

CREATE TABLE IF NOT EXISTS public.farm_nft_altar_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  species    text NOT NULL,
  serial_no  integer NOT NULL,
  nft_name   text,
  level      integer NOT NULL,
  value      integer NOT NULL,
  boxes      integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_nft_altar_log_created_idx ON public.farm_nft_altar_log (created_at DESC);
ALTER TABLE public.farm_nft_altar_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_nft_altar_log_select" ON public.farm_nft_altar_log;
CREATE POLICY "farm_nft_altar_log_select" ON public.farm_nft_altar_log FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_nft_altar_log FROM anon, authenticated;
GRANT SELECT ON public.farm_nft_altar_log TO authenticated;


-- ══ 🏛️ Wystawa ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.farm_nft_expo_entries (
  week_start  date NOT NULL,
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES public.farm_nft_instances(id) ON DELETE CASCADE,
  entered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_start, user_id)
);
CREATE TABLE IF NOT EXISTS public.farm_nft_expo_votes (
  week_start    date NOT NULL,
  voter_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  entry_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  voted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_start, voter_id)
);
CREATE TABLE IF NOT EXISTS public.farm_nft_expo_winners (
  week_start  date PRIMARY KEY,
  user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  instance_id uuid REFERENCES public.farm_nft_instances(id) ON DELETE SET NULL,
  species     text,
  serial_no   integer,
  nft_name    text,
  votes       integer NOT NULL DEFAULT 0,
  entries     integer NOT NULL DEFAULT 0,
  voters      integer NOT NULL DEFAULT 0,
  prize_boxes integer NOT NULL DEFAULT 0,
  settled_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.farm_nft_expo_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_nft_expo_votes   ENABLE ROW LEVEL SECURITY;   -- secret ballot: no policies, no grants
ALTER TABLE public.farm_nft_expo_winners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_nft_expo_entries_select" ON public.farm_nft_expo_entries;
CREATE POLICY "farm_nft_expo_entries_select" ON public.farm_nft_expo_entries FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "farm_nft_expo_winners_select" ON public.farm_nft_expo_winners;
CREATE POLICY "farm_nft_expo_winners_select" ON public.farm_nft_expo_winners FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_nft_expo_entries, public.farm_nft_expo_votes, public.farm_nft_expo_winners FROM anon, authenticated;
GRANT SELECT ON public.farm_nft_expo_entries, public.farm_nft_expo_winners TO authenticated;

-- Policy knobs. Client mirrors: FNFT_EXPO_* in tabs/farm-nft.js (display only).
CREATE OR REPLACE FUNCTION public.farm_expo_min_entries() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 2; $$;
CREATE OR REPLACE FUNCTION public.farm_expo_min_votes()   RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 3; $$;
CREATE OR REPLACE FUNCTION public.farm_expo_prize_boxes() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1; $$;

-- Settle every closed week that has entries and no winners row. Lazy-on-read,
-- date-driven and idempotent: the winners PK is the double-pay guard (the
-- prize is only granted when THIS call inserted the row). An entry only counts
-- while its card still belongs to the player who entered it.
CREATE OR REPLACE FUNCTION public.farm_expo_settle_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now   date := public.farm_current_series_monday();
  v_week  date;
  v_win   record;
  v_ent   integer;
  v_votes integer;
  v_prize integer;
  v_ins   integer;
  v_n     integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('farm_expo_settle'));
  FOR v_week IN
    SELECT DISTINCT e.week_start FROM public.farm_nft_expo_entries e
     WHERE e.week_start < v_now
       AND NOT EXISTS (SELECT 1 FROM public.farm_nft_expo_winners w WHERE w.week_start = e.week_start)
     ORDER BY 1
  LOOP
    SELECT count(*) INTO v_ent
      FROM public.farm_nft_expo_entries e
      JOIN public.farm_nft_instances i ON i.id = e.instance_id AND i.owner_id = e.user_id
     WHERE e.week_start = v_week;
    SELECT count(*) INTO v_votes
      FROM public.farm_nft_expo_votes v
      JOIN public.farm_nft_expo_entries e ON e.week_start = v.week_start AND e.user_id = v.entry_user_id
      JOIN public.farm_nft_instances i ON i.id = e.instance_id AND i.owner_id = e.user_id
     WHERE v.week_start = v_week;

    SELECT e.user_id, e.instance_id, i.species, i.serial_no, i.nft_name,
           (SELECT count(*) FROM public.farm_nft_expo_votes v
             WHERE v.week_start = v_week AND v.entry_user_id = e.user_id)::integer AS votes
      INTO v_win
      FROM public.farm_nft_expo_entries e
      JOIN public.farm_nft_instances i ON i.id = e.instance_id AND i.owner_id = e.user_id
     WHERE e.week_start = v_week
     ORDER BY 6 DESC, e.entered_at ASC
     LIMIT 1;

    v_prize := CASE WHEN v_win.user_id IS NOT NULL AND v_win.votes > 0
                      AND v_ent >= public.farm_expo_min_entries()
                      AND v_votes >= public.farm_expo_min_votes()
                    THEN public.farm_expo_prize_boxes() ELSE 0 END;

    INSERT INTO public.farm_nft_expo_winners
      (week_start, user_id, instance_id, species, serial_no, nft_name, votes, entries, voters, prize_boxes)
    VALUES
      (v_week, CASE WHEN v_prize > 0 THEN v_win.user_id END, CASE WHEN v_prize > 0 THEN v_win.instance_id END,
       CASE WHEN v_prize > 0 THEN v_win.species END, CASE WHEN v_prize > 0 THEN v_win.serial_no END,
       CASE WHEN v_prize > 0 THEN v_win.nft_name END, COALESCE(v_win.votes, 0), v_ent, v_votes, v_prize)
    ON CONFLICT (week_start) DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;

    IF v_ins = 1 AND v_prize > 0 THEN
      UPDATE public.farm_user_state SET boxes_gold = boxes_gold + v_prize WHERE user_id = v_win.user_id;
      IF NOT FOUND THEN
        INSERT INTO public.farm_user_state (user_id, boxes_gold) VALUES (v_win.user_id, v_prize)
        ON CONFLICT (user_id) DO UPDATE SET boxes_gold = farm_user_state.boxes_gold + v_prize;
      END IF;
    END IF;
    v_n := v_n + v_ins;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.farm_expo_settle_due() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.farm_expo_state()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_week date;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM public.farm_expo_settle_due();
  v_week := public.farm_current_series_monday();
  RETURN json_build_object(
    'week_start', v_week,
    'ends_at', ((v_week + 7)::timestamp AT TIME ZONE 'Europe/Warsaw'),
    'min_entries', public.farm_expo_min_entries(),
    'min_votes', public.farm_expo_min_votes(),
    'prize_boxes', public.farm_expo_prize_boxes(),
    'my_vote', (SELECT entry_user_id FROM public.farm_nft_expo_votes WHERE week_start = v_week AND voter_id = v_user),
    'voters', (SELECT count(*) FROM public.farm_nft_expo_votes WHERE week_start = v_week),
    'entries', COALESCE((
      SELECT json_agg(json_build_object(
        'user_id', e.user_id, 'nick', p.nick, 'instance_id', e.instance_id,
        'species', i.species, 'serial_no', i.serial_no, 'edition_size', i.edition_size,
        'nft_name', i.nft_name, 'level', i.level, 'name', d.name, 'emoji', d.emoji,
        'nft_collection', d.nft_collection, 'entered_at', e.entered_at,
        'votes', (SELECT count(*) FROM public.farm_nft_expo_votes v
                   WHERE v.week_start = v_week AND v.entry_user_id = e.user_id),
        'mine', e.user_id = v_user
      ) ORDER BY e.entered_at)
      FROM public.farm_nft_expo_entries e
      JOIN public.farm_nft_instances i ON i.id = e.instance_id AND i.owner_id = e.user_id
      JOIN public.farm_card_defs d ON d.species = i.species
      JOIN public.profiles p ON p.id = e.user_id
     WHERE e.week_start = v_week), '[]'::json),
    'winners', COALESCE((
      SELECT json_agg(x ORDER BY x.week_start DESC) FROM (
        SELECT w.week_start, w.votes, w.entries, w.voters, w.prize_boxes, w.serial_no, w.nft_name,
               w.instance_id, p.nick, d.name, d.emoji
          FROM public.farm_nft_expo_winners w
          LEFT JOIN public.profiles p ON p.id = w.user_id
          LEFT JOIN public.farm_card_defs d ON d.species = w.species
         ORDER BY w.week_start DESC LIMIT 8) x), '[]'::json)
  );
END $$;
REVOKE ALL ON FUNCTION public.farm_expo_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_expo_state() TO authenticated;

-- Enter (or swap) this week's card; NULL withdraws. Swapping keeps the original
-- entered_at — it is the tiebreak, and changing your card shouldn't reset it.
CREATE OR REPLACE FUNCTION public.farm_expo_enter(p_instance_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_week date := public.farm_current_series_monday();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM public.farm_expo_settle_due();
  IF p_instance_id IS NULL THEN
    DELETE FROM public.farm_nft_expo_entries WHERE week_start = v_week AND user_id = v_user;
    RETURN json_build_object('ok', true, 'withdrawn', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.farm_nft_instances WHERE id = p_instance_id AND owner_id = v_user) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  INSERT INTO public.farm_nft_expo_entries (week_start, user_id, instance_id)
  VALUES (v_week, v_user, p_instance_id)
  ON CONFLICT (week_start, user_id) DO UPDATE SET instance_id = EXCLUDED.instance_id;
  RETURN json_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.farm_expo_enter(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_expo_enter(uuid) TO authenticated;

-- One vote per player per week, changeable; NULL takes it back.
CREATE OR REPLACE FUNCTION public.farm_expo_vote(p_entry_user uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_week date := public.farm_current_series_monday();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM public.farm_expo_settle_due();
  IF p_entry_user IS NULL THEN
    DELETE FROM public.farm_nft_expo_votes WHERE week_start = v_week AND voter_id = v_user;
    RETURN json_build_object('ok', true, 'withdrawn', true);
  END IF;
  IF p_entry_user = v_user THEN RAISE EXCEPTION 'own_entry'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.farm_nft_expo_entries WHERE week_start = v_week AND user_id = p_entry_user) THEN
    RAISE EXCEPTION 'no_entry';
  END IF;
  INSERT INTO public.farm_nft_expo_votes (week_start, voter_id, entry_user_id)
  VALUES (v_week, v_user, p_entry_user)
  ON CONFLICT (week_start, voter_id) DO UPDATE SET entry_user_id = EXCLUDED.entry_user_id, voted_at = now();
  RETURN json_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.farm_expo_vote(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_expo_vote(uuid) TO authenticated;


-- ══ 🔥 Ołtarz: the sacrifice ════════════════════════════════════════════════
-- Owned, not listed, not planted, not on this week's Wystawa. Records the burn
-- in farm_nft_transfers (kind 'altar', price = boxes granted) before deleting,
-- so the edition explorer can show 🕯️ for that serial.
CREATE OR REPLACE FUNCTION public.sacrifice_nft(p_instance_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_inst  public.farm_nft_instances%ROWTYPE;
  v_value integer;
  v_boxes integer;
  v_gold  integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_inst FROM public.farm_nft_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'nft_not_found'; END IF;
  IF v_inst.owner_id <> v_user THEN RAISE EXCEPTION 'not_owner'; END IF;
  IF v_inst.listed THEN RAISE EXCEPTION 'already_listed'; END IF;
  IF EXISTS (SELECT 1 FROM public.farm_tiles WHERE planted_instance_id = v_inst.id) THEN
    RAISE EXCEPTION 'nft_planted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.farm_nft_expo_entries
              WHERE week_start = public.farm_current_series_monday() AND instance_id = v_inst.id) THEN
    RAISE EXCEPTION 'nft_on_expo';
  END IF;

  v_value := COALESCE(round(v_inst.stat_value * v_inst.level),
                      round(20000.0 / v_inst.edition_size * v_inst.level))::integer;
  v_boxes := public.farm_altar_boxes(v_value);

  INSERT INTO public.farm_nft_transfers (instance_id, species, serial_no, from_owner, to_owner, price, kind)
  VALUES (v_inst.id, v_inst.species, v_inst.serial_no, v_user, NULL, v_boxes, 'altar');
  DELETE FROM public.farm_nft_showcase WHERE instance_id = v_inst.id;
  DELETE FROM public.farm_nft_instances WHERE id = v_inst.id;

  UPDATE public.farm_user_state SET boxes_gold = boxes_gold + v_boxes
   WHERE user_id = v_user RETURNING boxes_gold INTO v_gold;
  IF NOT FOUND THEN
    INSERT INTO public.farm_user_state (user_id, boxes_gold) VALUES (v_user, v_boxes)
    ON CONFLICT (user_id) DO UPDATE SET boxes_gold = farm_user_state.boxes_gold + v_boxes
    RETURNING boxes_gold INTO v_gold;
  END IF;

  INSERT INTO public.farm_nft_altar_log (user_id, species, serial_no, nft_name, level, value, boxes)
  VALUES (v_user, v_inst.species, v_inst.serial_no, v_inst.nft_name, v_inst.level, v_value, v_boxes);

  RETURN json_build_object('ok', true, 'boxes', v_boxes, 'value', v_value, 'boxes_gold', v_gold);
END $$;
REVOKE ALL ON FUNCTION public.sacrifice_nft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sacrifice_nft(uuid) TO authenticated;
