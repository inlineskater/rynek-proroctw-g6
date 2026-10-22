-- ════════════════════════════════════════════════════════════════════════════
--  🌪️ Random farm events  (2026-10-23)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm-neighbours.sql (farm_is_protected) and chat.sql. Idempotent.
--  Supersedes nothing.
--
--  Owner's brief: random, "not every day and not rare", epic and impactful,
--  animated on the board, and announced in the office chat.
--
--  ── Rhythm ─────────────────────────────────────────────────────────────────
--  Once a Warsaw day farm_world_event_plan() rolls whether today gets an event:
--  probability farm_world_event_daily_p() (0.45), never two days in a row →
--  ~2.3 a week. It then picks a random minute between 09:00 and 18:00 Warsaw so
--  people are at their desks to see it, and the kind by weight. The plan sits
--  in farm_world_event_plan (no client grants — nobody can peek at tomorrow's
--  fire). A 5-minute cron fires due plans.
--
--  ── What an event does ─────────────────────────────────────────────────────
--  Events move ready_at of GROWING plots (planted, not ripe yet). That is
--  visible the instant it happens (every timer on the board jumps — farm_tiles
--  is realtime) and needs no change to harvest_crop or the yield hook. Ripe and
--  empty plots are untouched, so nothing already earned is ever destroyed.
--    🔥 pozar      bad   fire spreads from a random plot: every growing plot
--                        within 2 steps loses half its grow time (≤ 24 h)
--    🌪️ tornado    bad   sweeps two adjacent columns: +8 h on every growing
--                        plot in its path
--    🦗 szarancza  bad   a locust swarm: +6 h on every growing plot whose owner
--                        has no scarecrow (the scarecrow finally matters)
--    ⚡ burza      good  lightning strikes up to 5 random growing plots: ripe NOW
--    🌧️ zloty_deszcz good golden rain: every growing plot's remaining time halved
--    🐝 roj        good  bees pollinate ~40% of growing plots: −8 h each
--  Good and bad are weighted 50/50. Growth only changes WHEN a crop arrives;
--  revenue still runs through the demand-throttled NPC budget, so events
--  redistribute timing and luck, they do not mint (docs/anti-inflation.md).
--
--  ── Announcing ─────────────────────────────────────────────────────────────
--  A fired event is one row in farm_world_events (public SELECT, realtime): the
--  client plays the full-screen animation for anyone on the farm and shows an
--  aftermath banner with a replay for 3 h. The chat gets one message from
--  „🌾 Ogródek" (sent as the admin profile) naming who was hit or helped.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Policy ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_world_event_daily_p()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $c$ SELECT 0.45::numeric $c$;

CREATE OR REPLACE FUNCTION public.farm_world_event_kinds()
RETURNS TABLE (kind text, weight integer, good boolean, emoji text, title text)
LANGUAGE sql IMMUTABLE AS $c$
  VALUES ('pozar',        17, false, '🔥',  'Pożar na farmie!'),
         ('tornado',      17, false, '🌪️', 'Tornado nad Ogródkiem!'),
         ('szarancza',    16, false, '🦗',  'Nalot szarańczy!'),
         ('burza',        16, true,  '⚡',  'Burza z piorunami!'),
         ('zloty_deszcz', 17, true,  '🌧️', 'Złoty deszcz!'),
         ('roj',          17, true,  '🐝',  'Rój pszczół!')
$c$;

-- ── Tables ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.farm_world_event_plan (
  plan_date date PRIMARY KEY,               -- Warsaw date
  kind      text,                           -- NULL = no event today
  fire_at   timestamptz,
  fired     boolean NOT NULL DEFAULT false
);
ALTER TABLE public.farm_world_event_plan ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.farm_world_event_plan FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.farm_world_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  good       boolean NOT NULL,
  title      text NOT NULL,
  fired_at   timestamptz NOT NULL DEFAULT now(),
  -- [{x, y, owner_id, nick, delta_min}] — delta_min < 0 = sooner, > 0 = later
  plots      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- per-player summary for the banner: [{nick, plots, delta_min}]
  players    jsonb NOT NULL DEFAULT '[]'::jsonb,
  origin     jsonb,                          -- {x,y} for fire, {x0,x1} for tornado
  message    text
);
CREATE INDEX IF NOT EXISTS farm_world_events_recent_idx ON public.farm_world_events (fired_at DESC);

ALTER TABLE public.farm_world_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_world_events_select" ON public.farm_world_events;
CREATE POLICY "farm_world_events_select" ON public.farm_world_events
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_world_events FROM anon, authenticated;
GRANT SELECT ON public.farm_world_events TO authenticated;

DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_world_events;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;


-- ── Plan today (idempotent per Warsaw date) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_world_event_plan_today()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_kind  text;
  v_min   integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.farm_world_event_plan WHERE plan_date = v_today) THEN RETURN; END IF;

  -- Never two days in a row: an event yesterday means a quiet day today.
  IF EXISTS (SELECT 1 FROM public.farm_world_event_plan
              WHERE plan_date = v_today - 1 AND kind IS NOT NULL)
     OR random() >= public.farm_world_event_daily_p() THEN
    INSERT INTO public.farm_world_event_plan (plan_date) VALUES (v_today) ON CONFLICT DO NOTHING;
    RETURN;
  END IF;

  SELECT k.kind INTO v_kind FROM (
    SELECT kind, sum(weight) OVER (ORDER BY kind) AS cum, sum(weight) OVER () AS tot
      FROM public.farm_world_event_kinds()) k
   WHERE k.cum > (SELECT random() * sum(weight) FROM public.farm_world_event_kinds())
   ORDER BY k.cum LIMIT 1;

  v_min := 9 * 60 + floor(random() * 9 * 60)::integer;      -- 09:00–17:59 Warsaw
  INSERT INTO public.farm_world_event_plan (plan_date, kind, fire_at)
  VALUES (v_today, v_kind,
          (v_today::timestamp + make_interval(mins => v_min)) AT TIME ZONE 'Europe/Warsaw')
  ON CONFLICT DO NOTHING;
END;
$fn$;


-- „1 grządkę / 2 grządki / 5 grządek" — accusative, every message verb takes it.
CREATE OR REPLACE FUNCTION public.farm_pl_grzadki(n integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $c$
  SELECT n || ' ' || CASE
    WHEN n = 1 THEN 'grządkę'
    WHEN n % 10 BETWEEN 2 AND 4 AND n % 100 NOT BETWEEN 12 AND 14 THEN 'grządki'
    ELSE 'grządek' END
$c$;

-- ── Fire one event now (also the admin/test entry point, service-only) ─────
CREATE OR REPLACE FUNCTION public.farm_world_event_fire(p_kind text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  k        record;
  v_plots  jsonb := '[]'::jsonb;
  v_origin jsonb;
  v_x0     integer;
  v_ox     integer;
  v_oy     integer;
  v_players jsonb;
  v_msg    text;
  v_admin  uuid;
  v_id     uuid;
  v_names  text;
BEGIN
  SELECT * INTO k FROM public.farm_world_event_kinds() WHERE kind = p_kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_kind'; END IF;

  -- The candidate set: growing plots only. Locked so a concurrent harvest or
  -- plant cannot interleave with the timer change.
  CREATE TEMP TABLE IF NOT EXISTS _fwe_g (x int, y int, owner_id uuid, planted_at timestamptz,
                                          ready_at timestamptz, delta_min int) ON COMMIT DROP;
  TRUNCATE _fwe_g;
  INSERT INTO _fwe_g (x, y, owner_id, planted_at, ready_at)
  SELECT t.x, t.y, t.owner_id, t.planted_at, t.ready_at
    FROM public.farm_tiles t
   WHERE t.planted_species IS NOT NULL AND t.ready_at > now()
     AND t.acquired_via IS DISTINCT FROM 'migration'
   FOR UPDATE;

  IF p_kind = 'pozar' THEN
    SELECT x, y INTO v_ox, v_oy FROM _fwe_g ORDER BY random() LIMIT 1;
    v_origin := jsonb_build_object('x', v_ox, 'y', v_oy);
    UPDATE _fwe_g SET delta_min = LEAST(24 * 60,
             ceil(EXTRACT(EPOCH FROM (ready_at - planted_at)) / 60 / 2))::int
     WHERE abs(x - v_ox) + abs(y - v_oy) <= 2;
  ELSIF p_kind = 'tornado' THEN
    SELECT x INTO v_x0 FROM _fwe_g ORDER BY random() LIMIT 1;
    v_origin := jsonb_build_object('x0', v_x0, 'x1', v_x0 + 1);
    UPDATE _fwe_g SET delta_min = 8 * 60 WHERE x IN (v_x0, v_x0 + 1);
  ELSIF p_kind = 'szarancza' THEN
    UPDATE _fwe_g SET delta_min = 6 * 60 WHERE NOT public.farm_is_protected(owner_id);
  ELSIF p_kind = 'burza' THEN
    UPDATE _fwe_g g SET delta_min = -ceil(EXTRACT(EPOCH FROM (g.ready_at - now())) / 60)::int
     WHERE (g.x, g.y) IN (SELECT x, y FROM _fwe_g ORDER BY random() LIMIT 5);
  ELSIF p_kind = 'zloty_deszcz' THEN
    UPDATE _fwe_g SET delta_min = -floor(EXTRACT(EPOCH FROM (ready_at - now())) / 60 / 2)::int;
  ELSIF p_kind = 'roj' THEN
    UPDATE _fwe_g SET delta_min = -LEAST(8 * 60, floor(EXTRACT(EPOCH FROM (ready_at - now())) / 60))::int
     WHERE random() < 0.40;
  END IF;

  DELETE FROM _fwe_g WHERE delta_min IS NULL OR delta_min = 0;

  UPDATE public.farm_tiles t
     SET ready_at = GREATEST(now(), t.ready_at + make_interval(mins => g.delta_min))
    FROM _fwe_g g
   WHERE t.x = g.x AND t.y = g.y;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('x', g.x, 'y', g.y, 'owner_id', g.owner_id,
                                               'nick', p.nick, 'delta_min', g.delta_min)
                            ORDER BY g.x, g.y), '[]'::jsonb)
    INTO v_plots
    FROM _fwe_g g JOIN public.profiles p ON p.id = g.owner_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('nick', nick, 'plots', n, 'delta_min', d)
                            ORDER BY n DESC, nick), '[]'::jsonb),
         string_agg(nick || ' (' || n || ')', ', ' ORDER BY n DESC, nick)
    INTO v_players, v_names
    FROM (SELECT p.nick, count(*) AS n, sum(g.delta_min) AS d
            FROM _fwe_g g JOIN public.profiles p ON p.id = g.owner_id
           GROUP BY p.nick) s;

  v_msg := k.emoji || ' ' || upper(k.title) || ' ' || CASE p_kind
    WHEN 'pozar'        THEN 'Ogień strawił ' || public.farm_pl_grzadki(jsonb_array_length(v_plots)) || ' — rośliny cofnęły się o połowę wzrostu.'
    WHEN 'tornado'      THEN 'Trąba powietrzna przeszła przez ' || public.farm_pl_grzadki(jsonb_array_length(v_plots)) || ' — +8 h do zbioru.'
    WHEN 'szarancza'    THEN 'Szarańcza obsiadła ' || public.farm_pl_grzadki(jsonb_array_length(v_plots)) || ' bez stracha na wróble — +6 h do zbioru.'
    WHEN 'burza'        THEN 'Pioruny trafiły w ' || public.farm_pl_grzadki(jsonb_array_length(v_plots)) || ' — dojrzały od razu!'
    WHEN 'zloty_deszcz' THEN 'Złoty deszcz podlał ' || public.farm_pl_grzadki(jsonb_array_length(v_plots)) || ' — czas do zbioru o połowę krótszy!'
    WHEN 'roj'          THEN 'Pszczoły zapyliły ' || public.farm_pl_grzadki(jsonb_array_length(v_plots)) || ' — −8 h do zbioru!'
  END
  || CASE WHEN v_names IS NOT NULL
          THEN (CASE WHEN k.good THEN ' Szczęściarze: ' ELSE ' Poszkodowani: ' END) || v_names || '.'
          ELSE ' Na szczęście nic nie rosło.' END;

  INSERT INTO public.farm_world_events (kind, good, title, plots, players, origin, message)
  VALUES (p_kind, k.good, k.title, v_plots, v_players, v_origin, v_msg)
  RETURNING id INTO v_id;

  SELECT id INTO v_admin FROM public.profiles WHERE is_admin ORDER BY created_at LIMIT 1;
  IF v_admin IS NOT NULL THEN
    INSERT INTO public.chat_messages (sender_id, recipient_id, sender_nick, body)
    VALUES (v_admin, NULL, '🌾 Ogródek', left(v_msg, 1000));
  END IF;

  RETURN json_build_object('ok', true, 'id', v_id, 'kind', p_kind,
                           'plots', jsonb_array_length(v_plots), 'message', v_msg);
END;
$fn$;


-- ── Cron entry: plan today, fire what is due ───────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_world_event_tick()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r     record;
  v_out json := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('farm_world_event_tick')) THEN
    RETURN json_build_object('ok', true, 'skipped', 'busy');
  END IF;
  PERFORM public.farm_world_event_plan_today();
  FOR r IN SELECT * FROM public.farm_world_event_plan
            WHERE kind IS NOT NULL AND NOT fired AND fire_at <= now()
              AND fire_at > now() - interval '6 hours'      -- a missed one is dropped, not fired at night
            FOR UPDATE
  LOOP
    v_out := public.farm_world_event_fire(r.kind);
    UPDATE public.farm_world_event_plan SET fired = true WHERE plan_date = r.plan_date;
  END LOOP;
  RETURN COALESCE(v_out, json_build_object('ok', true, 'fired', false));
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_world_event_plan_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_world_event_fire(text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_world_event_tick()       FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('farm_world_events', '*/5 * * * *',
                          $cron$SELECT public.farm_world_event_tick();$cron$);
  END IF;
END $$;
