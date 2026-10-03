-- ════════════════════════════════════════════════════════════════════════════
--  „Złota Kolekcja PRL" — ONE NFT edition a month  (2026-10-03)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm-nft-series-window.sql, farm-nft-breeding.sql,
--  farm-neighbours.sql, farm-achievements.sql and farm-static-nft-odds.sql.
--  Idempotent.
--
--  ⚠️ SUPERSEDES (re-run this file after re-running any of these):
--     farm_nft_pool / farm_nft_persona   ← farm-nft-breeding.sql (and farm.sql)
--     farm_mint_random_event_nft          ← farm-weekly-nft-series.sql
--     farm_seasonal_bonus / farm_achievements ← farm-achievements.sql
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  Measured on prod 2026-10-03: 182 NFTs minted, 55 alive, 17 planted, 0 listed,
--  3 sales ever. 38 of the 55 grew the same `seasonal_bloom` crop, so a weekly
--  edition was a new name on an identical plant, and 23 species with 1–5 live
--  copies each made the merge (same species + same level) all but impossible.
--  The weekly rotation was also only seeded through 2026-10-12.
--
--  ── What ───────────────────────────────────────────────────────────────────
--  One edition a month, a PRL-flavoured version of one of the nine base plants,
--  named after that month's Polish holiday. It grows its OWN base crop (a real
--  🍍 pineapple, not seasonal_bloom) at base_yield × 6, so it sells on that
--  crop's market, fills that crop's orders and contracts, and inherits that
--  crop's weather affinity with no extra rows.
--
--  Edition 50, draw weight 2 for its own month only, then 0: the edition
--  CLOSES. One live edition at weight 2 is ~0.34% per standard box (the
--  client computes the exact figure live from the weights), i.e. 14–29 mints a
--  month at the measured 4 000–8 600 opens + ≤5 Wyzwanie winners — so it never
--  sells out, and the unminted serials stay „🔒 niewybita" for good. That is the
--  collectible point, and 15–30 copies of ONE species is what finally makes
--  merging possible.
--
--  Not inflationary: crop revenue goes through the demand-throttled NPC market
--  (anti-inflation.sql), so a strong NFT pineapple takes a bigger share of the
--  same budget rather than adding to it.
-- ════════════════════════════════════════════════════════════════════════════


-- ── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE public.farm_card_defs ADD COLUMN IF NOT EXISTS series_month date;
ALTER TABLE public.farm_card_defs ADD COLUMN IF NOT EXISTS nft_collection text;
COMMENT ON COLUMN public.farm_card_defs.series_month IS
  'Monthly NFT edition: first day of the month it drops in (farm-nft-monthly.sql). series_week stays NULL.';
COMMENT ON COLUMN public.farm_card_defs.nft_collection IS
  'Visual/album collection key for NFT defs: classic | summer26 | autumn26 | hybrid | prl.';


-- ── Policy knobs ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_nft_monthly_weight()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 2; $$;

-- Net worth per level of a monthly NFT (stat_value). 20000/50 = 400 would make
-- a fresh legendary look cheap next to the 8-copy weekly ones (2 500).
CREATE OR REPLACE FUNCTION public.farm_nft_monthly_value()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1500; $$;

CREATE OR REPLACE FUNCTION public.farm_warsaw_today()
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Europe/Warsaw')::date;
$$;


-- ── The lineup ─────────────────────────────────────────────────────────────
-- base_yield = the base plant's × 6 (≈ a level-11 card; cards average L8).
-- Grow time = the base plant's. is_active/draw_weight are owned by the tick
-- below, so the UPSERT never touches them on a re-run.
INSERT INTO public.farm_card_defs
  (species, name, emoji, rarity, draw_weight, base_grow_minutes, base_yield, crop_type,
   edition_size, series_month, nft_collection, is_active)
VALUES
  ('prl_pumpkin',    'Dynia z Andrzejkowych Wróżb',          '🎃', 'legendary', 0, 4320, 180, 'pumpkin',    50, DATE '2026-11-01', 'prl', false),
  ('prl_pineapple',  'Ananas z Peweksu pod Choinkę',         '🍍', 'legendary', 0, 5760, 270, 'pineapple',  50, DATE '2026-12-01', 'prl', false),
  ('prl_carrot',     'Marchewka z Nosa Bałwana',             '🥕', 'legendary', 0, 1440,  24, 'carrot',     50, DATE '2027-01-01', 'prl', false),
  ('prl_chili',      'Papryczka Teściowej na Walentynki',    '🌶️', 'legendary', 0, 2880,  66, 'chili',      50, DATE '2027-02-01', 'prl', false),
  ('prl_potato',     'Kartofel z Goździkiem na Dzień Kobiet', '🥔', 'legendary', 0, 1440,  30, 'potato',     50, DATE '2027-03-01', 'prl', false),
  ('prl_tomato',     'Pomidor ze Śmigusa-Dyngusa',           '🍅', 'legendary', 0, 1440,  36, 'tomato',     50, DATE '2027-04-01', 'prl', false),
  ('prl_corn',       'Kukurydza z Pochodu Pierwszomajowego', '🌽', 'legendary', 0, 2880,  72, 'corn',       50, DATE '2027-05-01', 'prl', false),
  ('prl_strawberry', 'Truskawka na Świadectwo z Paskiem',    '🍓', 'legendary', 0, 2880,  90, 'strawberry', 50, DATE '2027-06-01', 'prl', false),
  ('prl_grapes',     'Wino Marki Wino z Wczasów pod Gruszą', '🍇', 'legendary', 0, 4320, 210, 'grapes',     50, DATE '2027-07-01', 'prl', false)
ON CONFLICT (species) DO UPDATE SET
  name = EXCLUDED.name, emoji = EXCLUDED.emoji, rarity = EXCLUDED.rarity,
  base_grow_minutes = EXCLUDED.base_grow_minutes, base_yield = EXCLUDED.base_yield,
  crop_type = EXCLUDED.crop_type, edition_size = EXCLUDED.edition_size,
  series_month = EXCLUDED.series_month, nft_collection = EXCLUDED.nft_collection;

-- Collection keys for everything that existed before (drives frames + album).
UPDATE public.farm_card_defs SET nft_collection = 'classic'
 WHERE species IN ('diamond_rose','golden_sunflower','crystal_lotus','aeae_banana')
   AND nft_collection IS DISTINCT FROM 'classic';
UPDATE public.farm_card_defs SET nft_collection = 'summer26'
 WHERE species IN ('lavender_provence','golden_harvest','garden_hollyhock','imperial_dahlia','golden_marigold','vine_grape')
   AND nft_collection IS DISTINCT FROM 'summer26';
UPDATE public.farm_card_defs SET nft_collection = 'autumn26'
 WHERE species IN ('noble_boletus','autumn_heather','sweet_chestnut','giant_pumpkin','fiery_maple','royal_chrysanth')
   AND nft_collection IS DISTINCT FROM 'autumn26';
UPDATE public.farm_card_defs SET nft_collection = 'hybrid'
 WHERE COALESCE(is_hybrid, false) AND nft_collection IS DISTINCT FROM 'hybrid';


-- ── Talents (farm-neighbours.sql's re-run leaves prl_* rows alone) ─────────
INSERT INTO public.farm_nft_talents (species, kind, crop_type, value, label) VALUES
  ('prl_pumpkin',    'diversity_plus', NULL,         1,    'Wosk przez klucz: +1 do liczby gatunków (bonus za różnorodność)'),
  ('prl_pineapple',  'all_boost',      NULL,         0.05, 'Bony dolarowe: +5% plonu na wszystkich twoich polach'),
  ('prl_carrot',     'weather_shield', NULL,         0,    'Bałwan nie boi się mrozu: zła pogoda nie obniża plonów na twoich polach'),
  ('prl_chili',      'scarecrow',      NULL,         0,    'Teściowa pilnuje: nikt nie podbierze plonów z twoich pól'),
  ('prl_potato',     'crop_boost',     'potato',     0.15, 'Goździk i rajstopy: +15% do ziemniaków'),
  ('prl_tomato',     'water_double',   NULL,         0,    'Lany poniedziałek: podlewanie twoich pól liczy się podwójnie'),
  ('prl_corn',       'crop_boost',     'corn',       0.15, 'Królowa Pól na transparencie: +15% do kukurydzy'),
  ('prl_strawberry', 'crop_boost',     'strawberry', 0.15, 'Czerwony pasek: +15% do truskawek'),
  ('prl_grapes',     'crop_boost',     'grapes',     0.15, 'Kaowiec polewa: +15% do winogron')
ON CONFLICT (species) DO UPDATE SET
  kind = EXCLUDED.kind, crop_type = EXCLUDED.crop_type,
  value = EXCLUDED.value, label = EXCLUDED.label;


-- ── Seasonal persona names ─────────────────────────────────────────────────
-- Each copy is „<seasonal title> <old-school diminutive>": „Karp Zdzisiek",
-- „Bałwan Mietek", „Kaowiec Rysiek". A leading '*' marks a feminine title,
-- which takes a name from the feminine list. 10 titles × 12 names, paired so
-- every index below 120 is a distinct name (title = i % 10, and for a fixed
-- title the name index i/10 + title walks all 12) — an edition is 50.
CREATE OR REPLACE FUNCTION public.farm_prl_persona(p_species text, p_idx integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_titles text[];
  v_men    text[] := ARRAY['Zdzisiek','Mietek','Czesiek','Heniek','Rysiek','Józek',
                           'Kaziu','Tadek','Edek','Waldek','Stasiek','Bogdan'];
  v_women  text[] := ARRAY['Grażynka','Halinka','Krysia','Jadzia','Basia','Danusia',
                           'Bożenka','Irenka','Zosia','Wiesia','Gienia','Stasia'];
  i        integer := abs(COALESCE(p_idx, 0));
  t        integer;
  n        integer;
  v_title  text;
  v_name   text;
BEGIN
  v_titles := CASE p_species
    WHEN 'prl_pumpkin'    THEN ARRAY['*Wróżka','Wróżbita','Kawaler','*Panna','Kominiarz','*Sąsiadka','Sołtys','*Gospodyni','Listonosz','*Swatka']
    WHEN 'prl_pineapple'  THEN ARRAY['Mikołaj','*Śnieżynka','Gwiazdor','*Aniołek','Kolędnik','*Pasterka','Karp','Dziadek Mróz','*Choinka','*Babcia']
    WHEN 'prl_carrot'     THEN ARRAY['Bałwan','*Bałwanica','Sylwester','*Królowa Balu','Saneczkarz','*Łyżwiarka','Narciarz','*Pani Zima','Dozorca','*Kuligowa']
    WHEN 'prl_chili'      THEN ARRAY['Amor','*Walentynka','Pączek','*Faworka','*Teściowa','Zięć','*Synowa','Swat','Romantyk','*Lukrowa']
    WHEN 'prl_potato'     THEN ARRAY['*Marzanna','*Przodownica','Towarzysz','*Kierowniczka','*Sekretarka','Bociek','Przebiśnieg','*Wiosna','Brygadzista','*Goździkowa']
    WHEN 'prl_tomato'     THEN ARRAY['Dyngusiarz','*Pisanka','Zajączek','Baranek','*Rzeżucha','Kurczaczek','Psotnik','*Polewaczka','*Babka','*Święconkowa']
    WHEN 'prl_corn'       THEN ARRAY['Chorąży','Przodownik','Działkowiec','*Działkowiczka','Harcerz','*Harcerka','Maturzysta','*Maturzystka','*Konwalia','Majówkowicz']
    WHEN 'prl_strawberry' THEN ARRAY['Prymus','*Prymuska','Absolwent','*Absolwentka','*Wychowawczyni','Woźny','Kupała','*Rusałka','Tata','*Wiankowa']
    WHEN 'prl_grapes'     THEN ARRAY['Wczasowicz','*Wczasowiczka','Kolonista','*Kolonistka','Kaowiec','Ratownik','*Plażowiczka','Wędkarz','Wychowawca','*Turystka']
    ELSE ARRAY['Towarzysz','*Towarzyszka','Pan','*Pani','Wujek','*Ciocia','Kierownik','*Kierowniczka','Sołtys','*Sąsiadka']
  END;
  t := i % 10;
  n := (t + (i / 10)) % 12;
  v_title := v_titles[t + 1];
  IF left(v_title, 1) = '*' THEN
    v_title := substr(v_title, 2);
    v_name  := v_women[n + 1];
  ELSE
    v_name  := v_men[n + 1];
  END IF;
  RETURN v_title || ' ' || v_name || CASE WHEN i >= 120 THEN ' ' || (i / 120 + 1)::text ELSE '' END;
END $$;

-- Persona pool: every PRL edition is its own pool, so the mint index the draw
-- functions compute (Σ minted_count over the pool) is just that species' count.
-- Supersedes farm-nft-breeding.sql's copy; the other branches are unchanged.
CREATE OR REPLACE FUNCTION public.farm_nft_pool(p_species text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_species LIKE 'prl\_%' THEN 'prl:' || p_species
    WHEN p_species IN (
      'wild_hybrid', 'sunrose', 'paradise_lotus', 'crystal_peony',
      'golden_nenufar', 'royal_rose_banana', 'sunny_banana'
    ) THEN 'hybrid'
    WHEN p_species = 'aeae_banana' THEN 'hawaii'
    WHEN public.farm_nft_is_female(p_species) THEN 'female'
    ELSE 'male' END;
$$;

CREATE OR REPLACE FUNCTION public.farm_nft_persona(p_species text, p_idx integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN public.farm_nft_pool(p_species) LIKE 'prl:%' THEN public.farm_prl_persona(p_species, p_idx)
    WHEN public.farm_nft_pool(p_species) = 'hybrid' THEN (ARRAY[
      'Światowid','Perun','Weles','Swaróg','Radogost','Jaryło',
      'Dziewanna','Marzanna','Żywia','Lel','Polel','Trzygłów',
      'Prowe','Porewit','Rugewit','Kupała','Dola','Nyja','Chors','Rod'
    ])[ (abs(p_idx) % 20) + 1 ]
    WHEN public.farm_nft_pool(p_species) = 'hawaii' THEN (ARRAY[
      'Kai','Leilani','Keanu','Nalani','Koa','Mahina','Kawika',
      'Noelani','Kainoa','Makoa','Kekoa','Iolana','Alaula','Pualani'
    ])[ (abs(p_idx) % 14) + 1 ]
    ELSE public.farm_nft_name(p_idx, public.farm_nft_is_female(p_species))
  END;
$$;


-- ── Net worth: stamp stat_value on a freshly minted monthly NFT ────────────
-- A trigger rather than three re-transcribed mint functions (lootbox, gold box,
-- Wyzwanie reward). The net-worth functions already read
-- COALESCE(stat_value × level, 20000/edition × level).
CREATE OR REPLACE FUNCTION public.farm_nft_monthly_stamp_value()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stat_value IS NULL AND EXISTS (
       SELECT 1 FROM public.farm_card_defs d
        WHERE d.species = NEW.species AND d.series_month IS NOT NULL) THEN
    NEW.stat_value := public.farm_nft_monthly_value();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS farm_nft_monthly_stamp_value ON public.farm_nft_instances;
CREATE TRIGGER farm_nft_monthly_stamp_value
  BEFORE INSERT ON public.farm_nft_instances
  FOR EACH ROW EXECUTE FUNCTION public.farm_nft_monthly_stamp_value();


-- ── The monthly tick ───────────────────────────────────────────────────────
-- Date-driven and idempotent, so running it daily is harmless and DST-proof.
--   • an edition turns active on its month and STAYS active (plantable, in the
--     catalog) — only its draw weight closes;
--   • draw weight = farm_nft_monthly_weight() during its own month, 0 after;
--   • once the monthly era has started, every older NFT def (weekly series and
--     the four originals) is closed too: one new NFT a month means one.
-- Hybrids are never touched (they are bred, never drawn: weight 0 already).
CREATE OR REPLACE FUNCTION public.farm_nft_monthly_tick(p_today date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := COALESCE(p_today, public.farm_warsaw_today());
  v_month date := date_trunc('month', v_today)::date;
  v_start date;
  v_n     integer := 0;
  v_k     integer;
BEGIN
  SELECT min(series_month) INTO v_start FROM public.farm_card_defs WHERE series_month IS NOT NULL;

  UPDATE public.farm_card_defs d
     SET is_active   = d.is_active OR d.series_month <= v_today,
         draw_weight = CASE WHEN d.series_month = v_month THEN public.farm_nft_monthly_weight() ELSE 0 END
   WHERE d.series_month IS NOT NULL
     AND (d.is_active IS DISTINCT FROM (d.is_active OR d.series_month <= v_today)
          OR d.draw_weight IS DISTINCT FROM
             CASE WHEN d.series_month = v_month THEN public.farm_nft_monthly_weight() ELSE 0 END);
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;

  IF v_start IS NOT NULL AND v_today >= v_start THEN
    UPDATE public.farm_card_defs d
       SET draw_weight = 0
     WHERE d.edition_size IS NOT NULL
       AND d.series_month IS NULL
       AND d.draw_weight > 0;
    GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  END IF;

  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.farm_nft_monthly_tick(date) FROM PUBLIC, anon, authenticated;

-- 22:01 and 23:01 UTC: one of them is 00:01 Europe/Warsaw in both CET and CEST.
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobname) FROM cron.job
     WHERE jobname IN ('farm_nft_monthly_tick_2201', 'farm_nft_monthly_tick_2301');
    PERFORM cron.schedule('farm_nft_monthly_tick_2201', '1 22 * * *', 'SELECT public.farm_nft_monthly_tick();');
    PERFORM cron.schedule('farm_nft_monthly_tick_2301', '1 23 * * *', 'SELECT public.farm_nft_monthly_tick();');
  END IF;
END $$;


-- ── Public calendar ────────────────────────────────────────────────────────
-- Every monthly edition, past and future, for the „Kalendarz kolekcji" panel
-- and the drought banner. The client reads names/months from here, so there is
-- no client-side rotation constant to keep in sync.
CREATE OR REPLACE VIEW public.farm_nft_monthly_schedule WITH (security_invoker = true) AS
  SELECT
    d.species, d.name, d.emoji, d.crop_type, d.edition_size, d.minted_count,
    d.series_month, d.base_yield, d.base_grow_minutes,
    (SELECT count(*) FROM public.farm_nft_instances ni WHERE ni.species = d.species) AS live_count,
    t.label AS talent_label,
    CASE
      WHEN d.series_month > public.farm_warsaw_today() THEN 'upcoming'
      WHEN d.series_month = date_trunc('month', public.farm_warsaw_today())::date THEN 'live'
      ELSE 'closed'
    END AS status
  FROM public.farm_card_defs d
  LEFT JOIN public.farm_nft_talents t ON t.species = d.species
  WHERE d.series_month IS NOT NULL
  ORDER BY d.series_month;
GRANT SELECT ON public.farm_nft_monthly_schedule TO authenticated;


-- ── Wyzwanie reward: prefer the current month's edition ────────────────────
-- Supersedes farm-weekly-nft-series.sql. Order of preference: this month's
-- edition → this week's weekly edition (pre-November) → any mintable NFT.
CREATE OR REPLACE FUNCTION public.farm_mint_random_event_nft(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer := 0;
  v_total    numeric;
  v_roll     numeric;
  v_species  text;
  v_def      public.farm_card_defs%ROWTYPE;
  v_serial   integer;
  v_nft_idx  integer;
  v_name     text;
  v_id       uuid;
  v_monday   date := public.farm_current_series_monday();
  v_month    date := date_trunc('month', public.farm_warsaw_today())::date;
  v_mode     text;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  WHILE v_attempts < 20 LOOP
    v_attempts := v_attempts + 1;

    v_mode := CASE
      WHEN EXISTS (SELECT 1 FROM public.farm_card_defs
                    WHERE is_active AND edition_size IS NOT NULL AND draw_weight > 0
                      AND series_month = v_month AND minted_count < edition_size) THEN 'month'
      WHEN EXISTS (SELECT 1 FROM public.farm_card_defs
                    WHERE is_active AND edition_size IS NOT NULL AND draw_weight > 0
                      AND series_week = v_monday AND minted_count < edition_size) THEN 'week'
      ELSE 'any' END;

    SELECT sum(draw_weight)::numeric INTO v_total
      FROM public.farm_card_defs
     WHERE is_active AND edition_size IS NOT NULL AND draw_weight > 0
       AND minted_count < edition_size
       AND (v_mode = 'any'
            OR (v_mode = 'month' AND series_month = v_month)
            OR (v_mode = 'week'  AND series_week  = v_monday));
    IF v_total IS NULL OR v_total <= 0 THEN
      RETURN NULL;
    END IF;

    v_roll := random() * v_total;
    SELECT species INTO v_species
      FROM (
        SELECT species, sum(draw_weight) OVER (ORDER BY species) AS cum
          FROM public.farm_card_defs
         WHERE is_active AND edition_size IS NOT NULL AND draw_weight > 0
           AND minted_count < edition_size
           AND (v_mode = 'any'
                OR (v_mode = 'month' AND series_month = v_month)
                OR (v_mode = 'week'  AND series_week  = v_monday))
      ) q
     WHERE q.cum > v_roll
     ORDER BY q.cum
     LIMIT 1;

    SELECT * INTO v_def
      FROM public.farm_card_defs
     WHERE species = v_species
     FOR UPDATE;
    IF NOT FOUND OR v_def.minted_count >= v_def.edition_size THEN
      CONTINUE;
    END IF;

    v_serial := v_def.minted_count + 1;
    SELECT COALESCE(sum(d2.minted_count), 0) INTO v_nft_idx
      FROM public.farm_card_defs d2
     WHERE d2.edition_size IS NOT NULL
       AND public.farm_nft_pool(d2.species) = public.farm_nft_pool(v_species);
    v_name := public.farm_nft_persona(v_species, v_nft_idx);

    INSERT INTO public.farm_nft_instances
      (species, serial_no, edition_size, owner_id, acquired_from, nft_name)
    VALUES
      (v_species, v_serial, v_def.edition_size, p_user, 'seasonal_reward', v_name)
    RETURNING id INTO v_id;

    UPDATE public.farm_card_defs
       SET minted_count = minted_count + 1
     WHERE species = v_species;

    IF to_regclass('public.farm_nft_transfers') IS NOT NULL THEN
      INSERT INTO public.farm_nft_transfers
        (instance_id, species, serial_no, from_owner, to_owner, price, kind)
      VALUES
        (v_id, v_species, v_serial, NULL, p_user, 0, 'mint');
    END IF;

    RETURN jsonb_build_object(
      'nft', true, 'id', v_id, 'species', v_species,
      'serial_no', v_serial, 'edition_size', v_def.edition_size,
      'nft_name', v_name, 'name', v_def.name, 'emoji', v_def.emoji);
  END LOOP;

  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.farm_mint_random_event_nft(uuid) FROM PUBLIC, anon, authenticated;


-- ── „Sezonowy Łowca": monthly editions count as a series ───────────────────
-- Supersedes farm-achievements.sql (only the series predicate changes).
-- Client mirror: farmSeasonalAchBonus() in index.html.
CREATE OR REPLACE FUNCTION public.farm_seasonal_bonus(p_user uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT LEAST(0.20, 0.02 * COALESCE((
    SELECT count(DISTINCT ni.species)
      FROM public.farm_nft_instances ni
      JOIN public.farm_card_defs d ON d.species = ni.species
     WHERE ni.owner_id = p_user
       AND (d.series_week IS NOT NULL OR d.series_month IS NOT NULL)), 0))::numeric;
$$;
GRANT EXECUTE ON FUNCTION public.farm_seasonal_bonus(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.farm_achievements(p_user uuid DEFAULT auth.uid())
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object(
    'user_id', p_user,
    'nick', (SELECT nick FROM public.profiles WHERE id = p_user),
    'distinct_species', COALESCE((SELECT count(DISTINCT species) FROM public.farm_nft_instances WHERE owner_id = p_user), 0),
    'nft_count',        COALESCE((SELECT count(*)               FROM public.farm_nft_instances WHERE owner_id = p_user), 0),
    'nft_level_sum',    COALESCE((SELECT sum(level)             FROM public.farm_nft_instances WHERE owner_id = p_user), 0),
    'hybrids_bred',     COALESCE((SELECT count(*)               FROM public.farm_hybrid_births WHERE bred_by  = p_user), 0),
    'distinct_series',  COALESCE((SELECT count(DISTINCT ni.species)
                                    FROM public.farm_nft_instances ni
                                    JOIN public.farm_card_defs d ON d.species = ni.species
                                   WHERE ni.owner_id = p_user
                                     AND (d.series_week IS NOT NULL OR d.series_month IS NOT NULL)), 0),
    'tiles_owned',      COALESCE((SELECT count(*) FROM public.farm_tiles
                                   WHERE owner_id = p_user AND acquired_via IS DISTINCT FROM 'migration'), 0),
    'price_bonus_pct',    round(public.farm_collector_bonus(p_user) * 100)::int,
    'growth_bonus_pct',   round(public.farm_growth_bonus(p_user)    * 100)::int,
    'breed_discount_pct', round(public.farm_breed_discount(p_user)  * 100)::int,
    'seasonal_bonus_pct', round(public.farm_seasonal_bonus(p_user)  * 100)::int,
    'yield_bonus_pct',    round(public.farm_yield_bonus(p_user)     * 100)::int
  );
$$;
GRANT EXECUTE ON FUNCTION public.farm_achievements(uuid) TO authenticated;


-- Catch up now (a no-op before 2026-11-01 except for activating nothing).
SELECT public.farm_nft_monthly_tick();
