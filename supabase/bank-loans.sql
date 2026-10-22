-- ════════════════════════════════════════════════════════════════════════════
--  Bank G6: 🤝 Kredyt dla rolnika  (2026-10-23)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after bank.sql, farm.sql, farm-robin-hood.sql (farm_net_worth) and
--  bank-casino-share-removed.sql. Idempotent.
--  ⚠️ Supersedes farm_apply_land_tax_autopay() from farm.sql and
--     bank_user_assets() from bank.sql — re-run this after re-running either.
--
--  Owner's brief: a loan for the players behind, built so it cannot speed up
--  the ones already ahead.
--
--   • WHO: only a player whose net worth (farm_net_worth: cash + every asset)
--     is BELOW the median of the players active in the last 14 days. The top
--     half of the office never qualifies, however much they would like to.
--   • HOW MUCH: what you can repay — 7 days of your own recent income (crop
--     sales + order payouts + zen watering over 14 days ÷ 14), clamped to
--     5,000–30,000. Someone who only waters still gets 5,000.
--   • COST: a flat 10% fee added once at signing. No interest, no compounding,
--     no penalty: the land-tax debt spiral (51,596 on one plot) is exactly what
--     this must never become. One open loan at a time; none while in land-tax
--     debt.
--   • REPAYMENT: automatic from farm_apply_land_tax_autopay — the one hook every
--     crop sale, order payout, marketplace sale and buyback already goes through
--     — AFTER land tax: 50% of what is left until the 14-day term, 100% after.
--     Manual repayment any time from cash.
--
--  Coins: a loan mints its principal as cash and books the same amount (plus
--  the fee) as a NEGATIVE Bank asset in bank_user_assets(), so net worth drops
--  by exactly the fee on signing and nobody climbs the leaderboard on credit.
--  Repayments burn; over a full loan the Bank is a net sink of the fee.
--  Coin reasons 'bank_loan_open' / 'bank_loan_repay' are wired into tabs/stats.js
--  (NEUTRAL + labels). They are deliberately NOT in ACT_COIN_REASONS: who
--  borrows is nobody else's business.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Policy ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_loan_policy()
RETURNS TABLE (fee_rate numeric, term_days integer, min_limit integer, max_limit integer,
               income_days integer, share_before_due numeric, share_after_due numeric)
LANGUAGE sql IMMUTABLE AS $c$ SELECT 0.10::numeric, 14, 5000, 30000, 7, 0.50::numeric, 1.00::numeric $c$;

-- ── Table ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_loans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  principal   bigint NOT NULL CHECK (principal > 0),
  fee         bigint NOT NULL CHECK (fee >= 0),
  outstanding bigint NOT NULL CHECK (outstanding >= 0),
  repaid      bigint NOT NULL DEFAULT 0,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz NOT NULL,
  closed_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_loans_one_open_idx ON public.bank_loans (user_id) WHERE closed_at IS NULL;

ALTER TABLE public.bank_loans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bank_loans_own" ON public.bank_loans;
CREATE POLICY "bank_loans_own" ON public.bank_loans FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.bank_loans FROM anon, authenticated;
GRANT SELECT ON public.bank_loans TO authenticated;


-- ── Eligibility (also the read model for the UI) ───────────────────────────
CREATE OR REPLACE FUNCTION public.bank_loan_eligibility(p_uid uuid)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  pol      record;
  v_nw     numeric := public.farm_net_worth(p_uid);
  v_median numeric;
  v_income numeric;
  v_limit  integer;
  v_open   public.bank_loans%ROWTYPE;
  v_debt   integer;
  v_reason text := NULL;
BEGIN
  SELECT * INTO pol FROM public.bank_loan_policy();
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY public.farm_net_worth(p.id)) INTO v_median
    FROM public.profiles p
   WHERE NOT COALESCE(p.is_admin, false) AND p.last_active_at > now() - interval '14 days';
  SELECT COALESCE(sum(delta), 0) / 14.0 INTO v_income FROM public.coin_transactions
   WHERE user_id = p_uid AND delta > 0 AND created_at > now() - interval '14 days'
     AND reason IN ('farm_crop_sale', 'farm_order_payout', 'garden_water');
  v_limit := LEAST(pol.max_limit, GREATEST(pol.min_limit,
               (round(v_income * pol.income_days / 500.0) * 500)::integer));
  SELECT * INTO v_open FROM public.bank_loans WHERE user_id = p_uid AND closed_at IS NULL;
  SELECT COALESCE(land_tax_debt, 0) INTO v_debt FROM public.farm_user_state WHERE user_id = p_uid;

  IF v_open.id IS NOT NULL THEN v_reason := 'open_loan';
  ELSIF COALESCE(v_debt, 0) > 0 THEN v_reason := 'tax_debt';
  ELSIF v_median IS NULL OR v_nw >= v_median THEN v_reason := 'above_median';
  END IF;

  RETURN json_build_object(
    'eligible', v_reason IS NULL, 'reason', v_reason,
    'net_worth', round(v_nw), 'median', round(COALESCE(v_median, 0)),
    'daily_income', round(v_income), 'limit', v_limit,
    'fee_rate', pol.fee_rate, 'term_days', pol.term_days,
    'share_before_due', pol.share_before_due, 'share_after_due', pol.share_after_due,
    'min_limit', pol.min_limit, 'max_limit', pol.max_limit, 'income_days', pol.income_days,
    'loan', CASE WHEN v_open.id IS NULL THEN NULL ELSE json_build_object(
              'id', v_open.id, 'principal', v_open.principal, 'fee', v_open.fee,
              'outstanding', v_open.outstanding, 'repaid', v_open.repaid,
              'opened_at', v_open.opened_at, 'due_at', v_open.due_at,
              'overdue', now() > v_open.due_at) END);
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_loan_eligibility(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bank_loan_state()
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT (public.bank_loan_eligibility(auth.uid())::jsonb
          || jsonb_build_object('history', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'principal', principal, 'fee', fee, 'opened_at', opened_at, 'closed_at', closed_at)
               ORDER BY opened_at DESC) FROM (SELECT * FROM public.bank_loans
               WHERE user_id = auth.uid() AND closed_at IS NOT NULL ORDER BY opened_at DESC LIMIT 10) h), '[]'::jsonb)))::json
$fn$;
REVOKE ALL ON FUNCTION public.bank_loan_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_loan_state() TO authenticated;


-- ── Take a loan ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bank_loan_take(p_amount integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user uuid := auth.uid();
  pol    record;
  v_el   json;
  v_fee  bigint;
  v_id   uuid;
  v_coins bigint;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1000 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bank_loan:' || v_user::text));
  SELECT * INTO pol FROM public.bank_loan_policy();
  v_el := public.bank_loan_eligibility(v_user);
  IF NOT (v_el->>'eligible')::boolean THEN RAISE EXCEPTION 'loan_%', v_el->>'reason'; END IF;
  IF p_amount > (v_el->>'limit')::integer THEN RAISE EXCEPTION 'loan_over_limit'; END IF;

  v_fee := ceil(p_amount * pol.fee_rate)::bigint;
  INSERT INTO public.bank_loans (user_id, principal, fee, outstanding, due_at)
  VALUES (v_user, p_amount, v_fee, p_amount + v_fee, now() + make_interval(days => pol.term_days))
  RETURNING id INTO v_id;
  UPDATE public.profiles SET coins = coins + p_amount WHERE id = v_user RETURNING coins INTO v_coins;
  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, p_amount, 'bank_loan_open',
          jsonb_build_object('loan_id', v_id, 'fee', v_fee, 'outstanding', p_amount + v_fee));
  RETURN json_build_object('ok', true, 'loan_id', v_id, 'principal', p_amount, 'fee', v_fee,
                           'outstanding', p_amount + v_fee, 'coins', v_coins);
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_loan_take(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_loan_take(integer) TO authenticated;


-- ── Shared: book a repayment of up to p_amount against the open loan ────────
CREATE OR REPLACE FUNCTION public.bank_loan_apply(p_uid uuid, p_amount bigint, p_source text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_loan public.bank_loans%ROWTYPE;
  v_pay  bigint;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN 0; END IF;
  SELECT * INTO v_loan FROM public.bank_loans WHERE user_id = p_uid AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_pay := LEAST(p_amount, v_loan.outstanding);
  IF v_pay <= 0 THEN RETURN 0; END IF;
  UPDATE public.bank_loans
     SET outstanding = outstanding - v_pay, repaid = repaid + v_pay,
         closed_at = CASE WHEN outstanding - v_pay = 0 THEN now() END
   WHERE id = v_loan.id;
  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (p_uid, -v_pay::integer, 'bank_loan_repay',
          jsonb_build_object('loan_id', v_loan.id, 'source', p_source,
                             'outstanding', v_loan.outstanding - v_pay));
  RETURN v_pay;
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_loan_apply(uuid, bigint, text) FROM PUBLIC, anon, authenticated;

-- Called by farm_apply_land_tax_autopay with what is left after land tax.
-- Only BOOKS the repayment; the caller pays out gross − tax − this.
CREATE OR REPLACE FUNCTION public.bank_loan_collect(p_uid uuid, p_available integer, p_source text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  pol    record;
  v_due  timestamptz;
  v_take bigint;
BEGIN
  IF p_available IS NULL OR p_available <= 0 THEN RETURN 0; END IF;
  SELECT due_at INTO v_due FROM public.bank_loans WHERE user_id = p_uid AND closed_at IS NULL;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT * INTO pol FROM public.bank_loan_policy();
  v_take := floor(p_available * CASE WHEN now() > v_due THEN pol.share_after_due ELSE pol.share_before_due END);
  RETURN public.bank_loan_apply(p_uid, v_take, COALESCE(p_source, 'autopay'))::integer;
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_loan_collect(uuid, integer, text) FROM PUBLIC, anon, authenticated;

-- Manual repayment from cash.
CREATE OR REPLACE FUNCTION public.bank_loan_repay(p_amount integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_coins bigint;
  v_paid  bigint;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_amount IS NULL OR p_amount < 1 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bank_loan:' || v_user::text));
  SELECT coins INTO v_coins FROM public.profiles WHERE id = v_user FOR UPDATE;
  IF v_coins < p_amount THEN RAISE EXCEPTION 'insufficient_coins'; END IF;
  v_paid := public.bank_loan_apply(v_user, p_amount, 'manual');
  IF v_paid = 0 THEN RAISE EXCEPTION 'no_open_loan'; END IF;
  UPDATE public.profiles SET coins = coins - v_paid WHERE id = v_user RETURNING coins INTO v_coins;
  RETURN json_build_object('ok', true, 'paid', v_paid, 'coins', v_coins,
                           'loan', public.bank_loan_eligibility(v_user)->'loan');
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_loan_repay(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_loan_repay(integer) TO authenticated;


-- ── bank.sql's bank_user_assets + the open loan as a NEGATIVE asset ─────────
CREATE OR REPLACE FUNCTION public.bank_user_assets(p_uid uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE((
           SELECT sum(public.bank_deposit_mark(d))
             FROM public.bank_deposits d
            WHERE d.user_id = p_uid AND d.closed_at IS NULL
         ), 0)::numeric
       + COALESCE((
           SELECT sum(h.face_value + public.bank_bond_unpaid_coupons(h))
             FROM public.bank_holdings h
            WHERE h.owner_id = p_uid AND h.kind = 'bond' AND h.redeemed_at IS NULL
         ), 0)::numeric
       + COALESCE((
           SELECT sum(h.purchase_price)
             FROM public.bank_holdings h
            WHERE h.owner_id = p_uid AND h.kind = 'share' AND h.redeemed_at IS NULL
         ), 0)::numeric
       - COALESCE((
           SELECT sum(l.outstanding)
             FROM public.bank_loans l
            WHERE l.user_id = p_uid AND l.closed_at IS NULL
         ), 0)::numeric;
$fn$;


-- ── farm.sql's farm_apply_land_tax_autopay + loan repayment after the tax ──
CREATE OR REPLACE FUNCTION public.farm_apply_land_tax_autopay(p_uid uuid, p_gross integer, p_source text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_debt_before integer := 0;
  v_tax_paid integer := 0;
  v_debt_after integer := 0;
  v_loan_paid integer := 0;
BEGIN
  IF p_gross IS NULL OR p_gross < 0 THEN RAISE EXCEPTION 'bad_amount'; END IF;

  INSERT INTO public.farm_user_state (user_id) VALUES (p_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT land_tax_debt INTO v_debt_before
    FROM public.farm_user_state
   WHERE user_id = p_uid
   FOR UPDATE;
  v_debt_before := COALESCE(v_debt_before, 0);
  v_tax_paid := least(v_debt_before, p_gross);
  v_debt_after := v_debt_before - v_tax_paid;

  IF v_tax_paid > 0 THEN
    UPDATE public.farm_user_state
       SET land_tax_debt = v_debt_after
     WHERE user_id = p_uid;

    INSERT INTO public.farm_land_tax_events
      (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
    VALUES (
      p_uid, 'autopay', v_tax_paid, v_debt_before, v_debt_after,
      public.farm_fair_cap(), public.farm_normal_tile_count(p_uid),
      greatest(0, public.farm_normal_tile_count(p_uid) - public.farm_fair_cap()),
      COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', p_source, 'gross', p_gross)
    );

    IF to_regclass('public.coin_transactions') IS NOT NULL THEN
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (
        p_uid, -v_tax_paid, 'farm_land_tax_autopay',
        COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', p_source, 'gross', p_gross)
      );
    END IF;
  END IF;

  -- bank-loans.sql: what is left after land tax repays an open Bank loan.
  v_loan_paid := public.bank_loan_collect(p_uid, p_gross - v_tax_paid, p_source);

  RETURN json_build_object(
    'gross', p_gross,
    'tax_paid', v_tax_paid,
    'loan_paid', v_loan_paid,
    'net', p_gross - v_tax_paid - v_loan_paid,
    'debt', v_debt_after
  );
END;
$fn$;
