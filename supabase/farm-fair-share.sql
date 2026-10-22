-- ════════════════════════════════════════════════════════════════════════════
--  Farm fair share  (2026-10-22)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER anti-inflation.sql and nft-leveling-rework.sql. Idempotent.
--  ⚠️ Supersedes sell_crop_to_npc() + roll_farm_prices() from anti-inflation.sql
--     and level_up_card() from nft-leveling-rework.sql — RE-RUN THIS after
--     re-running any of those (or farm-collector-perks.sql / farm-price-history.sql,
--     which make you re-run anti-inflation.sql anyway).
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  Measured on prod 2026-10-22: one player (Kornel, cards at L21–28 while the
--  next best averages L17.6) sold 1,886,326 of the ~2.7M crop coins paid in 30
--  days — ~70% of everything the NPC paid out — and held 804,801 cash, 2.3x the
--  next player. Two faults let that happen:
--
--   1. The demand throttle never reached its budget. roll_farm_prices() set
--      demand := 1/pressure, but pressure is measured on revenue that ALREADY
--      carries the previous demand, so the fixed point is
--      revenue = sqrt(budget × unthrottled revenue), not budget. The pressure log
--      sat at 1.4–2.0x budget every single day since 2026-08-28 — the farm minted
--      ~40k/day more than it burned, and output still bought income (as a
--      square root instead of linearly, but never flat as anti-inflation.sql
--      claimed). Fix: an INTEGRAL rule, demand := demand_prev × pressure^−gain,
--      whose only fixed point is pressure = 1. gain 0.2 converges in 2–3 weeks
--      with no overshoot against the 7-day revenue lag (simulated).
--
--   2. The NPC budget is one shared pot, so the biggest grower's volume is
--      everybody else's price cut. Fix: a per-player FAIR SHARE of the budget,
--      fair_share_7d = 7 × budget/day ÷ players who sold in the last 14 days, and
--      a rolling-7-day progressive rate on what a sale is worth at market price:
--          up to 1× fair share   100%
--          1×–2×                  30%
--          above 2×                5%
--      Nothing is nerfed and nobody under their share loses a coin: the cut
--      comes off the top seller's tail, which drops measured pressure, which lifts
--      the demand multiplier, which raises EVERYONE's price. On the last 6 weeks
--      of real sales (static equilibrium at the fixed budget): Kornel −70%,
--      Seb +32%, Maciek +24%, Adam +17%, Ilo +17%, Filip +8%, Yurii −3%, total
--      NPC payout −40% (the inflation fix).
--
--   3. Catch-up level-ups. The players behind are coin-limited, not card-limited
--      (Ilo: 1,590 carrot duplicates at L6). The coin half of level_up_card costs
--      50% while the card is ≥6 levels behind the office's top copy of that
--      species and 25% while ≥15 behind. The leader never qualifies. Cards cost
--      the same.
--
--  The rates and thresholds are TABLE functions read by the client through
--  farm_fairness_state(), so there is no client constant to keep in sync.
--  No new coin reason: the four frontend consumers are untouched.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
--  POLICY — the only hand-set numbers in this file
-- ════════════════════════════════════════════════════════════════════════════

-- Progressive NPC rate. upto_x is in fair shares (NULL = no upper bound).
CREATE OR REPLACE FUNCTION public.farm_fair_share_tiers()
RETURNS TABLE (upto_x numeric, rate numeric)
LANGUAGE sql IMMUTABLE AS $fn$
  VALUES (1.0::numeric, 1.00::numeric), (2.0, 0.30), (NULL, 0.05)
$fn$;

-- Integral gain of the demand throttle (see header §1). Higher converges
-- faster but oscillates against the 7-day revenue lag: 0.7 never settles.
CREATE OR REPLACE FUNCTION public.farm_demand_gain()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$ SELECT 0.20::numeric $fn$;

-- Catch-up discount on the coin cost of level_up_card, by how many levels the
-- card is behind the office's top copy of that species. First match wins.
CREATE OR REPLACE FUNCTION public.farm_catchup_tiers()
RETURNS TABLE (min_gap integer, cost_mult numeric)
LANGUAGE sql IMMUTABLE AS $fn$
  VALUES (15, 0.25::numeric), (6, 0.50::numeric)
$fn$;


-- ════════════════════════════════════════════════════════════════════════════
--  Helpers
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.farm_catchup_cost_mult(p_gap integer)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE((SELECT t.cost_mult FROM public.farm_catchup_tiers() t
                    WHERE p_gap >= t.min_gap ORDER BY t.min_gap DESC LIMIT 1), 1.0)
$fn$;

-- What a sale worth p_value at market price pays, given the seller already sold
-- p_used (at market price) in the trailing 7 days. Piecewise over the tiers.
CREATE OR REPLACE FUNCTION public.farm_fair_share_pay(p_used numeric, p_value numeric, p_share numeric)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  v_a   numeric := GREATEST(0, COALESCE(p_used, 0));
  v_b   numeric := GREATEST(0, COALESCE(p_used, 0)) + GREATEST(0, COALESCE(p_value, 0));
  v_lo  numeric := 0;
  v_hi  numeric;
  v_out numeric := 0;
  t     record;
BEGIN
  IF p_share IS NULL OR p_share <= 0 THEN RETURN p_value; END IF;
  FOR t IN SELECT * FROM public.farm_fair_share_tiers() ORDER BY upto_x NULLS LAST LOOP
    v_hi := COALESCE(t.upto_x * p_share, v_b);
    IF LEAST(v_b, v_hi) > GREATEST(v_a, v_lo) THEN
      v_out := v_out + (LEAST(v_b, v_hi) - GREATEST(v_a, v_lo)) * t.rate;
    END IF;
    v_lo := v_hi;
    EXIT WHEN v_lo >= v_b;
  END LOOP;
  RETURN v_out;
END;
$fn$;

-- Players who sold crops in the last 14 days (the denominator of the share).
CREATE OR REPLACE FUNCTION public.farm_active_farmers()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT GREATEST(1, count(DISTINCT ct.user_id))::integer
    FROM public.coin_transactions ct
    JOIN public.profiles p ON p.id = ct.user_id AND NOT COALESCE(p.is_admin, false)
   WHERE ct.created_at > now() - interval '14 days'
     AND ct.reason = 'farm_crop_sale'
$fn$;

ALTER TABLE public.farm_market_pressure
  ADD COLUMN IF NOT EXISTS farmers integer,
  ADD COLUMN IF NOT EXISTS fair_share_7d bigint;

-- Frozen at each roll (twice a day), so a sale reads one row instead of
-- re-measuring 21 days of burn. Falls back to a live computation until the
-- first roll after this migration.
CREATE OR REPLACE FUNCTION public.farm_fair_share_7d()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(
    (SELECT fair_share_7d FROM public.farm_market_pressure
      ORDER BY rolled_at DESC LIMIT 1),
    (7 * public.farm_npc_budget() / public.farm_active_farmers())::bigint)
$fn$;

-- Market-price value the user sold in the trailing 7 days. Rows from before this
-- migration carry no full_value; their paid delta is the best estimate.
CREATE OR REPLACE FUNCTION public.farm_fair_share_used(p_user uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(sum(COALESCE((ct.meta->>'full_value')::numeric, ct.delta)), 0)
    FROM public.coin_transactions ct
   WHERE ct.user_id = p_user
     AND ct.created_at > now() - interval '7 days'
     AND ct.reason = 'farm_crop_sale'
$fn$;

REVOKE ALL ON FUNCTION public.farm_active_farmers()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_fair_share_7d()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.farm_fair_share_used(uuid)   FROM PUBLIC, anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  sell_crop_to_npc — anti-inflation.sql's copy + the fair-share rate
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.sell_crop_to_npc(p_crop_type text, p_qty integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_mkt       public.farm_market%ROWTYPE;
  v_event     public.farm_seasonal_events%ROWTYPE;
  v_has_event boolean := false;
  v_event_from timestamptz;
  v_event_to   timestamptz;
  v_event_qty  integer := 0;
  -- anti-inflation.sql: the premium is capped per player per week; v_event_qty
  -- stays the FULL eligible quantity (ranks + community bar), v_event_paid_qty
  -- is the slice that actually earns bonus_per_unit.
  v_event_paid_qty integer := 0;
  v_event_prev_qty integer := 0;
  v_event_cap  integer := 0;
  v_event_bonus integer := 0;
  v_event_net   integer := 0;
  v_event_tax_paid integer := 0;
  v_avail     integer;
  v_inv       integer;
  v_remain    integer;
  v_take      integer;
  v_floor     numeric;
  v_anchor    numeric;
  v_cur_eff   numeric;
  v_dropfrac  numeric;
  v_price     numeric;
  v_proceeds  numeric;
  v_hours     numeric;
  v_coins     integer;
  v_pay       integer;
  v_tax       json;
  v_tax_paid  integer := 0;
  v_net_pay   integer := 0;
  v_debt      integer := 0;
  v_lot       record;
  v_collector numeric := 0;   -- Lever 3: collector's-reputation NPC premium
  -- farm-fair-share.sql: progressive rate past the player's share of the budget
  v_full      integer;
  v_share     bigint;
  v_used      numeric;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'bad_qty'; END IF;

  SELECT * INTO v_mkt FROM public.farm_market WHERE crop_type = p_crop_type FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_market'; END IF;

  IF public.farm_seasonal_week_start(now()) >= DATE '2026-07-06'
     AND public.farm_seasonal_species_for_week(public.farm_seasonal_week_start(now())) IS NOT NULL THEN
    v_event := public.ensure_farm_seasonal_event(public.farm_seasonal_week_start(now()));
    IF v_event.crop_type = p_crop_type THEN
      v_has_event := true;
      v_event_from := v_event.week_start::timestamp AT TIME ZONE 'Europe/Warsaw';
      v_event_to := (v_event.week_start + 7)::timestamp AT TIME ZONE 'Europe/Warsaw';
    END IF;
  END IF;

  SELECT COALESCE(sum(qty), 0) INTO v_avail FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();
  IF v_avail < p_qty THEN RAISE EXCEPTION 'not_enough_crops'; END IF;

  v_remain := p_qty;
  FOR v_lot IN
    SELECT id, qty, harvested_at FROM public.farm_inventory
     WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now()
     ORDER BY expires_at, id
     FOR UPDATE
  LOOP
    EXIT WHEN v_remain <= 0;
    v_take := least(v_remain, v_lot.qty);

    IF v_has_event
       AND v_lot.harvested_at >= v_event_from
       AND v_lot.harvested_at < v_event_to THEN
      v_event_qty := v_event_qty + v_take;
    END IF;

    IF v_take >= v_lot.qty THEN
      DELETE FROM public.farm_inventory WHERE id = v_lot.id;
    ELSE
      UPDATE public.farm_inventory SET qty = qty - v_take WHERE id = v_lot.id;
    END IF;
    v_remain := v_remain - v_take;
  END LOOP;

  -- ── Weekly contract premium: cap the PAID slice ──────────────────────────
  -- bonus_per_unit is derived so a fair-share LEVEL-1 farmer nets
  -- farm_seasonal_target_daily_coins() per tile per day, then was paid on
  -- unlimited units. Real output runs 20-30x fair_cap_user_units, so the top
  -- two players collected ~25x the designed premium every week while everyone
  -- under the cap was unaffected. Sales still count in full toward the bar and
  -- the rank race — only the coin premium is bounded.
  IF v_has_event AND v_event_qty > 0 THEN
    SELECT COALESCE(sum(s.premium_qty), 0)::integer INTO v_event_prev_qty
      FROM public.farm_seasonal_event_sales s
     WHERE s.event_id = v_event.id AND s.user_id = v_user;
    v_event_cap := GREATEST(0, floor(v_event.fair_cap_user_units
                                     * public.farm_seasonal_premium_cap_x())::integer
                               - v_event_prev_qty);
    v_event_paid_qty := LEAST(v_event_qty, v_event_cap);
  END IF;

  v_anchor  := COALESCE(v_mkt.anchor_price, v_mkt.base_price);
  -- anti-inflation.sql: the floor moves with the demand multiplier, otherwise
  -- a saturated market would just bottom out at the old flat 30%-of-base and
  -- the throttle would do nothing. NULL = a market row that predates the
  -- migration, so fall back to the original constant.
  v_floor   := COALESCE(v_mkt.floor_price, v_mkt.base_price * 0.30);
  v_hours   := EXTRACT(EPOCH FROM (now() - v_mkt.last_decay_at)) / 3600.0;
  v_cur_eff := v_mkt.cur_price + (v_anchor - v_mkt.cur_price) * least(1, v_hours * 0.12);
  IF v_cur_eff < v_floor THEN v_cur_eff := v_floor; END IF;

  v_dropfrac := least(0.40, 0.005 * p_qty);
  v_price    := greatest(v_floor, v_cur_eff * (1 - v_dropfrac));

  -- Lever 3: better NPC price the more varied the seller's NFT collection is.
  v_collector := public.farm_collector_bonus(v_user);
  v_proceeds := p_qty * ((v_cur_eff + v_price) / 2.0) * (1 + v_collector);

  UPDATE public.farm_market
     SET cur_price = v_price, total_sold = total_sold + p_qty, last_decay_at = now()
   WHERE crop_type = p_crop_type;

  -- farm-fair-share.sql: v_full is what the sale is worth at market price;
  -- v_pay is what the progressive fair-share rate lets through. The lock
  -- serialises one seller's concurrent sales of DIFFERENT crops (the market row
  -- lock above only covers one crop), or both would read the same v_used.
  PERFORM pg_advisory_xact_lock(hashtext('farm_fair_share'), hashtext(v_user::text));
  v_full  := round(v_proceeds)::integer;
  v_share := public.farm_fair_share_7d();
  v_used  := public.farm_fair_share_used(v_user);
  v_pay   := round(public.farm_fair_share_pay(v_used, v_full, v_share))::integer;
  v_tax := public.farm_apply_land_tax_autopay(
    v_user, v_pay, 'farm_crop_sale',
    jsonb_build_object('crop_type', p_crop_type, 'qty', p_qty)
  );
  v_tax_paid := COALESCE((v_tax->>'tax_paid')::integer, 0);
  v_net_pay := COALESCE((v_tax->>'net')::integer, v_pay);
  v_debt := COALESCE((v_tax->>'debt')::integer, 0);

  UPDATE public.profiles SET coins = coins + v_net_pay WHERE id = v_user
  RETURNING coins INTO v_coins;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, v_pay, 'farm_crop_sale',
            jsonb_build_object('crop_type', p_crop_type, 'qty', p_qty,
                               'cur_price', round(v_cur_eff, 2),
                               'unit_price', round(v_pay::numeric / p_qty, 2),
                               'collector_bonus', round(v_collector, 4),
                               'full_value', v_full, 'fair_share_7d', v_share,
                               'fair_share_used', round(v_used),
                               'tax_paid', v_tax_paid, 'net', v_net_pay));
  END IF;

  -- Enter on v_event_qty (not the paid slice) so a seller past their premium
  -- cap still shows up in the rank race and still pushes the community bar.
  IF v_has_event AND v_event_qty > 0 THEN
    IF v_event_paid_qty > 0 AND v_event.bonus_per_unit > 0 THEN
      -- „Sezonowy Łowca" (farm-achievements.sql) tops up the contract premium.
      v_event_bonus := round(v_event_paid_qty * v_event.bonus_per_unit
                             * (1 + COALESCE(public.farm_seasonal_bonus(v_user), 0)))::integer;
      v_tax := public.farm_apply_land_tax_autopay(
        v_user, v_event_bonus, 'farm_seasonal_contract_bonus',
        jsonb_build_object('event_id', v_event.id, 'week_start', v_event.week_start,
                           'crop_type', p_crop_type, 'qty', v_event_paid_qty,
                           'bonus_per_unit', v_event.bonus_per_unit)
      );
      v_event_tax_paid := COALESCE((v_tax->>'tax_paid')::integer, 0);
      v_event_net := COALESCE((v_tax->>'net')::integer, v_event_bonus);
      v_debt := COALESCE((v_tax->>'debt')::integer, v_debt);

      UPDATE public.profiles SET coins = coins + v_event_net WHERE id = v_user
      RETURNING coins INTO v_coins;
    END IF;

    INSERT INTO public.farm_seasonal_event_sales
      (event_id, user_id, crop_type, qty, premium_qty, event_bonus, tax_paid, net_bonus, meta)
    VALUES
      (v_event.id, v_user, p_crop_type, v_event_qty, v_event_paid_qty, v_event_bonus,
       v_event_tax_paid, v_event_net,
       jsonb_build_object('bonus_per_unit', v_event.bonus_per_unit,
                          'premium_cap_x', public.farm_seasonal_premium_cap_x(),
                          'premium_capped', (v_event_paid_qty < v_event_qty),
                          'normal_sale_qty', p_qty,
                          'normal_sale_coins', v_pay));

    IF v_event_bonus > 0 AND to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (v_user, v_event_bonus, 'farm_seasonal_contract_bonus',
              jsonb_build_object('event_id', v_event.id, 'week_start', v_event.week_start,
                                 'crop_type', p_crop_type, 'qty', v_event_paid_qty,
                                 'eligible_qty', v_event_qty,
                                 'bonus_per_unit', v_event.bonus_per_unit,
                                 'tax_paid', v_event_tax_paid, 'net', v_event_net));
    END IF;
  END IF;

  SELECT COALESCE(sum(qty), 0) INTO v_inv FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();

  RETURN json_build_object('ok', true, 'coins', v_coins, 'crop_type', p_crop_type,
    'sold', p_qty, 'proceeds', v_pay, 'full_value', v_full,
    'fair_share_7d', v_share, 'fair_share_used', round(v_used) + v_full, 'net', v_net_pay, 'tax_paid', v_tax_paid,
    'land_tax_debt', v_debt, 'cur_price', round(v_price, 2), 'last_decay_at', now(),
    'inventory_qty', v_inv,
    'collector_bonus_pct', round(v_collector * 100)::integer,
    'seasonal_event_id', CASE WHEN v_has_event THEN v_event.id ELSE NULL END,
    'event_counted_qty', v_event_qty, 'event_paid_qty', v_event_paid_qty,
    'event_premium_cap_left', GREATEST(0, v_event_cap - v_event_paid_qty),
    'event_bonus', v_event_bonus,
    'event_net', v_event_net, 'event_tax_paid', v_event_tax_paid);
END;
$$;

REVOKE ALL ON FUNCTION public.sell_crop_to_npc(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sell_crop_to_npc(text, integer) TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  roll_farm_prices — anti-inflation.sql's copy + the integral demand rule
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.roll_farm_prices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  m          public.farm_market%ROWTYPE;
  r          numeric;
  mult       numeric;
  v_lo       numeric;
  v_hi       numeric;
  v_glide    numeric;
  v_burn     bigint;
  v_budget   bigint;
  v_revenue  bigint;
  v_players  integer;
  v_pressure numeric;
  v_target   numeric;
  v_demand   numeric;
  v_prev     numeric;
  v_total    numeric;
  v_crops    integer;
  v_share    numeric;
  v_fair     numeric;
  v_skew     numeric;
  v_exp      numeric := public.farm_crop_skew_exponent();
  v_farmers  integer := public.farm_active_farmers();
BEGIN
  SELECT lo, hi, glide INTO v_lo, v_hi, v_glide FROM public.farm_demand_bounds();

  v_burn    := public.farm_burn_per_day();
  v_budget  := GREATEST(1, public.farm_npc_budget());
  v_revenue := public.farm_revenue_per_day();

  SELECT GREATEST(1, count(DISTINCT ct.user_id))::integer INTO v_players
    FROM public.coin_transactions ct
    JOIN public.profiles p ON p.id = ct.user_id AND NOT COALESCE(p.is_admin, false)
   WHERE ct.created_at > now() - interval '14 days';

  v_pressure := v_revenue::numeric / v_budget;

  -- Glide: at most `glide` of movement per roll, so a swing (deployment day
  -- included) takes days rather than landing as a cliff. Also damps the loop.
  SELECT demand_bps / 10000.0 INTO v_prev
    FROM public.farm_market_pressure ORDER BY rolled_at DESC LIMIT 1;
  v_prev := COALESCE(v_prev, v_hi);

  -- farm-fair-share.sql: INTEGRAL rule. The old 1/(1+max(0,p-1)) ignored that
  -- p is measured on revenue already carrying v_prev, so it settled at
  -- revenue = sqrt(budget x unthrottled) — 1.4-2.0x budget for two months.
  -- d x p^-gain has exactly one fixed point, p = 1.
  IF v_pressure <= 0 THEN
    v_target := v_hi;
  ELSE
    v_target := LEAST(v_hi, GREATEST(v_lo, v_prev * power(v_pressure, -public.farm_demand_gain())));
  END IF;
  v_demand := LEAST(v_prev + v_glide, GREATEST(v_prev - v_glide, v_target));
  v_demand := LEAST(v_hi, GREATEST(v_lo, v_demand));

  -- now() is transaction time, so a manual double-roll (or the hourly gate
  -- firing twice inside one hour) would otherwise abort on the PK. One row per
  -- roll INSTANT is the intent, and the last write is the one whose prices the
  -- market actually ended up with.
  INSERT INTO public.farm_market_pressure
    (rolled_at, burn_per_day, budget_per_day, revenue_per_day, participants,
     pressure_bps, demand_bps, target_bps, farmers, fair_share_7d)
  VALUES (now(), v_burn, v_budget, v_revenue, v_players,
          round(v_pressure * 10000)::integer,
          round(v_demand * 10000)::integer,
          round(v_target * 10000)::integer,
          v_farmers, (7 * v_budget / v_farmers)::bigint)
  ON CONFLICT (rolled_at) DO UPDATE SET
    burn_per_day    = EXCLUDED.burn_per_day,
    budget_per_day  = EXCLUDED.budget_per_day,
    revenue_per_day = EXCLUDED.revenue_per_day,
    participants    = EXCLUDED.participants,
    pressure_bps    = EXCLUDED.pressure_bps,
    demand_bps      = EXCLUDED.demand_bps,
    target_bps      = EXCLUDED.target_bps,
    farmers         = EXCLUDED.farmers,
    fair_share_7d   = EXCLUDED.fair_share_7d;

  -- Per-crop skew, centred on an equal share of the budget. The global demand
  -- term does the work; this only decides WHO carries it, so that a small
  -- player's single crystal_lotus tile is not punished for a grape glut they
  -- had no part in. Set farm_crop_skew_exponent() to 0 to switch it off.
  SELECT COALESCE(sum(x.v), 0), GREATEST(1, count(*))
    INTO v_total, v_crops
    FROM (SELECT (ct.meta->>'crop_type') AS c, sum(ct.delta)::numeric AS v
            FROM public.coin_transactions ct
           WHERE ct.created_at > now() - interval '7 days'
             AND ct.reason = 'farm_crop_sale' AND ct.delta > 0
             AND ct.meta ? 'crop_type'
           GROUP BY 1) x;
  v_fair := 1.0 / v_crops;

  FOR m IN SELECT * FROM public.farm_market FOR UPDATE LOOP
    r := random();
    -- regime → multiplier of base_price
    IF    r < 0.45 THEN mult := 0.30 + random() * 0.20;   -- low   45%: 0.30–0.50
    ELSIF r < 0.78 THEN mult := 0.50 + random() * 0.22;   -- mid   33%: 0.50–0.72
    ELSIF r < 0.95 THEN mult := 0.72 + random() * 0.18;   -- high  17%: 0.72–0.90
    ELSE                mult := 0.90 + random() * 0.10;   -- spike  5%: 0.90–1.00
    END IF;

    v_skew := 1.0;
    IF v_exp > 0 AND v_total > 0 THEN
      SELECT COALESCE(sum(ct.delta), 0)::numeric / v_total INTO v_share
        FROM public.coin_transactions ct
       WHERE ct.created_at > now() - interval '7 days'
         AND ct.reason = 'farm_crop_sale' AND ct.delta > 0
         AND ct.meta->>'crop_type' = m.crop_type;
      IF v_share > 0 THEN
        v_skew := LEAST(1.25, GREATEST(0.75, power(v_fair / v_share, v_exp)));
      END IF;
    END IF;

    UPDATE public.farm_market
       SET anchor_price  = round(base_price * mult * v_demand * v_skew, 2),
           cur_price     = round(base_price * mult * v_demand * v_skew, 2),
           floor_price   = round(base_price * 0.30 * v_demand * v_skew, 2),
           last_decay_at = now()
     WHERE crop_type = m.crop_type;
  END LOOP;
END;
$fn$;

REVOKE ALL ON FUNCTION public.roll_farm_prices() FROM PUBLIC, anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  level_up_card — nft-leveling-rework.sql's copy + the catch-up discount
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.level_up_card(p_species text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_def          public.farm_card_defs%ROWTYPE;
  v_row          public.farm_collection%ROWTYPE;
  v_dupes_needed integer;
  v_coin_cost    integer;
  v_coins        integer;
  v_top          integer;
  v_mult         numeric;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = p_species;
  IF FOUND AND v_def.edition_size IS NOT NULL THEN RAISE EXCEPTION 'nft_use_level_up_nft'; END IF;

  SELECT * INTO v_row FROM public.farm_collection
   WHERE user_id = v_user AND species = p_species FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_card'; END IF;

  v_dupes_needed := 2 * v_row.level;
  -- farm-fair-share.sql: catch-up discount on the coin half, by how far this
  -- card is behind the office's best copy of the species. The leader pays full.
  SELECT max(c.level) INTO v_top
    FROM public.farm_collection c
    JOIN public.profiles p ON p.id = c.user_id AND NOT COALESCE(p.is_admin, false)
   WHERE c.species = p_species;
  v_mult         := public.farm_catchup_cost_mult(COALESCE(v_top, 0) - v_row.level);
  v_coin_cost    := ceil(50 * v_row.level * v_row.level * v_mult)::integer;

  IF v_row.count < v_dupes_needed THEN RAISE EXCEPTION 'not_enough_cards'; END IF;

  UPDATE public.profiles SET coins = coins - v_coin_cost
   WHERE id = v_user AND coins >= v_coin_cost
  RETURNING coins INTO v_coins;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_coins'; END IF;

  UPDATE public.farm_collection
     SET count = count - v_dupes_needed, level = level + 1
   WHERE user_id = v_user AND species = p_species;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_coin_cost, 'card_levelup', jsonb_build_object('species', p_species, 'new_level', v_row.level + 1,
                                      'catchup_mult', v_mult));
  END IF;

  RETURN json_build_object('ok', true, 'coins', v_coins, 'species', p_species,
    'level', v_row.level + 1, 'count', v_row.count - v_dupes_needed,
    'coin_cost', v_coin_cost, 'catchup_mult', v_mult);
END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
--  Read model for the UI — the sale preview and the level-up cost both price
--  off this, so the policy tables above are the single source of truth.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.farm_fairness_state()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT json_build_object(
    'fair_share_7d', public.farm_fair_share_7d(),
    'used_7d',       round(public.farm_fair_share_used(auth.uid())),
    'farmers',       public.farm_active_farmers(),
    'tiers',   (SELECT json_agg(json_build_object('upto_x', upto_x, 'rate', rate)
                                ORDER BY upto_x NULLS LAST)
                  FROM public.farm_fair_share_tiers()),
    'catchup', (SELECT json_agg(json_build_object('min_gap', min_gap, 'cost_mult', cost_mult)
                                ORDER BY min_gap DESC)
                  FROM public.farm_catchup_tiers()),
    'top_levels', COALESCE((SELECT json_object_agg(species, top) FROM (
        SELECT c.species, max(c.level) AS top
          FROM public.farm_collection c
          JOIN public.profiles p ON p.id = c.user_id AND NOT COALESCE(p.is_admin, false)
         GROUP BY c.species) t), '{}'::json)
  );
$fn$;

REVOKE ALL ON FUNCTION public.farm_fairness_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_fairness_state() TO authenticated;
