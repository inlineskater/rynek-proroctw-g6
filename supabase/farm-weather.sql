-- ════════════════════════════════════════════════════════════════════════════
--  „Pogoda z Wrocławia" — real weather drives crop yield  (2026-09-28)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm-achievements.sql. Idempotent.
--  ⚠️ Supersedes harvest_crop() from farm-achievements.sql — re-run this after
--     re-running that (or anything that re-creates harvest_crop).
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  The garden sky has shown the real Wrocław weather since the zen-garden days
--  (fetchWroclawWeather() in index.html, Open-Meteo), but it was pure scenery.
--  Here it becomes the growing conditions: every crop likes some weather and
--  dislikes other, and a harvest yields its crop's AVERAGE multiplier over the
--  real hours it spent in the ground. Seasons fall out of it for free — a grey
--  Wrocław autumn favours carrots and potatoes, July favours grapes and chili —
--  so the best crop keeps changing without anyone scheduling it, which is what
--  the monoculture measured on 2026-09-28 (every plot on the contract crop)
--  needed.
--
--  ── Trust ──────────────────────────────────────────────────────────────────
--  The browser never reports the weather. The database fetches Open-Meteo
--  itself (pg_net, the same extension football.sql uses) on a pg_cron schedule
--  and keeps an hourly log, farm_weather_hours. harvest_crop() reads only that
--  log. An hour missing from the log counts as neutral (1.0) — an ingest outage
--  drifts yields toward normal, never toward a bonus.
--
--  ── Why it does not reopen the open loop (docs/anti-inflation.md) ─────────
--  Weather changes crop QUANTITY only. Quantity is already priced by the demand
--  throttle (above pressure 1, revenue is asymptotically constant in quantity),
--  and the multiplier is clamped to [farm_weather_bounds()]. Good weather for
--  one crop is a reason to plant it, not a new faucet.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;


-- ── Policy knobs ───────────────────────────────────────────────────────────
-- Clamp on a harvest's averaged multiplier.
CREATE OR REPLACE FUNCTION public.farm_weather_bounds()
RETURNS TABLE (lo numeric, hi numeric)
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.75::numeric, 1.35::numeric $fn$;

-- Temperature overrides: a clear/cloudy/fog hour this hot counts as „upał",
-- one this cold as „przymrozek". Rain, snow and storms keep their own category.
CREATE OR REPLACE FUNCTION public.farm_weather_hot_c()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 27::numeric $fn$;
CREATE OR REPLACE FUNCTION public.farm_weather_frost_c()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0::numeric $fn$;

-- Wrocław, the same point the garden sky uses.
CREATE OR REPLACE FUNCTION public.farm_weather_url()
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 'https://api.open-meteo.com/v1/forecast?latitude=51.11&longitude=17.03'
      || '&hourly=weather_code,temperature_2m,precipitation'
      || '&past_days=3&forecast_days=3&timezone=UTC&timeformat=unixtime'
$fn$;


-- ── Category: WMO code + temperature → one of 8 growing conditions ────────
-- The WMO buckets mirror wmoCategory() in index.html so the sky and the farm
-- never disagree about whether it is raining.
CREATE OR REPLACE FUNCTION public.farm_weather_category(p_code integer, p_temp numeric)
RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  WITH w AS (
    SELECT CASE
      WHEN p_code IS NULL OR p_code <= 1 THEN 'clear'
      WHEN p_code <= 3 THEN 'cloudy'
      WHEN p_code IN (45, 48) THEN 'fog'
      WHEN p_code >= 95 THEN 'thunder'
      WHEN (p_code BETWEEN 71 AND 77) OR p_code IN (85, 86) THEN 'snow'
      WHEN (p_code BETWEEN 51 AND 67) OR (p_code BETWEEN 80 AND 82) THEN 'rain'
      ELSE 'cloudy' END AS cat
  )
  SELECT CASE
    WHEN w.cat IN ('clear','cloudy','fog') AND p_temp >= public.farm_weather_hot_c()   THEN 'hot'
    WHEN w.cat IN ('clear','cloudy','fog') AND p_temp <= public.farm_weather_frost_c() THEN 'frost'
    ELSE w.cat END
  FROM w;
$fn$;


-- ── Crop affinities: data, not code, so the UI reads the same table ────────
-- Anything not listed is neutral (1.0). Every base crop has at least one kind
-- of weather it loves and one it hates; the legendary NFT crops each get one
-- signature weather, so an idle trophy has a week when it is worth planting.
CREATE TABLE IF NOT EXISTS public.farm_weather_affinity (
  crop_type text NOT NULL,
  category  text NOT NULL CHECK (category IN ('clear','cloudy','fog','rain','snow','thunder','hot','frost')),
  mult      numeric NOT NULL CHECK (mult > 0),
  PRIMARY KEY (crop_type, category)
);
ALTER TABLE public.farm_weather_affinity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_weather_affinity_select" ON public.farm_weather_affinity;
CREATE POLICY "farm_weather_affinity_select" ON public.farm_weather_affinity FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_weather_affinity FROM anon, authenticated;
GRANT SELECT ON public.farm_weather_affinity TO authenticated;

DELETE FROM public.farm_weather_affinity;
INSERT INTO public.farm_weather_affinity (crop_type, category, mult) VALUES
  -- roots & autumn crops: a grey, wet Wrocław is their season
  ('carrot','rain',1.35), ('carrot','cloudy',1.20), ('carrot','hot',0.75),
  ('potato','rain',1.35), ('potato','fog',1.20), ('potato','cloudy',1.15), ('potato','hot',0.75),
  ('pumpkin','rain',1.20), ('pumpkin','cloudy',1.20), ('pumpkin','frost',0.75),
  -- sun crops: summer
  ('tomato','clear',1.35), ('tomato','hot',1.35), ('tomato','rain',0.90), ('tomato','frost',0.75),
  ('corn','clear',1.35), ('corn','hot',1.20), ('corn','frost',0.75),
  ('chili','hot',1.35), ('chili','clear',1.20), ('chili','rain',0.75), ('chili','frost',0.75),
  ('grapes','clear',1.35), ('grapes','hot',1.35), ('grapes','rain',0.75),
  ('pineapple','hot',1.35), ('pineapple','clear',1.20), ('pineapple','frost',0.75), ('pineapple','snow',0.75),
  -- in between
  ('strawberry','clear',1.20), ('strawberry','rain',1.20), ('strawberry','thunder',0.75), ('strawberry','frost',0.75),
  -- NFT crops: one signature weather each
  ('seasonal_bloom','fog',1.25), ('seasonal_bloom','cloudy',1.10), ('seasonal_bloom','thunder',0.80),
  ('golden_sunflower','clear',1.30),
  ('crystal_lotus','rain',1.30),
  ('diamond_rose','fog',1.30),
  ('aeae_banana','hot',1.30), ('aeae_banana','frost',0.80);

CREATE OR REPLACE FUNCTION public.farm_weather_mult(p_crop_type text, p_category text)
RETURNS numeric
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE((SELECT mult FROM public.farm_weather_affinity
                    WHERE crop_type = p_crop_type AND category = p_category), 1.0);
$fn$;


-- ── The hourly log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.farm_weather_hours (
  hour        timestamptz PRIMARY KEY,     -- start of the UTC hour
  code        integer,
  temp_c      numeric,
  precip_mm   numeric,
  category    text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.farm_weather_hours ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_weather_hours_select" ON public.farm_weather_hours;
CREATE POLICY "farm_weather_hours_select" ON public.farm_weather_hours FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_weather_hours FROM anon, authenticated;
GRANT SELECT ON public.farm_weather_hours TO authenticated;

-- pg_net is asynchronous: http_get() only queues the request, the response
-- lands in net._http_response later. So each tick first COLLECTS whatever
-- earlier requests have come back, then queues the next one.
CREATE TABLE IF NOT EXISTS public.farm_weather_requests (
  request_id   bigint PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  hours        integer,
  error        text
);
ALTER TABLE public.farm_weather_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.farm_weather_requests FROM anon, authenticated;


CREATE OR REPLACE FUNCTION public.farm_weather_collect()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r      record;
  v_resp record;
  v_j    jsonb;
  v_n    integer;
  v_tot  integer := 0;
BEGIN
  FOR r IN SELECT * FROM public.farm_weather_requests
            WHERE processed_at IS NULL ORDER BY request_id
            FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_resp FROM net._http_response WHERE id = r.request_id;
    IF NOT FOUND THEN
      -- pg_net keeps responses for a few hours; a request that never came back
      -- is written off rather than retried forever.
      IF r.requested_at < now() - interval '6 hours' THEN
        UPDATE public.farm_weather_requests SET processed_at = now(), error = 'no_response'
         WHERE request_id = r.request_id;
      END IF;
      CONTINUE;
    END IF;

    IF v_resp.status_code IS DISTINCT FROM 200 OR v_resp.content IS NULL THEN
      UPDATE public.farm_weather_requests
         SET processed_at = now(), error = COALESCE(v_resp.error_msg, 'http ' || v_resp.status_code)
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    BEGIN
      v_j := v_resp.content::jsonb -> 'hourly';
      INSERT INTO public.farm_weather_hours (hour, code, temp_c, precip_mm, category, fetched_at)
      SELECT to_timestamp((v_j->'time'->>i)::bigint),
             (v_j->'weather_code'->>i)::integer,
             (v_j->'temperature_2m'->>i)::numeric,
             (v_j->'precipitation'->>i)::numeric,
             public.farm_weather_category((v_j->'weather_code'->>i)::integer,
                                          (v_j->'temperature_2m'->>i)::numeric),
             now()
        FROM generate_series(0, jsonb_array_length(v_j->'time') - 1) AS i
       WHERE v_j->'weather_code'->>i IS NOT NULL
      ON CONFLICT (hour) DO UPDATE
        SET code = EXCLUDED.code, temp_c = EXCLUDED.temp_c, precip_mm = EXCLUDED.precip_mm,
            category = EXCLUDED.category, fetched_at = EXCLUDED.fetched_at;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      UPDATE public.farm_weather_requests SET processed_at = now(), hours = v_n
       WHERE request_id = r.request_id;
      v_tot := v_tot + v_n;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.farm_weather_requests SET processed_at = now(), error = left(SQLERRM, 300)
       WHERE request_id = r.request_id;
    END;
  END LOOP;
  RETURN v_tot;
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_weather_collect() FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.farm_weather_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id bigint;
BEGIN
  PERFORM public.farm_weather_collect();
  -- Don't stack requests if the last one is still in flight.
  IF EXISTS (SELECT 1 FROM public.farm_weather_requests
              WHERE processed_at IS NULL AND requested_at > now() - interval '20 minutes') THEN
    RETURN;
  END IF;
  SELECT net.http_get(url := public.farm_weather_url(), timeout_milliseconds := 15000) INTO v_id;
  INSERT INTO public.farm_weather_requests (request_id) VALUES (v_id) ON CONFLICT DO NOTHING;
  DELETE FROM public.farm_weather_requests WHERE requested_at < now() - interval '14 days';
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_weather_tick() FROM PUBLIC, anon, authenticated;

-- Twice an hour, clear of every other farm job (:00 roll, :10 tax, :25 awards,
-- :35 bank). Each run collects the previous run's response and queues a new one.
DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'farm_weather_tick';
  PERFORM cron.schedule('farm_weather_tick', '7,37 * * * *', 'SELECT public.farm_weather_tick()');
END
$cron$;


-- ── The multiplier a crop earns over a growing window ─────────────────────
-- Mean of the per-hour affinity over every whole hour in [p_from, p_to), with
-- hours absent from the log counting as 1.0, clamped to farm_weather_bounds().
CREATE OR REPLACE FUNCTION public.farm_weather_yield_mult(p_crop_type text, p_from timestamptz, p_to timestamptz)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH win AS (
    SELECT date_trunc('hour', p_from) AS a,
           GREATEST(date_trunc('hour', p_from) + interval '1 hour', date_trunc('hour', p_to)) AS b
  ),
  n AS (SELECT GREATEST(1, round(EXTRACT(EPOCH FROM (b - a)) / 3600.0))::numeric AS hours FROM win),
  logged AS (
    SELECT count(*)::numeric AS cnt, COALESCE(sum(public.farm_weather_mult(p_crop_type, h.category)), 0) AS s
      FROM public.farm_weather_hours h, win
     WHERE h.hour >= win.a AND h.hour < win.b AND h.hour < now()
  ),
  b AS (SELECT * FROM public.farm_weather_bounds())
  SELECT round(LEAST(b.hi, GREATEST(b.lo, (logged.s + (n.hours - logged.cnt)) / n.hours)), 4)
    FROM n, logged, b;
$fn$;

REVOKE ALL ON FUNCTION public.farm_weather_yield_mult(text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_weather_yield_mult(text, timestamptz, timestamptz) TO authenticated;


-- ── Harvest yield hook ─────────────────────────────────────────────────────
-- Everything after the card/instance core: land bonus × weather. Kept as its
-- own function so the next layer (farm-neighbours.sql: combos, NFT talents,
-- watering, theft) extends THIS instead of transcribing harvest_crop again.
CREATE OR REPLACE FUNCTION public.farm_harvest_yield(p_tile public.farm_tiles, p_user uuid, p_core numeric, p_crop_type text)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_weather numeric := public.farm_weather_yield_mult(p_crop_type, p_tile.planted_at, p_tile.ready_at);
BEGIN
  RETURN json_build_object(
    'yield', round(p_core * (1 + public.farm_yield_bonus(p_user)) * v_weather)::integer,
    'weather_mult', v_weather);
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_harvest_yield(public.farm_tiles, uuid, numeric, text) FROM PUBLIC, anon, authenticated;


-- ── harvest_crop: verbatim farm-achievements.sql version, yield via the hook ─
CREATE OR REPLACE FUNCTION public.harvest_crop(p_x integer, p_y integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_tile  public.farm_tiles%ROWTYPE;
  v_def   public.farm_card_defs%ROWTYPE;
  v_yield integer;
  v_exp   timestamptz;
  v_qty   integer;
  v_inst_yield integer;
  v_calc  json;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tile_not_owned'; END IF;
  IF v_tile.owner_id <> v_user THEN RAISE EXCEPTION 'not_your_tile'; END IF;
  IF v_tile.planted_species IS NULL THEN RAISE EXCEPTION 'tile_empty'; END IF;
  IF v_tile.ready_at IS NULL OR now() < v_tile.ready_at THEN RAISE EXCEPTION 'not_ready'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_tile.planted_species;
  IF NOT FOUND THEN RAISE EXCEPTION 'bad_species'; END IF;

  -- Bred hybrids carry their own synergy yield (farm_nft_instances.stat_yield).
  IF v_tile.planted_instance_id IS NOT NULL THEN
    SELECT stat_yield INTO v_inst_yield
      FROM public.farm_nft_instances WHERE id = v_tile.planted_instance_id;
  END IF;

  -- Level scales yield (+50%/level); the hook adds „Potentat Ziemski" and the
  -- real Wrocław weather over this crop's growing window.
  v_calc := public.farm_harvest_yield(v_tile, v_user,
              COALESCE(v_inst_yield, v_def.base_yield) * (1 + (v_tile.planted_level - 1) * 0.5),
              v_def.crop_type);
  v_yield := GREATEST(0, (v_calc->>'yield')::integer);
  v_exp   := now() + interval '5 days';

  IF v_yield > 0 THEN
    INSERT INTO public.farm_inventory (user_id, crop_type, qty, harvested_at, expires_at)
    VALUES (v_user, v_def.crop_type, v_yield, now(), v_exp);
  END IF;

  SELECT COALESCE(sum(qty), 0) INTO v_qty FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = v_def.crop_type AND expires_at > now();

  UPDATE public.farm_tiles
     SET planted_species = NULL, planted_level = NULL, planted_at = NULL, ready_at = NULL,
         planted_instance_id = NULL   -- free the NFT instance so it can merge/list/replant
   WHERE x = p_x AND y = p_y;

  RETURN json_build_object('ok', true, 'x', p_x, 'y', p_y, 'crop_type', v_def.crop_type,
    'harvested', v_yield, 'inventory_qty', v_qty, 'expires_at', v_exp,
    'weather_mult', (v_calc->>'weather_mult')::numeric, 'calc', v_calc);
END;
$$;
REVOKE ALL ON FUNCTION public.harvest_crop(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.harvest_crop(integer, integer) TO authenticated;


-- ── Read: what the UI needs ────────────────────────────────────────────────
-- Also collects any pending Open-Meteo response on the way, so the first
-- visitor after a response lands sees it without waiting for the next tick.
CREATE OR REPLACE FUNCTION public.farm_weather_state()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.farm_weather_collect();
  RETURN json_build_object(
    'now', now(),
    'current', (SELECT row_to_json(c) FROM (
        SELECT hour, code, temp_c, precip_mm, category FROM public.farm_weather_hours
         WHERE hour <= now() ORDER BY hour DESC LIMIT 1) c),
    'hours', COALESCE((SELECT json_agg(json_build_object('h', hour, 'c', category, 't', round(temp_c, 1)) ORDER BY hour)
                         FROM public.farm_weather_hours
                        WHERE hour > now() - interval '6 days' AND hour < now() + interval '3 days'), '[]'::json),
    'affinity', COALESCE((SELECT json_agg(json_build_object('crop_type', crop_type, 'category', category, 'mult', mult))
                            FROM public.farm_weather_affinity), '[]'::json),
    'bounds', (SELECT row_to_json(b) FROM public.farm_weather_bounds() b),
    'last_fetch', (SELECT max(fetched_at) FROM public.farm_weather_hours)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_weather_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_weather_state() TO authenticated;

-- Kick the first fetch at install time instead of waiting for :07/:37.
SELECT public.farm_weather_tick();
