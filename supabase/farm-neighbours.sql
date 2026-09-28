-- ════════════════════════════════════════════════════════════════════════════
--  „Sąsiedzi" — combos, NFT talents, watering, theft, the scarecrow  (2026-09-28)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm-weather.sql. Idempotent.
--  ⚠️ Redefines farm_harvest_yield() from farm-weather.sql — re-run this after
--     re-running that.
--  ⚠️ office-goals.sql's farm_burn_per_day() and economy-stats.sql list
--     'farm_scarecrow_buy' (in the repo) — re-run both alongside.
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  Measured on prod 2026-09-28: the office farm was eight solitaire games on
--  one board. Nothing one player did touched another, and nothing rewarded
--  growing more than one crop. This layer adds both:
--
--   * COMBOS on YOUR OWN plots (not the drawn grid: the board is stored 13x4
--     but drawn 8 or 7 columns wide, so "adjacent" would differ per device).
--     A handful of companion pairs, plus a diversity bonus for growing 3/4/5+
--     different species at once.
--   * NFT TALENTS: a planted NFT gives a passive to its owner's whole farm.
--     54 NFTs existed and 12 were planted — a talent is a reason to plant one.
--   * WATERING (friendly): a few times a day water someone else's growing crop
--     for +3% yield on it. No coins for the helper, just the counter.
--   * THEFT (spicy): a crop left ripe and unharvested for 12 h can have 10%
--     picked by up to three other players. Crop moves between players, nothing
--     is created. A 🧑‍🌾 Strach na wróble (a coin BURN) or an NFT with the
--     scarecrow talent protects all your plots.
--
--  ── Inflation (docs/anti-inflation.md) ─────────────────────────────────────
--  Bonuses change crop QUANTITY only, clamped to farm_bonus_cap(); quantity is
--  already priced by the demand throttle. Theft is a transfer. The scarecrow is
--  a burn and sits in farm_burn_per_day(), so buying one funds the NPC budget
--  like any other farm burn.
-- ════════════════════════════════════════════════════════════════════════════


-- ── Policy knobs ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_water_bonus()        RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.03::numeric $fn$;
CREATE OR REPLACE FUNCTION public.farm_water_per_day()      RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 3 $fn$;
CREATE OR REPLACE FUNCTION public.farm_water_per_cycle()    RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 3 $fn$;
CREATE OR REPLACE FUNCTION public.farm_steal_grace_hours()  RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 12 $fn$;
CREATE OR REPLACE FUNCTION public.farm_steal_share()        RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.10::numeric $fn$;
CREATE OR REPLACE FUNCTION public.farm_steal_thieves_per_cycle() RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 3 $fn$;
CREATE OR REPLACE FUNCTION public.farm_steal_per_day()      RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 5 $fn$;
CREATE OR REPLACE FUNCTION public.farm_scarecrow_price()    RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 1500 $fn$;
CREATE OR REPLACE FUNCTION public.farm_scarecrow_days()     RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 7 $fn$;
-- When theft went live. The 12 h grace runs from GREATEST(ready_at, this), so
-- crops that were already sitting ripe at install time (measured on
-- 2026-09-28: one player's tomatoes had been ripe for three days) are not
-- fair game the moment the feature ships. Stamped ONCE with the install time;
-- re-running this file keeps the original stamp.
DO $launch$
BEGIN
  IF to_regprocedure('public.farm_steal_launch_at()') IS NULL THEN
    EXECUTE format('CREATE FUNCTION public.farm_steal_launch_at() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS %L',
                   'SELECT ' || quote_literal(now()::text) || '::timestamptz');
  END IF;
END
$launch$;

-- A scarecrow can be bought ahead, but not for a whole season at once.
CREATE OR REPLACE FUNCTION public.farm_scarecrow_max_days() RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 28 $fn$;
-- Cap on combos + diversity + watering + talents together; higher while an NFT
-- talent contributes, so a planted NFT is never capped into irrelevance.
CREATE OR REPLACE FUNCTION public.farm_bonus_cap(p_talent boolean)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN p_talent THEN 0.35 ELSE 0.25 END::numeric $fn$;
-- Diversity: distinct species planted on your plots → bonus.
CREATE OR REPLACE FUNCTION public.farm_diversity_bonus(p_species integer)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN p_species >= 5 THEN 0.15 WHEN p_species = 4 THEN 0.10 WHEN p_species = 3 THEN 0.05 ELSE 0 END::numeric
$fn$;
-- Talent for an NFT species with no row in farm_nft_talents (future weekly
-- series): a small all-plots boost, so every NFT is worth planting on day one.
CREATE OR REPLACE FUNCTION public.farm_default_talent_boost()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.03::numeric $fn$;


-- ── Data: companion pairs (by crop_type, symmetric) ────────────────────────
CREATE TABLE IF NOT EXISTS public.farm_companion_pairs (
  a      text NOT NULL,
  b      text NOT NULL,
  bonus  numeric NOT NULL CHECK (bonus > 0),
  name   text NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
ALTER TABLE public.farm_companion_pairs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_companion_pairs_select" ON public.farm_companion_pairs;
CREATE POLICY "farm_companion_pairs_select" ON public.farm_companion_pairs FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_companion_pairs FROM anon, authenticated;
GRANT SELECT ON public.farm_companion_pairs TO authenticated;

DELETE FROM public.farm_companion_pairs;
INSERT INTO public.farm_companion_pairs (a, b, bonus, name) VALUES
  ('corn',   'pumpkin',    0.10, 'Trzy siostry'),
  ('carrot', 'tomato',     0.10, 'Marchew lubi pomidory'),
  ('chili',  'tomato',     0.10, 'Salsa'),
  ('grapes', 'strawberry', 0.10, 'Deser'),
  ('carrot', 'potato',     0.10, 'Zupa jarzynowa'),
  ('chili',  'pineapple',  0.10, 'Tropiki');


-- ── Data: NFT talents ──────────────────────────────────────────────────────
--  kind: crop_boost (value on your plots growing crop_type) · all_boost (value
--  on all your plots) · scarecrow (nobody can steal from you) · water_double
--  (waterings you receive count twice) · diversity_plus (+value to your
--  species count) · weather_shield (bad weather never lowers your yield).
--  Active while an instance of the species is planted on one of the owner's
--  plots. Kinds don't stack with themselves (the best one counts).
CREATE TABLE IF NOT EXISTS public.farm_nft_talents (
  species    text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('crop_boost','all_boost','scarecrow','water_double','diversity_plus','weather_shield')),
  crop_type  text,
  value      numeric NOT NULL DEFAULT 0,
  label      text NOT NULL
);
ALTER TABLE public.farm_nft_talents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_nft_talents_select" ON public.farm_nft_talents;
CREATE POLICY "farm_nft_talents_select" ON public.farm_nft_talents FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_nft_talents FROM anon, authenticated;
GRANT SELECT ON public.farm_nft_talents TO authenticated;

DELETE FROM public.farm_nft_talents;
INSERT INTO public.farm_nft_talents (species, kind, crop_type, value, label) VALUES
  ('aeae_banana',       'all_boost',      NULL,         0.08, 'Królewski dwór: +8% plonu na wszystkich twoich polach'),
  ('crystal_lotus',     'weather_shield', NULL,         0,    'Kryształowa osłona: zła pogoda nie obniża plonów na twoich polach'),
  ('diamond_rose',      'scarecrow',      NULL,         0,    'Kolce: nikt nie podbierze plonów z twoich pól'),
  ('golden_sunflower',  'crop_boost',     'tomato',     0.15, 'Słoneczny sąsiad: +15% do pomidorów'),
  ('lavender_provence', 'water_double',   NULL,         0,    'Pszczoły: podlewanie twoich pól liczy się podwójnie'),
  ('golden_harvest',    'crop_boost',     'potato',     0.15, 'Żniwa: +15% do ziemniaków'),
  ('garden_hollyhock',  'crop_boost',     'strawberry', 0.15, 'Zapylacz: +15% do truskawek'),
  ('imperial_dahlia',   'diversity_plus', NULL,         1,    'Ogród cesarski: +1 do liczby gatunków (bonus za różnorodność)'),
  ('golden_marigold',   'crop_boost',     'carrot',     0.15, 'Odstrasza szkodniki: +15% do marchewki'),
  ('vine_grape',        'crop_boost',     'grapes',     0.15, 'Winnica: +15% do winogron'),
  ('noble_boletus',     'water_double',   NULL,         0,    'Grzybnia: podlewanie twoich pól liczy się podwójnie'),
  ('autumn_heather',    'weather_shield', NULL,         0,    'Wrzosowisko: zła pogoda nie obniża plonów na twoich polach'),
  ('sweet_chestnut',    'diversity_plus', NULL,         1,    'Stary kasztan: +1 do liczby gatunków (bonus za różnorodność)'),
  ('giant_pumpkin',     'crop_boost',     'pumpkin',    0.15, 'Olbrzym: +15% do dyń'),
  ('fiery_maple',       'crop_boost',     'chili',      0.15, 'Ognisty: +15% do papryczki chili'),
  ('royal_chrysanth',   'scarecrow',      NULL,         0,    'Chryzantema odstrasza: nikt nie podbierze plonów z twoich pól'),
  ('sunny_banana',      'crop_boost',     'pineapple',  0.15, 'Tropikalne słońce: +15% do ananasów'),
  ('crystal_peony',     'all_boost',      NULL,         0.05, 'Hybryda: +5% plonu na wszystkich twoich polach'),
  ('golden_nenufar',    'all_boost',      NULL,         0.05, 'Hybryda: +5% plonu na wszystkich twoich polach'),
  ('paradise_lotus',    'all_boost',      NULL,         0.05, 'Hybryda: +5% plonu na wszystkich twoich polach'),
  ('royal_rose_banana', 'all_boost',      NULL,         0.05, 'Hybryda: +5% plonu na wszystkich twoich polach'),
  ('sunrose',           'all_boost',      NULL,         0.05, 'Hybryda: +5% plonu na wszystkich twoich polach'),
  ('wild_hybrid',       'all_boost',      NULL,         0.05, 'Hybryda: +5% plonu na wszystkich twoich polach');


-- ── Per-cycle events: waterings and thefts ─────────────────────────────────
-- Keyed to the growing cycle by (x, y, planted_at), so harvest_crop needs no
-- reset columns: a new planting has a new planted_at and starts clean.
CREATE TABLE IF NOT EXISTS public.farm_tile_events (
  id          bigserial PRIMARY KEY,
  x           integer NOT NULL,
  y           integer NOT NULL,
  planted_at  timestamptz NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('water','steal')),
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  species     text,
  crop_type   text,
  qty         integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_tile_events_cycle_idx ON public.farm_tile_events (x, y, planted_at);
CREATE INDEX IF NOT EXISTS farm_tile_events_user_idx ON public.farm_tile_events (user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS farm_tile_events_recent_idx ON public.farm_tile_events (created_at DESC);

ALTER TABLE public.farm_tile_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_tile_events_select" ON public.farm_tile_events;
CREATE POLICY "farm_tile_events_select" ON public.farm_tile_events FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_tile_events FROM anon, authenticated;
GRANT SELECT ON public.farm_tile_events TO authenticated;

DO $pub$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND tablename = 'farm_tile_events') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_tile_events;
  END IF;
END
$pub$;

ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS scarecrow_until timestamptz;
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS waterings_given integer NOT NULL DEFAULT 0;
ALTER TABLE public.farm_user_state ADD COLUMN IF NOT EXISTS steals_done integer NOT NULL DEFAULT 0;


-- ── Helpers ────────────────────────────────────────────────────────────────
-- Talents a player has active right now: one row per kind (+crop), best value.
CREATE OR REPLACE FUNCTION public.farm_active_talents(p_user uuid)
RETURNS TABLE (kind text, crop_type text, value numeric, species text, label text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT DISTINCT ON (tl.kind, COALESCE(tl.crop_type, ''))
         tl.kind, tl.crop_type, tl.value, tl.species, tl.label
    FROM public.farm_tiles t
    JOIN public.farm_nft_instances i ON i.id = t.planted_instance_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(n.kind, 'all_boost') AS kind, n.crop_type,
             COALESCE(n.value, public.farm_default_talent_boost()) AS value,
             i.species,
             COALESCE(n.label, 'Talent: +' || round(public.farm_default_talent_boost() * 100) || '% plonu na wszystkich twoich polach') AS label
        FROM (SELECT 1) one
        LEFT JOIN public.farm_nft_talents n ON n.species = i.species
    ) tl
   WHERE t.owner_id = p_user AND t.planted_species IS NOT NULL
   ORDER BY tl.kind, COALESCE(tl.crop_type, ''), tl.value DESC, tl.species;
$fn$;
REVOKE ALL ON FUNCTION public.farm_active_talents(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_active_talents(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.farm_is_protected(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE((SELECT scarecrow_until > now() FROM public.farm_user_state WHERE user_id = p_user), false)
      OR EXISTS (SELECT 1 FROM public.farm_active_talents(p_user) WHERE kind = 'scarecrow');
$fn$;
REVOKE ALL ON FUNCTION public.farm_is_protected(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_is_protected(uuid) TO authenticated;


-- ── The yield hook, now with every layer ──────────────────────────────────
--   gross = core × (1 + land) × weather × (1 + min(cap, combos + diversity
--           + talents + watering))            weather floored at 1 by a shield
--   yield = max(0, gross − stolen)
-- Everything is evaluated at the moment of the call from what is planted on
-- the owner's plots right now (the harvested tile is still planted then).
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
  v_bonus  := LEAST(v_cap, v_combo + v_div + v_t_crop + v_t_all + v_water);

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
    'bonus', v_bonus, 'bonus_cap', v_cap);
END;
$fn$;
REVOKE ALL ON FUNCTION public.farm_harvest_yield(public.farm_tiles, uuid, numeric, text) FROM PUBLIC, anon, authenticated;


-- The core (card × level) for a planted tile — the part harvest_crop computes
-- before calling the hook. Needed to preview a tile and to size a theft.
CREATE OR REPLACE FUNCTION public.farm_tile_core_yield(p_tile public.farm_tiles)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(i.stat_yield, d.base_yield) * (1 + (p_tile.planted_level - 1) * 0.5)
    FROM public.farm_card_defs d
    LEFT JOIN public.farm_nft_instances i ON i.id = p_tile.planted_instance_id
   WHERE d.species = p_tile.planted_species;
$fn$;
REVOKE ALL ON FUNCTION public.farm_tile_core_yield(public.farm_tiles) FROM PUBLIC, anon, authenticated;


-- ── 💧 Water a neighbour's crop ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_water_tile(p_x integer, p_y integer)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_tile  public.farm_tiles%ROWTYPE;
  v_today timestamptz := date_trunc('day', now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw';
  v_used  integer;
  v_cycle integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('farm_neighbour:' || v_user::text));

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND OR v_tile.planted_species IS NULL THEN RAISE EXCEPTION 'tile_empty'; END IF;
  IF v_tile.owner_id = v_user THEN RAISE EXCEPTION 'own_tile'; END IF;
  IF v_tile.ready_at IS NULL OR now() >= v_tile.ready_at THEN RAISE EXCEPTION 'already_ripe'; END IF;

  SELECT count(*) INTO v_used FROM public.farm_tile_events
   WHERE user_id = v_user AND kind = 'water' AND created_at >= v_today;
  IF v_used >= public.farm_water_per_day() THEN RAISE EXCEPTION 'water_limit_day'; END IF;

  IF EXISTS (SELECT 1 FROM public.farm_tile_events
              WHERE x = p_x AND y = p_y AND planted_at = v_tile.planted_at
                AND kind = 'water' AND user_id = v_user) THEN
    RAISE EXCEPTION 'already_watered';
  END IF;
  SELECT count(*) INTO v_cycle FROM public.farm_tile_events
   WHERE x = p_x AND y = p_y AND planted_at = v_tile.planted_at AND kind = 'water';
  IF v_cycle >= public.farm_water_per_cycle() THEN RAISE EXCEPTION 'water_limit_tile'; END IF;

  INSERT INTO public.farm_tile_events (x, y, planted_at, kind, user_id, owner_id, species)
  VALUES (p_x, p_y, v_tile.planted_at, 'water', v_user, v_tile.owner_id, v_tile.planted_species);

  INSERT INTO public.farm_user_state (user_id, waterings_given) VALUES (v_user, 1)
  ON CONFLICT (user_id) DO UPDATE SET waterings_given = public.farm_user_state.waterings_given + 1;

  RETURN json_build_object('ok', true, 'left_today', public.farm_water_per_day() - v_used - 1,
                           'tile_waters', v_cycle + 1);
END;
$fn$;
REVOKE ALL ON FUNCTION public.farm_water_tile(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_water_tile(integer, integer) TO authenticated;


-- ── 🥷 Pick from a neglected ripe crop ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_steal_crop(p_x integer, p_y integer)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user   uuid := auth.uid();
  v_tile   public.farm_tiles%ROWTYPE;
  v_def    public.farm_card_defs%ROWTYPE;
  v_today  timestamptz := date_trunc('day', now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw';
  v_used   integer;
  v_thieves integer;
  v_calc   json;
  v_qty    integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('farm_neighbour:' || v_user::text));

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND OR v_tile.planted_species IS NULL THEN RAISE EXCEPTION 'tile_empty'; END IF;
  IF v_tile.owner_id = v_user THEN RAISE EXCEPTION 'own_tile'; END IF;
  IF v_tile.ready_at IS NULL
     OR now() < GREATEST(v_tile.ready_at, public.farm_steal_launch_at())
                + make_interval(hours => public.farm_steal_grace_hours()) THEN
    RAISE EXCEPTION 'not_stealable_yet';
  END IF;
  IF public.farm_is_protected(v_tile.owner_id) THEN RAISE EXCEPTION 'protected'; END IF;

  SELECT count(*) INTO v_used FROM public.farm_tile_events
   WHERE user_id = v_user AND kind = 'steal' AND created_at >= v_today;
  IF v_used >= public.farm_steal_per_day() THEN RAISE EXCEPTION 'steal_limit_day'; END IF;
  IF EXISTS (SELECT 1 FROM public.farm_tile_events
              WHERE x = p_x AND y = p_y AND planted_at = v_tile.planted_at
                AND kind = 'steal' AND user_id = v_user) THEN
    RAISE EXCEPTION 'already_stolen';
  END IF;
  SELECT count(*) INTO v_thieves FROM public.farm_tile_events
   WHERE x = p_x AND y = p_y AND planted_at = v_tile.planted_at AND kind = 'steal';
  IF v_thieves >= public.farm_steal_thieves_per_cycle() THEN RAISE EXCEPTION 'steal_limit_tile'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_tile.planted_species;
  v_calc := public.farm_harvest_yield(v_tile, v_tile.owner_id, public.farm_tile_core_yield(v_tile), v_def.crop_type);
  v_qty  := floor((v_calc->>'gross')::numeric * public.farm_steal_share())::integer;
  -- Never take more than is left on the plant.
  v_qty  := LEAST(v_qty, (v_calc->>'yield')::integer);
  IF v_qty < 1 THEN RAISE EXCEPTION 'nothing_to_steal'; END IF;

  INSERT INTO public.farm_tile_events (x, y, planted_at, kind, user_id, owner_id, species, crop_type, qty)
  VALUES (p_x, p_y, v_tile.planted_at, 'steal', v_user, v_tile.owner_id, v_tile.planted_species, v_def.crop_type, v_qty);

  INSERT INTO public.farm_inventory (user_id, crop_type, qty, harvested_at, expires_at)
  VALUES (v_user, v_def.crop_type, v_qty, now(), now() + interval '5 days');

  INSERT INTO public.farm_user_state (user_id, steals_done) VALUES (v_user, 1)
  ON CONFLICT (user_id) DO UPDATE SET steals_done = public.farm_user_state.steals_done + 1;

  RETURN json_build_object('ok', true, 'qty', v_qty, 'crop_type', v_def.crop_type,
                           'left_today', public.farm_steal_per_day() - v_used - 1);
END;
$fn$;
REVOKE ALL ON FUNCTION public.farm_steal_crop(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_steal_crop(integer, integer) TO authenticated;


-- ── 🧑‍🌾 Strach na wróble ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.buy_farm_scarecrow()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_price integer := public.farm_scarecrow_price();
  v_coins integer;
  v_until timestamptz;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user FOR UPDATE;
  IF v_coins IS NULL OR v_coins < v_price THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
  SELECT GREATEST(now(), COALESCE(scarecrow_until, now())) + make_interval(days => public.farm_scarecrow_days())
    INTO v_until FROM public.farm_user_state WHERE user_id = v_user FOR UPDATE;
  IF v_until > now() + make_interval(days => public.farm_scarecrow_max_days()) THEN
    RAISE EXCEPTION 'scarecrow_max';
  END IF;

  UPDATE public.profiles SET coins = coins - v_price WHERE id = v_user RETURNING coins INTO v_coins;
  UPDATE public.farm_user_state SET scarecrow_until = v_until WHERE user_id = v_user;
  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, -v_price, 'farm_scarecrow_buy', jsonb_build_object('until', v_until));

  RETURN json_build_object('ok', true, 'coins', v_coins, 'scarecrow_until', v_until);
END;
$fn$;
REVOKE ALL ON FUNCTION public.buy_farm_scarecrow() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buy_farm_scarecrow() TO authenticated;


-- ── Read: everything the board needs to decorate tiles ────────────────────
CREATE OR REPLACE FUNCTION public.farm_neighbours_state()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_today timestamptz := date_trunc('day', now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw';
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  RETURN json_build_object(
    'now', now(),
    'limits', json_build_object(
      'water_per_day', public.farm_water_per_day(), 'water_per_cycle', public.farm_water_per_cycle(),
      'water_bonus', public.farm_water_bonus(),
      'steal_grace_hours', public.farm_steal_grace_hours(), 'steal_share', public.farm_steal_share(),
      'steal_launch_at', public.farm_steal_launch_at(),
      'steal_thieves_per_cycle', public.farm_steal_thieves_per_cycle(), 'steal_per_day', public.farm_steal_per_day(),
      'scarecrow_price', public.farm_scarecrow_price(), 'scarecrow_days', public.farm_scarecrow_days(),
      'bonus_cap', public.farm_bonus_cap(false), 'bonus_cap_talent', public.farm_bonus_cap(true),
      'diversity', json_build_array(public.farm_diversity_bonus(3), public.farm_diversity_bonus(4), public.farm_diversity_bonus(5)),
      'default_talent', public.farm_default_talent_boost()),
    'me', json_build_object(
      'water_used', (SELECT count(*) FROM public.farm_tile_events WHERE user_id = v_user AND kind = 'water' AND created_at >= v_today),
      'steal_used', (SELECT count(*) FROM public.farm_tile_events WHERE user_id = v_user AND kind = 'steal' AND created_at >= v_today),
      'scarecrow_until', (SELECT scarecrow_until FROM public.farm_user_state WHERE user_id = v_user),
      'waterings_given', COALESCE((SELECT waterings_given FROM public.farm_user_state WHERE user_id = v_user), 0),
      'talents', COALESCE((SELECT json_agg(row_to_json(t)) FROM public.farm_active_talents(v_user) t), '[]'::json)),
    'pairs', COALESCE((SELECT json_agg(row_to_json(p)) FROM public.farm_companion_pairs p), '[]'::json),
    'talents', COALESCE((SELECT json_agg(row_to_json(n)) FROM public.farm_nft_talents n), '[]'::json),
    -- Protected owners (item or talent), so the board can mark their plots.
    'protected', COALESCE((SELECT json_agg(DISTINCT t.owner_id) FROM public.farm_tiles t
                            WHERE t.planted_species IS NOT NULL AND public.farm_is_protected(t.owner_id)), '[]'::json),
    -- Current-cycle events per planted tile.
    'tiles', COALESCE((
      SELECT json_agg(json_build_object(
               'x', t.x, 'y', t.y,
               'waters', (SELECT count(*) FROM public.farm_tile_events e
                           WHERE e.x = t.x AND e.y = t.y AND e.planted_at = t.planted_at AND e.kind = 'water'),
               'watered_by_me', EXISTS (SELECT 1 FROM public.farm_tile_events e
                           WHERE e.x = t.x AND e.y = t.y AND e.planted_at = t.planted_at AND e.kind = 'water' AND e.user_id = v_user),
               'stolen', (SELECT COALESCE(sum(qty), 0) FROM public.farm_tile_events e
                           WHERE e.x = t.x AND e.y = t.y AND e.planted_at = t.planted_at AND e.kind = 'steal'),
               'thieves', (SELECT count(*) FROM public.farm_tile_events e
                           WHERE e.x = t.x AND e.y = t.y AND e.planted_at = t.planted_at AND e.kind = 'steal'),
               'stolen_by_me', EXISTS (SELECT 1 FROM public.farm_tile_events e
                           WHERE e.x = t.x AND e.y = t.y AND e.planted_at = t.planted_at AND e.kind = 'steal' AND e.user_id = v_user)))
        FROM public.farm_tiles t
       WHERE t.planted_species IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.farm_tile_events e
                      WHERE e.x = t.x AND e.y = t.y AND e.planted_at = t.planted_at)), '[]'::json),
    'feed', COALESCE((
      SELECT json_agg(json_build_object('kind', e.kind, 'actor', pa.nick, 'owner', po.nick,
                                        'crop_type', e.crop_type, 'species', e.species, 'qty', e.qty,
                                        'at', e.created_at, 'mine', (e.owner_id = v_user OR e.user_id = v_user))
                      ORDER BY e.created_at DESC)
        FROM (SELECT * FROM public.farm_tile_events ORDER BY created_at DESC LIMIT 40) e
        JOIN public.profiles pa ON pa.id = e.user_id
        JOIN public.profiles po ON po.id = e.owner_id), '[]'::json)
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.farm_neighbours_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_neighbours_state() TO authenticated;
