-- ════════════════════════════════════════════════════════════════════════════
--  „Tablica Zamówień" — NPC orders for crop MIXES  (2026-09-28)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after anti-inflation.sql + office-goals.sql. Idempotent.
--  ⚠️ anti-inflation.sql's farm_revenue_per_day() must list 'farm_order_payout'
--     (it does, in the repo) — re-run that file together with this one.
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  Measured on prod 2026-09-28: the board was a monoculture. Every plot a
--  player owned grew the same crop — this week's contract species — because
--  apart from the contract nothing rewarded growing anything else: the demand
--  throttle had every NPC price near its floor, so only card LEVEL mattered.
--  The weekly contract proved that a rotating incentive does move what people
--  plant; it just moves everyone onto ONE crop.
--
--  Orders are the counter-weight: a few NPC customers a day each want a small
--  MIX of crops, deliberately drawn from the crops the office is NOT selling
--  (weighted by 1 / 7-day revenue share, never the contract crop), at a premium
--  over the market. A player who grew three different things can fill them;
--  a player with twelve plots of corn cannot.
--
--  ── Why it does not reopen the open loop (docs/anti-inflation.md) ─────────
--  Payouts are booked as 'farm_order_payout', and farm_revenue_per_day() counts
--  that reason next to farm_crop_sale. So every coin an order pays raises the
--  measured pressure and lowers the demand multiplier on the stalk market: the
--  NPC budget is unchanged, orders only decide WHICH output it pays for.
--
--  ── Shape ──────────────────────────────────────────────────────────────────
--  Lazy-on-read like bank_settle_due(): farm_orders_state() creates today's
--  orders on the first read of a Warsaw day, so there is no cron to forget.
--  Each order stays open farm_order_ttl_hours() after its day starts, so about
--  six are open at once and there is time to grow for one. Every player may
--  fill every order once; nobody "takes" an order from anyone else.
--
--  ── 2026-10-22: more orders, better paid (the 🏆 Wyzwanie ended) ──────────
--  farm-seasonal-end.sql retired the weekly contract, whose premium was ~8 300
--  🪙/day of farm revenue. Measured that day: orders paid 150–2 500 🪙 each
--  (~4 000/day in total, two players filling nearly all of them) against
--  ~100 000/day at the stall, and the 💎 Kolekcjoner asked for the same crop
--  five days running that only one player had planted. So:
--    • 3 mix orders a day instead of 2, premiums 1.00/1.15/1.30 → 1.10/1.25/1.40,
--      and every line is worth at least ¾ of a median harvest per harvest asked
--      (farm_order_harvest_floor_share) — the cheap crops were the small orders;
--    • rewards scale with sqrt(demand) instead of demand — at demand 0.58 that
--      is ×0.76 instead of ×0.58; orders still follow the throttle, but when the
--      stall is flooded they become relatively MORE attractive, which is the
--      diversification nudge they exist for;
--    • three new kinds: 🚚 'bulk' (one crop, 3–4 harvests, 72 h), ⚡ 'express'
--      (two crops someone already has in the barn, until midnight) and 🏛️
--      'weekly' (four crops, open Monday → Monday — the Wyzwanie's slot, but it
--      rewards variety instead of one crop and pays everyone who fills it);
--    • the Kolekcjoner prefers NFT crops that are actually planted and avoids
--      the crop of a collector order that is still open.
--  Still not a new mint: every kind books 'farm_order_payout', which
--  farm_revenue_per_day() counts, so the NPC budget is unchanged — orders only
--  take a bigger share of it from the stall.
-- ════════════════════════════════════════════════════════════════════════════


-- ── Policy knobs (one line each, retune with CREATE OR REPLACE) ────────────
CREATE OR REPLACE FUNCTION public.farm_orders_per_day()
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 3 $fn$;

CREATE OR REPLACE FUNCTION public.farm_order_ttl_hours()
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 72 $fn$;

-- Premium over base_price × demand^exponent, by number of distinct crops in the
-- order. The stall anchor averages ~0.57 × base × demand, so at demand 0.58 a
-- 1-line order pays ~2.6× the anchor and a 3-line one ~3.3× — the mix, not the
-- volume, is what gets paid for.
CREATE OR REPLACE FUNCTION public.farm_order_premium(p_lines integer)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN p_lines >= 3 THEN 1.40 WHEN p_lines = 2 THEN 1.25 ELSE 1.10 END::numeric
$fn$;

-- Premiums of the kinds added 2026-10-22. Bulk is volume, so it sits below a
-- mix line; express needs stock on hand by midnight; the weekly order is four
-- crops at once and stands in for the retired contract.
CREATE OR REPLACE FUNCTION public.farm_order_kind_premium(p_kind text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE p_kind WHEN 'bulk' THEN 0.85 WHEN 'express' THEN 1.40 WHEN 'weekly' THEN 2.00 ELSE 1.00 END::numeric
$fn$;

-- Every line is valued at least this share of the MEDIAN crop's harvest per
-- harvest asked for. Without it the 'unsold' weighting mostly drew 🥕 🥔 🍅 —
-- unsold precisely because one harvest of them is worth ~50 🪙 at base against
-- ~600–800 for 🍇 🎃 🍍 — so orders stayed small whatever the premium. With it,
-- growing an unpopular crop FOR an order pays about what a plot of anything
-- pays, which is the whole point of the board.
CREATE OR REPLACE FUNCTION public.farm_order_harvest_floor_share()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.75::numeric $fn$;

-- How steeply order rewards follow the stall's demand multiplier. 1.0 = the
-- same throttle as the stall (the 2026-09-28 behaviour), 0 = ignore it.
CREATE OR REPLACE FUNCTION public.farm_order_demand_exponent()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.5::numeric $fn$;

-- Σ qty × base_price × demand^exponent × premium, rounded to 10 🪙.
CREATE OR REPLACE FUNCTION public.farm_order_reward(p_value numeric, p_demand numeric, p_premium numeric)
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$
  SELECT GREATEST(10, round(p_value * power(GREATEST(p_demand, 0.01), public.farm_order_demand_exponent())
                            * p_premium / 10.0) * 10)::integer
$fn$;

-- Bumped whenever the generator learns a new kind, so a day that was already
-- generated by an older version gets topped up on its next read.
CREATE OR REPLACE FUNCTION public.farm_order_generator_version()
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 2 $fn$;

-- „💎 Kolekcjoner": one extra order a day for an NFT crop (seasonal_bloom or a
-- legendary crop). Measured 2026-09-28: 54 NFTs existed and only 12 were
-- planted — they had become trophies, because a levelled common card out-earns
-- them on a plot. This is a second buyer for what an NFT grows, priced above
-- the ordinary orders because only NFT holders can fill it.
CREATE OR REPLACE FUNCTION public.farm_order_collector_premium()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 1.60::numeric $fn$;

-- Sized to this fraction of ONE average planted-NFT harvest, so a player with a
-- single NFT in the ground can fill it.
CREATE OR REPLACE FUNCTION public.farm_order_collector_harvest_share()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.80::numeric $fn$;

-- The card level an order line is sized for: this percentile of the levels of
-- everyone holding the card. Below the median on purpose — sized for the top
-- farmer it would be unreachable for everyone else.
CREATE OR REPLACE FUNCTION public.farm_order_level_percentile()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.35::numeric $fn$;


-- ── Tables ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.farm_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_on   date NOT NULL,                 -- Warsaw day the order appeared
  slot        integer NOT NULL,
  customer    text NOT NULL,
  emoji       text NOT NULL,
  lines       jsonb NOT NULL,                -- [{crop_type, qty}]
  reward      integer NOT NULL CHECK (reward > 0),
  demand_bps  integer NOT NULL,              -- the demand the reward was priced at
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  UNIQUE (opened_on, slot)
);
-- 'mix' = the ordinary base-crop orders, 'collector' = the daily NFT-crop order,
-- 'bulk' / 'express' / 'weekly' = the 2026-10-22 kinds (see the header).
-- The weekly order lives on its Monday at slot 0; daily kinds use slots 1+.
ALTER TABLE public.farm_orders ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'mix';
CREATE INDEX IF NOT EXISTS farm_orders_expires_idx ON public.farm_orders (expires_at DESC);

-- One row per generated Warsaw day: the fast path of farm_ensure_daily_orders()
-- and the reason a version bump tops up a day that is already half-generated.
-- Service-only (RLS on, no policies, no grants).
CREATE TABLE IF NOT EXISTS public.farm_order_days (
  day     date PRIMARY KEY,
  version integer NOT NULL
);
ALTER TABLE public.farm_order_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.farm_order_days FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.farm_order_fills (
  order_id  uuid NOT NULL REFERENCES public.farm_orders(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reward    integer NOT NULL,
  filled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, user_id)
);
CREATE INDEX IF NOT EXISTS farm_order_fills_user_idx ON public.farm_order_fills (user_id, filled_at DESC);

ALTER TABLE public.farm_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_order_fills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_orders_select" ON public.farm_orders;
CREATE POLICY "farm_orders_select" ON public.farm_orders FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "farm_order_fills_select" ON public.farm_order_fills;
CREATE POLICY "farm_order_fills_select" ON public.farm_order_fills FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_orders, public.farm_order_fills FROM anon, authenticated;
GRANT SELECT ON public.farm_orders, public.farm_order_fills TO authenticated;

DO $pub$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND tablename = 'farm_order_fills') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_order_fills;
  END IF;
END
$pub$;


-- ── Line picker (shared by mix / bulk / express / weekly) ──────────────────
-- Draws p_n distinct base crops (weighted, without replacement) and sizes each
-- line at k harvests, k uniform in [p_kmin, p_kmax], of a card at the
-- farm_order_level_percentile() level of the people who hold it.
-- Candidates: unlimited (non-NFT) active cards held by >= 2 non-admin players
-- (otherwise nobody could fill it), minus p_exclude_species.
-- p_mode 'unsold': weight = 1 / (7-day stall revenue share + 0.03), so the crops
--                  nobody sells come up most (the original mix rule).
-- p_mode 'stock':  only crops some non-admin player has in the barn right now,
--                  weight = how many players do — an order you can fill today.
-- The Efraimidis–Spirakis key random()^(1/w) gives a weighted order.
-- Each line carries 'value' = max(qty × base_price, k × floor), the floor being
-- farm_order_harvest_floor_share() × the median candidate's harvest value;
-- farm_order_lines_value() prices off it. fill_farm_order() ignores it.
CREATE OR REPLACE FUNCTION public.farm_order_pick_lines(
  p_n integer, p_kmin integer, p_kmax integer, p_mode text, p_exclude_species text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_lines jsonb := '[]'::jsonb;
  v_pick  record;
  v_k     integer;
  v_qty   integer;
BEGIN
  FOR v_pick IN
    WITH cand AS (
      SELECT d.species, d.crop_type, d.base_yield
        FROM public.farm_card_defs d
        JOIN public.farm_market m ON m.crop_type = d.crop_type
       WHERE d.is_active AND d.edition_size IS NULL
         AND NOT (d.species = ANY (COALESCE(p_exclude_species, ARRAY[]::text[])))
         AND (SELECT count(*) FROM public.farm_collection c
                JOIN public.profiles p ON p.id = c.user_id AND NOT COALESCE(p.is_admin, false)
               WHERE c.species = d.species AND (c.count > 0 OR c.level > 1)) >= 2
    ),
    rev AS (
      SELECT ct.meta->>'crop_type' AS crop_type, sum(ct.delta)::numeric AS coins
        FROM public.coin_transactions ct
       WHERE ct.reason = 'farm_crop_sale' AND ct.delta > 0
         AND ct.created_at > now() - interval '7 days'
       GROUP BY 1
    ),
    tot AS (SELECT GREATEST(1, COALESCE(sum(coins), 0)) AS coins FROM rev),
    stock AS (
      SELECT i.crop_type, count(DISTINCT i.user_id)::numeric AS holders
        FROM public.farm_inventory i
        JOIN public.profiles p ON p.id = i.user_id AND NOT COALESCE(p.is_admin, false)
       WHERE i.expires_at > now() AND i.qty > 0
       GROUP BY 1
    ),
    lvl AS (
      SELECT c.species,
             GREATEST(1, round(percentile_cont(public.farm_order_level_percentile())
                               WITHIN GROUP (ORDER BY c.level)))::integer AS lref
        FROM public.farm_collection c
        JOIN public.profiles p ON p.id = c.user_id AND NOT COALESCE(p.is_admin, false)
       WHERE c.count > 0 OR c.level > 1
       GROUP BY c.species
    ),
    harvest AS (
      SELECT cand.*, m.base_price, COALESCE(lvl.lref, 1) AS lref,
             cand.base_yield * (1 + (COALESCE(lvl.lref, 1) - 1) * 0.5) * m.base_price AS hvalue
        FROM cand
        JOIN public.farm_market m ON m.crop_type = cand.crop_type
        LEFT JOIN lvl ON lvl.species = cand.species
    ),
    med AS (
      SELECT COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY hvalue), 0) AS hv FROM harvest
    )
    SELECT harvest.*, med.hv * public.farm_order_harvest_floor_share() AS floor_value
      FROM harvest
      CROSS JOIN med
      LEFT JOIN rev   ON rev.crop_type   = harvest.crop_type
      LEFT JOIN stock ON stock.crop_type = harvest.crop_type
      CROSS JOIN tot
     WHERE p_mode <> 'stock' OR stock.holders > 0
     ORDER BY power(random(), 1.0 / CASE WHEN p_mode = 'stock' THEN stock.holders
                                         ELSE 1.0 / (COALESCE(rev.coins, 0) / tot.coins + 0.03) END) DESC
     LIMIT p_n
  LOOP
    v_k   := p_kmin + floor(random() * (p_kmax - p_kmin + 1))::integer;
    v_qty := GREATEST(5, ceil(v_pick.base_yield * (1 + (v_pick.lref - 1) * 0.5) * v_k)::integer);
    v_lines := v_lines || jsonb_build_object('crop_type', v_pick.crop_type, 'qty', v_qty,
      'value', round(GREATEST(v_qty * v_pick.base_price, v_k * v_pick.floor_value))::integer);
  END LOOP;
  RETURN v_lines;
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_order_pick_lines(integer, integer, integer, text, text[]) FROM PUBLIC, anon, authenticated;

-- Σ line value (qty × base_price unless the picker floored it): what
-- farm_order_reward() prices.
CREATE OR REPLACE FUNCTION public.farm_order_lines_value(p_lines jsonb)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(sum(COALESCE((l->>'value')::numeric, (l->>'qty')::numeric * m.base_price)), 0)
    FROM jsonb_array_elements(p_lines) l
    JOIN public.farm_market m ON m.crop_type = l->>'crop_type';
$fn$;

REVOKE ALL ON FUNCTION public.farm_order_lines_value(jsonb) FROM PUBLIC, anon, authenticated;


-- ── Generator ──────────────────────────────────────────────────────────────
-- Creates whatever of the day's orders (and the week's 🏛️ order) does not
-- exist yet. Each kind is topped up to its target rather than "all or
-- nothing", so raising a knob — or deploying a new kind mid-day, as on
-- 2026-10-22 — adds orders to a day that already has some, and never touches
-- the ones players are already working on. farm_order_days is the fast path.
-- Concurrency: an advisory lock serialises two first-readers, and
-- UNIQUE (opened_on, slot) is the backstop.
CREATE OR REPLACE FUNCTION public.farm_ensure_daily_orders(p_day date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_customers text[][] := ARRAY[
    ARRAY['🍝','Stołówka G6'],
    ARRAY['🧑‍🍳','Bistro „Pod Serwerownią"'],
    ARRAY['🥗','Dział HR — tydzień zdrowia'],
    ARRAY['🎂','Urodziny prezesa'],
    ARRAY['🏪','Warzywniak Pani Krysi'],
    ARRAY['🍕','Pizzeria „Deadline"'],
    ARRAY['🧃','Automat z sokami na 2. piętrze'],
    ARRAY['🎄','Wigilia firmowa (planowanie z wyprzedzeniem)'],
    ARRAY['🏋️','Siłownia — koktajle białkowe'],
    ARRAY['☕','Kuchnia na 3. piętrze'],
    ARRAY['🎉','Integracja działu IT']
  ];
  v_contract   text;
  v_exclude    text[];
  v_demand     numeric;
  v_slot       integer;
  v_have       integer;
  v_nlines     integer;
  v_lines      jsonb;
  v_pick       record;
  v_qty        integer;
  v_cust       integer;
  v_expires    timestamptz;
  v_week       date;
  v_week_end   timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM public.farm_order_days
              WHERE day = p_day AND version >= public.farm_order_generator_version()) THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('farm_orders:' || p_day::text));
  IF EXISTS (SELECT 1 FROM public.farm_order_days
              WHERE day = p_day AND version >= public.farm_order_generator_version()) THEN
    RETURN;
  END IF;

  -- NULL since the 🏆 Wyzwanie ended (farm-seasonal-end.sql); kept so a revived
  -- contract would again be kept out of the orders.
  v_contract := public.farm_seasonal_species_for_week(public.farm_seasonal_week_start(
                  (p_day::timestamp AT TIME ZONE 'Europe/Warsaw')));
  v_exclude  := array_remove(ARRAY[v_contract], NULL);
  SELECT COALESCE(demand_bps, 10000) / 10000.0 INTO v_demand
    FROM public.farm_market_pressure ORDER BY rolled_at DESC LIMIT 1;
  v_demand  := COALESCE(v_demand, 1.0);
  v_expires := (p_day::timestamp AT TIME ZONE 'Europe/Warsaw')
               + make_interval(hours => public.farm_order_ttl_hours());
  SELECT COALESCE(max(slot), 0) INTO v_slot FROM public.farm_orders WHERE opened_on = p_day;

  -- ── 'mix': 1 line 50%, 2 lines 35%, 3 lines 15% ──────────────────────────
  SELECT count(*) INTO v_have FROM public.farm_orders WHERE opened_on = p_day AND kind = 'mix';
  FOR i IN v_have + 1 .. public.farm_orders_per_day() LOOP
    v_nlines := CASE WHEN random() < 0.50 THEN 1 WHEN random() < 0.70 THEN 2 ELSE 3 END;
    -- 1-line orders ask for 1-3 harvests, 2-line 1-2 each, 3-line 1 each.
    v_lines  := public.farm_order_pick_lines(v_nlines, 1, 4 - v_nlines, 'unsold', v_exclude);
    CONTINUE WHEN jsonb_array_length(v_lines) = 0;   -- nothing fillable today
    v_cust := 1 + floor(random() * array_length(c_customers, 1))::integer;
    v_slot := v_slot + 1;
    INSERT INTO public.farm_orders (opened_on, slot, customer, emoji, lines, reward, demand_bps, expires_at, kind)
    VALUES (p_day, v_slot, c_customers[v_cust][2], c_customers[v_cust][1], v_lines,
            public.farm_order_reward(public.farm_order_lines_value(v_lines), v_demand,
                                     public.farm_order_premium(jsonb_array_length(v_lines))),
            round(v_demand * 10000)::integer, v_expires, 'mix')
    ON CONFLICT (opened_on, slot) DO NOTHING;
  END LOOP;

  -- ── 🚚 'bulk': one crop nobody sells, 3–4 harvests of it ─────────────────
  IF NOT EXISTS (SELECT 1 FROM public.farm_orders WHERE opened_on = p_day AND kind = 'bulk') THEN
    v_lines := public.farm_order_pick_lines(1, 3, 4, 'unsold', v_exclude);
    IF jsonb_array_length(v_lines) > 0 THEN
      v_slot := v_slot + 1;
      INSERT INTO public.farm_orders (opened_on, slot, customer, emoji, lines, reward, demand_bps, expires_at, kind)
      VALUES (p_day, v_slot, 'Hurtownia „Żubr"', '🚚', v_lines,
              public.farm_order_reward(public.farm_order_lines_value(v_lines), v_demand,
                                       public.farm_order_kind_premium('bulk')),
              round(v_demand * 10000)::integer, v_expires, 'bulk')
      ON CONFLICT (opened_on, slot) DO NOTHING;
    END IF;
  END IF;

  -- ── ⚡ 'express': two crops already in someone's barn, until midnight ────
  -- One harvest each. Grown-to-order is impossible (24 h floor), so this one
  -- rewards a varied barn rather than planning.
  IF NOT EXISTS (SELECT 1 FROM public.farm_orders WHERE opened_on = p_day AND kind = 'express') THEN
    v_lines := public.farm_order_pick_lines(2, 1, 1, 'stock', v_exclude);
    IF jsonb_array_length(v_lines) > 0 THEN
      v_slot := v_slot + 1;
      INSERT INTO public.farm_orders (opened_on, slot, customer, emoji, lines, reward, demand_bps, expires_at, kind)
      VALUES (p_day, v_slot, 'Catering na pilne spotkanie zarządu', '⚡', v_lines,
              public.farm_order_reward(public.farm_order_lines_value(v_lines), v_demand,
                                       public.farm_order_kind_premium('express')),
              round(v_demand * 10000)::integer,
              ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Warsaw'), 'express')
      ON CONFLICT (opened_on, slot) DO NOTHING;
    END IF;
  END IF;

  -- ── 💎 'collector': one NFT-crop order ───────────────────────────────────
  -- Candidates: crops grown only by limited-edition cards, held by >= 2
  -- non-admin players. Weighted by 1 + how many instances are PLANTED right
  -- now, and a crop that already has an open collector order goes to the back
  -- (2026-10-22: it asked for 💎 diamond_rose five days running while one was
  -- planted, and nobody filled any of them). Qty is a share of the AVERAGE
  -- harvest of the instances that grow it (stat_yield for bred hybrids, else
  -- base_yield, times level).
  -- ⚠️ "Grown only by limited-edition cards" is enforced by the NOT EXISTS:
  -- the monthly PRL editions (farm-nft-monthly.sql) grow ordinary crops —
  -- 🍍 pineapple, 🥕 carrot — and without it the Kolekcjoner would start
  -- ordering carrots as a premium NFT crop once two players held the edition.
  IF NOT EXISTS (SELECT 1 FROM public.farm_orders WHERE opened_on = p_day AND kind = 'collector') THEN
    SELECT c.crop_type, c.avg_harvest INTO v_pick
      FROM (
        SELECT d.crop_type,
               avg(COALESCE(i.stat_yield, d.base_yield) * (1 + (i.level - 1) * 0.5)) AS avg_harvest,
               count(DISTINCT i.owner_id) AS holders,
               count(t.planted_instance_id) AS planted
          FROM public.farm_nft_instances i
          JOIN public.farm_card_defs d ON d.species = i.species AND d.edition_size IS NOT NULL
          JOIN public.farm_market m ON m.crop_type = d.crop_type
          JOIN public.profiles p ON p.id = i.owner_id AND NOT COALESCE(p.is_admin, false)
          LEFT JOIN public.farm_tiles t ON t.planted_instance_id = i.id
         WHERE NOT EXISTS (SELECT 1 FROM public.farm_card_defs b
                            WHERE b.crop_type = d.crop_type AND b.edition_size IS NULL)
         GROUP BY d.crop_type
      ) c
     WHERE c.holders >= 2
     ORDER BY EXISTS (SELECT 1 FROM public.farm_orders o, jsonb_array_elements(o.lines) l
                       WHERE o.kind = 'collector' AND o.expires_at > now()
                         AND l->>'crop_type' = c.crop_type),
              power(random(), 1.0 / (1 + c.planted)) DESC
     LIMIT 1;

    IF FOUND THEN
      v_qty   := GREATEST(5, ceil(v_pick.avg_harvest * public.farm_order_collector_harvest_share())::integer);
      v_lines := jsonb_build_array(jsonb_build_object('crop_type', v_pick.crop_type, 'qty', v_qty));
      v_slot  := v_slot + 1;
      INSERT INTO public.farm_orders (opened_on, slot, customer, emoji, lines, reward, demand_bps, expires_at, kind)
      VALUES (p_day, v_slot, 'Kolekcjoner z Zarządu', '💎', v_lines,
              public.farm_order_reward(public.farm_order_lines_value(v_lines), v_demand,
                                       public.farm_order_collector_premium()),
              round(v_demand * 10000)::integer, v_expires, 'collector')
      ON CONFLICT (opened_on, slot) DO NOTHING;
    END IF;
  END IF;

  -- ── 🏛️ 'weekly': four crops, Monday → Monday ─────────────────────────────
  -- Stored on its Monday at slot 0. Two harvests of each, or one when the week
  -- has under four days left (the first one, created on a Thursday, did).
  v_week     := date_trunc('week', p_day)::date;
  v_week_end := ((v_week + 7)::timestamp AT TIME ZONE 'Europe/Warsaw');
  IF NOT EXISTS (SELECT 1 FROM public.farm_orders WHERE opened_on = v_week AND kind = 'weekly') THEN
    v_lines := public.farm_order_pick_lines(4,
                 CASE WHEN v_week_end - now() >= interval '4 days' THEN 2 ELSE 1 END,
                 CASE WHEN v_week_end - now() >= interval '4 days' THEN 2 ELSE 1 END,
                 'unsold', v_exclude);
    IF jsonb_array_length(v_lines) > 0 THEN
      INSERT INTO public.farm_orders (opened_on, slot, customer, emoji, lines, reward, demand_bps, expires_at, kind)
      VALUES (v_week, 0, 'Zarząd G6 — zamówienie tygodnia', '🏛️', v_lines,
              public.farm_order_reward(public.farm_order_lines_value(v_lines), v_demand,
                                       public.farm_order_kind_premium('weekly')),
              round(v_demand * 10000)::integer, v_week_end, 'weekly')
      ON CONFLICT (opened_on, slot) DO NOTHING;
    END IF;
  END IF;

  INSERT INTO public.farm_order_days (day, version)
  VALUES (p_day, public.farm_order_generator_version())
  ON CONFLICT (day) DO UPDATE SET version = EXCLUDED.version;
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_ensure_daily_orders(date) FROM PUBLIC, anon, authenticated;


-- ── Read: the board ────────────────────────────────────────────────────────
-- Open orders, who filled them, and — for the caller — what they hold of each
-- line right now. Also the last few days' closed orders for the history strip.
CREATE OR REPLACE FUNCTION public.farm_orders_state()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM public.farm_ensure_daily_orders((now() AT TIME ZONE 'Europe/Warsaw')::date);

  RETURN json_build_object(
    'now', now(),
    'orders', COALESCE((
      SELECT json_agg(json_build_object(
               'id', o.id, 'opened_on', o.opened_on, 'slot', o.slot, 'kind', o.kind,
               'customer', o.customer, 'emoji', o.emoji, 'reward', o.reward,
               'expires_at', o.expires_at,
               'lines', (SELECT json_agg(json_build_object(
                           'crop_type', l->>'crop_type',
                           'qty', (l->>'qty')::integer,
                           'have', COALESCE((SELECT sum(i.qty) FROM public.farm_inventory i
                                              WHERE i.user_id = v_user
                                                AND i.crop_type = l->>'crop_type'
                                                AND i.expires_at > now()), 0)))
                           FROM jsonb_array_elements(o.lines) l),
               'mine', EXISTS (SELECT 1 FROM public.farm_order_fills f
                                WHERE f.order_id = o.id AND f.user_id = v_user),
               'fills', COALESCE((SELECT json_agg(json_build_object('nick', p.nick, 'filled_at', f.filled_at)
                                                  ORDER BY f.filled_at)
                                    FROM public.farm_order_fills f
                                    JOIN public.profiles p ON p.id = f.user_id
                                   WHERE f.order_id = o.id), '[]'::json))
             ORDER BY o.expires_at, o.slot)
        FROM public.farm_orders o
       WHERE o.expires_at > now()
    ), '[]'::json),
    'my_week', (SELECT json_build_object('fills', count(*), 'coins', COALESCE(sum(reward), 0))
                  FROM public.farm_order_fills
                 WHERE user_id = v_user AND filled_at > now() - interval '7 days')
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_orders_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_orders_state() TO authenticated;


-- ── Write: deliver an order ────────────────────────────────────────────────
-- All-or-nothing: every line is taken FIFO (soonest-rotting lot first, the same
-- order sell_crop_to_npc uses) or the whole call raises and nothing moves.
-- Lock order: user advisory lock → inventory lots → farm_user_state (inside the
-- tax autopay) → profiles — the same tail as sell_crop_to_npc, no new cycle.
CREATE OR REPLACE FUNCTION public.fill_farm_order(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user    uuid := auth.uid();
  v_order   public.farm_orders%ROWTYPE;
  v_line    jsonb;
  v_crop    text;
  v_need    integer;
  v_avail   integer;
  v_remain  integer;
  v_take    integer;
  v_lot     record;
  v_tax     json;
  v_net     integer;
  v_coins   integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('farm_order_fill:' || v_user::text));

  SELECT * INTO v_order FROM public.farm_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v_order.expires_at <= now() THEN RAISE EXCEPTION 'order_expired'; END IF;
  IF EXISTS (SELECT 1 FROM public.farm_order_fills WHERE order_id = p_order_id AND user_id = v_user) THEN
    RAISE EXCEPTION 'order_already_filled';
  END IF;

  -- Check every line before touching any lot, so the error names the problem.
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_order.lines) LOOP
    SELECT COALESCE(sum(qty), 0) INTO v_avail FROM public.farm_inventory
     WHERE user_id = v_user AND crop_type = v_line->>'crop_type' AND expires_at > now();
    IF v_avail < (v_line->>'qty')::integer THEN RAISE EXCEPTION 'not_enough_crops'; END IF;
  END LOOP;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_order.lines) LOOP
    v_crop   := v_line->>'crop_type';
    v_need   := (v_line->>'qty')::integer;
    v_remain := v_need;
    FOR v_lot IN
      SELECT id, qty FROM public.farm_inventory
       WHERE user_id = v_user AND crop_type = v_crop AND expires_at > now()
       ORDER BY expires_at, id
       FOR UPDATE
    LOOP
      EXIT WHEN v_remain <= 0;
      v_take := least(v_remain, v_lot.qty);
      IF v_take >= v_lot.qty THEN
        DELETE FROM public.farm_inventory WHERE id = v_lot.id;
      ELSE
        UPDATE public.farm_inventory SET qty = qty - v_take WHERE id = v_lot.id;
      END IF;
      v_remain := v_remain - v_take;
    END LOOP;
    IF v_remain > 0 THEN RAISE EXCEPTION 'not_enough_crops'; END IF;   -- rotted mid-call
  END LOOP;

  INSERT INTO public.farm_order_fills (order_id, user_id, reward) VALUES (p_order_id, v_user, v_order.reward);

  v_tax := public.farm_apply_land_tax_autopay(
    v_user, v_order.reward, 'farm_order_payout',
    jsonb_build_object('order_id', v_order.id, 'customer', v_order.customer));
  v_net := COALESCE((v_tax->>'net')::integer, v_order.reward);

  UPDATE public.profiles SET coins = coins + v_net WHERE id = v_user RETURNING coins INTO v_coins;

  -- Ledger row is GROSS, like farm_crop_sale: the autopay books its own row.
  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, v_order.reward, 'farm_order_payout',
          jsonb_build_object('order_id', v_order.id, 'customer', v_order.customer,
                             'emoji', v_order.emoji, 'lines', v_order.lines,
                             'tax_paid', COALESCE((v_tax->>'tax_paid')::integer, 0), 'net', v_net));

  RETURN json_build_object('ok', true, 'coins', v_coins, 'reward', v_order.reward, 'net', v_net,
    'tax_paid', COALESCE((v_tax->>'tax_paid')::integer, 0),
    'land_tax_debt', COALESCE((v_tax->>'debt')::integer, 0));
END;
$fn$;

REVOKE ALL ON FUNCTION public.fill_farm_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fill_farm_order(uuid) TO authenticated;
