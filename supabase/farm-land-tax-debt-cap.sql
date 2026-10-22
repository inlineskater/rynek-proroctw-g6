-- ════════════════════════════════════════════════════════════════════════════
--  Land-tax debt cap  (2026-10-22)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm.sql. Idempotent.
--  ⚠️ Supersedes farm_land_tax_quote_for() and assess_farm_land_tax() from
--     farm.sql — RE-RUN THIS after re-running farm.sql.
--
--  Unpaid land tax used to carry 10%/day interest compounded with no ceiling.
--  Adam ran out of coins on 2026-09-29 holding ONE plot over his fair share
--  (1,000/day). 23 days later he owed 51,596 — 22,000 of tax and 33,726 of
--  interest, growing +4,600/day — every sale went to the debt, so he stopped
--  harvesting and his ripe plots became theft targets. A penalty nobody can
--  ever pay off is not a penalty, it is a player deleted.
--
--  Rule now: the debt never grows past farm_land_tax_debt_cap_days() × the
--  player's own daily tax (14 days → 14,000 for one excess plot). Interest
--  only fills the room below that cap, a player with no excess plots (daily
--  tax 0) accrues nothing, and a debt that is already above the cap is frozen
--  rather than raised. Paying it down and expansion being blocked while in debt
--  are unchanged. The client's tax card reads interest_next/debt_cap from
--  farm_land_tax_quote(), so no client change is needed.
--
--  Also forgives the interest Adam accrued (one-time, guarded by a
--  'forgiveness' event so a re-run does nothing).
--
--  ── Tax relief (2026-10-23) ─────────────────────────────────────────────────
--  ⚠️ Also supersedes farm_land_tax_participant_count() from farm.sql.
--  Measured that day: the fair share was ceil(40 / 11) = 4 plots, but 3 of the
--  11 „participants" had not played since July/August (Maks, De, dupa_szefa),
--  and the flat 1000 × excess² took 5% of Kornel's farm income, 40% of Yurii's,
--  81% of Seb's and 107% of Maciek's. Two changes:
--   1. Only players active in the last farm_land_tax_active_days() (30) count
--      toward the fair share → ceil(40 / 8) = 5 plots each.
--   2. A player's daily tax is capped at farm_land_tax_income_share() (25%) of
--      their own 14-day average farm income (crop sales + order payouts, gross),
--      but never below farm_land_tax_min_per_excess() (250) per extra plot, so
--      an idle plot is never free to hold.
--  Effect on the day: total tax 15,000 → 3,000/day; Filip, Maciek, Adam → 0;
--  Kornel, Yurii, Seb 4,000 → 1,000 (one plot over). Land tax is in
--  farm_burn_per_day(), so the NPC crop budget falls by ~0.9 × the difference —
--  the cost of the relief, accepted by the owner.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.farm_land_tax_active_days()
RETURNS integer LANGUAGE sql IMMUTABLE AS $c$ SELECT 30 $c$;
CREATE OR REPLACE FUNCTION public.farm_land_tax_income_share()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $c$ SELECT 0.25::numeric $c$;
CREATE OR REPLACE FUNCTION public.farm_land_tax_min_per_excess()
RETURNS integer LANGUAGE sql IMMUTABLE AS $c$ SELECT 250 $c$;

-- farm.sql's copy + only players active in the last N days.
CREATE OR REPLACE FUNCTION public.farm_land_tax_participant_count()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $c$
  SELECT greatest(1, COALESCE(count(*), 0))::integer
    FROM public.profiles p
   WHERE NOT p.is_admin
     AND p.last_active_at > now() - make_interval(days => public.farm_land_tax_active_days())
     AND (
       EXISTS (SELECT 1 FROM public.farm_user_state fus WHERE fus.user_id = p.id)
       OR EXISTS (
         SELECT 1 FROM public.farm_tiles ft
          WHERE ft.owner_id = p.id AND ft.acquired_via <> 'migration'
       )
     );
$c$;

-- Average daily farm income over 14 days, gross (what the tax cap scales with).
CREATE OR REPLACE FUNCTION public.farm_land_tax_income_per_day(p_uid uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $c$
  SELECT COALESCE(sum(delta), 0) / 14.0
    FROM public.coin_transactions
   WHERE user_id = p_uid AND delta > 0
     AND created_at > now() - interval '14 days'
     AND reason IN ('farm_crop_sale', 'farm_order_payout');
$c$;
REVOKE ALL ON FUNCTION public.farm_land_tax_income_per_day(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.farm_land_tax_debt_cap_days()
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 14 $fn$;

CREATE OR REPLACE FUNCTION public.farm_land_tax_quote_for(p_uid uuid, p_exclude_listing_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_capacity integer := public.farm_normal_tile_capacity();
  v_participants integer := public.farm_land_tax_participant_count();
  v_cap integer := public.farm_fair_cap();
  v_owned integer := public.farm_normal_tile_count(p_uid);
  v_pending integer := public.farm_land_tax_pending_tiles(p_uid, p_exclude_listing_id);
  v_debt integer := 0;
  v_excess integer := 0;
  v_daily integer := 0;
  v_interest integer := 0;
  v_debt_cap integer := 0;
  v_income numeric := 0;
  v_first_tax_day date := DATE '2026-07-02';
  v_first_payment_day date := DATE '2026-07-03';
BEGIN
  SELECT COALESCE(land_tax_debt, 0) INTO v_debt
    FROM public.farm_user_state
   WHERE user_id = p_uid;
  v_debt := COALESCE(v_debt, 0);
  v_excess := greatest(0, v_owned - v_cap);
  v_daily := 1000 * v_excess * v_excess;
  -- Tax relief: at most 25% of the player's own farm income, never below 250
  -- per extra plot.
  IF v_excess > 0 THEN
    v_income := public.farm_land_tax_income_per_day(p_uid);
    v_daily := LEAST(v_daily, GREATEST(public.farm_land_tax_min_per_excess() * v_excess,
                                       floor(v_income * public.farm_land_tax_income_share())::integer));
  END IF;
  -- farm-land-tax-debt-cap.sql: the debt may never pass the cap (N days of
  -- this player's own daily tax), and interest only fills the room below it.
  -- Without this 10%/day compounded forever: one excess plot = 51,596 owed.
  v_debt_cap := public.farm_land_tax_debt_cap_days() * v_daily;
  v_interest := CASE WHEN v_debt > 0
                     THEN least(ceil(v_debt * 0.10)::integer,
                                greatest(0, v_debt_cap - v_debt - v_daily))
                     ELSE 0 END;

  RETURN json_build_object(
    'normal_capacity', v_capacity,
    'participants', v_participants,
    'fair_cap', v_cap,
    'owned_tiles', v_owned,
    'pending_tiles', v_pending,
    'excess_tiles', v_excess,
    'tax_per_excess_sq', 1000,
    'daily_tax', v_daily,
    'daily_tax_full', 1000 * v_excess * v_excess,
    'income_per_day', round(v_income),
    'income_share', public.farm_land_tax_income_share(),
    'debt', v_debt,
    'interest_next', v_interest,
    'debt_cap', v_debt_cap,
    'first_tax_day', v_first_tax_day,
    'first_payment_day', v_first_payment_day,
    -- Soft cap: buying/planting past the fair share is allowed (excess is taxed
    -- daily); only an unpaid tax debt blocks expansion. Planting is never blocked.
    'blocked_expansion', (v_debt > 0),
    'blocked_planting', false
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.assess_farm_land_tax()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_warsaw_now timestamp := now() AT TIME ZONE 'Europe/Warsaw';
  v_tax_day date := ((now() AT TIME ZONE 'Europe/Warsaw')::date - 1);
  v_first_tax_day date := DATE '2026-07-02';
  v_user uuid;
  v_debt_before integer;
  v_debt_after integer;
  v_daily_tax integer;
  v_interest integer;
  v_due integer;
  v_wallet integer;
  v_wallet_pay integer;
  v_q json;
  v_done integer := 0;
  v_cap integer;
BEGIN
  IF EXTRACT(HOUR FROM v_warsaw_now)::integer <> 0 THEN
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', 'not_midnight_warsaw', 'tax_day', v_tax_day, 'assessed', 0);
  END IF;
  IF v_tax_day < v_first_tax_day THEN
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', 'tax_not_started', 'tax_day', v_tax_day, 'first_tax_day', v_first_tax_day, 'assessed', 0);
  END IF;

  INSERT INTO public.farm_user_state (user_id)
  SELECT p.id
    FROM public.profiles p
   WHERE NOT p.is_admin
     AND (
       EXISTS (SELECT 1 FROM public.farm_user_state fus WHERE fus.user_id = p.id)
       OR EXISTS (
         SELECT 1 FROM public.farm_tiles ft
          WHERE ft.owner_id = p.id AND ft.acquired_via <> 'migration'
       )
     )
  ON CONFLICT (user_id) DO NOTHING;

  FOR v_user IN
    SELECT fus.user_id
      FROM public.farm_user_state fus
      JOIN public.profiles p ON p.id = fus.user_id
     WHERE NOT p.is_admin
     ORDER BY fus.user_id
  LOOP
    SELECT land_tax_debt INTO v_debt_before
      FROM public.farm_user_state
     WHERE user_id = v_user
     FOR UPDATE;

    IF (SELECT land_tax_last_assessed FROM public.farm_user_state WHERE user_id = v_user) = v_tax_day THEN
      CONTINUE;
    END IF;

    v_q := public.farm_land_tax_quote_for(v_user);
    v_daily_tax := COALESCE((v_q->>'daily_tax')::integer, 0);
    v_interest := COALESCE((v_q->>'interest_next')::integer, 0);
    v_due := v_daily_tax + v_interest;
    v_wallet_pay := 0;
    v_debt_after := COALESCE(v_debt_before, 0);

    IF v_due > 0 THEN
      SELECT coins INTO v_wallet FROM public.profiles WHERE id = v_user FOR UPDATE;
      v_wallet_pay := least(COALESCE(v_wallet, 0), v_due);
      IF v_wallet_pay > 0 THEN
        UPDATE public.profiles SET coins = coins - v_wallet_pay WHERE id = v_user;
        IF to_regclass('public.coin_transactions') IS NOT NULL THEN
          INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
          VALUES (
            v_user, -v_wallet_pay, 'farm_land_tax_pay',
            jsonb_build_object('source', 'daily_assessment', 'tax_day', v_tax_day,
                               'daily_tax', v_daily_tax, 'interest', v_interest)
          );
        END IF;
      END IF;
      v_debt_after := v_debt_after + v_due - v_wallet_pay;
      -- farm-land-tax-debt-cap.sql: never grow past the cap. A debt already
      -- above it (from before the cap) is frozen, not raised; it only shrinks.
      v_cap := COALESCE((v_q->>'debt_cap')::integer, 0);
      v_debt_after := least(v_debt_after, greatest(v_cap, COALESCE(v_debt_before, 0)));
    END IF;

    UPDATE public.farm_user_state
       SET land_tax_debt = v_debt_after,
           land_tax_last_assessed = v_tax_day
     WHERE user_id = v_user;

    IF v_daily_tax > 0 THEN
      INSERT INTO public.farm_land_tax_events
        (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
      VALUES (
        v_user, 'daily_tax', v_daily_tax, COALESCE(v_debt_before, 0), v_debt_after,
        COALESCE((v_q->>'fair_cap')::integer, public.farm_fair_cap()),
        COALESCE((v_q->>'owned_tiles')::integer, public.farm_normal_tile_count(v_user)),
        COALESCE((v_q->>'excess_tiles')::integer, 0),
        jsonb_build_object('tax_day', v_tax_day, 'wallet_paid', v_wallet_pay)
      );
    END IF;

    IF v_interest > 0 THEN
      INSERT INTO public.farm_land_tax_events
        (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
      VALUES (
        v_user, 'interest', v_interest, COALESCE(v_debt_before, 0), v_debt_after,
        COALESCE((v_q->>'fair_cap')::integer, public.farm_fair_cap()),
        COALESCE((v_q->>'owned_tiles')::integer, public.farm_normal_tile_count(v_user)),
        COALESCE((v_q->>'excess_tiles')::integer, 0),
        jsonb_build_object('tax_day', v_tax_day, 'wallet_paid', v_wallet_pay)
      );
    END IF;

    v_done := v_done + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'tax_day', v_tax_day, 'assessed', v_done);
END;
$fn$;


-- ── One-time: forgive Adam's accrued interest ───────────────────────────────
ALTER TABLE public.farm_land_tax_events DROP CONSTRAINT IF EXISTS farm_land_tax_events_event_type_check;
ALTER TABLE public.farm_land_tax_events ADD CONSTRAINT farm_land_tax_events_event_type_check
  CHECK (event_type = ANY (ARRAY['daily_tax','interest','manual_payment','autopay','forgiveness']));

DO $$
DECLARE
  v_user uuid := 'abcc830e-797b-44e0-8b44-c7545c0172e1';   -- Adam
  v_since timestamptz := '2026-09-30';                       -- first day in debt
  v_before integer;
  v_after integer;
  v_tax integer;
  v_paid integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.farm_land_tax_events
              WHERE user_id = v_user AND event_type = 'forgiveness') THEN
    RETURN;
  END IF;
  SELECT land_tax_debt INTO v_before FROM public.farm_user_state WHERE user_id = v_user FOR UPDATE;
  IF COALESCE(v_before, 0) <= 0 THEN RETURN; END IF;

  -- What he owes without interest: every daily tax charged since he went into
  -- debt, minus everything his wallet and sales paid in that time (applied to
  -- tax first). Autopay rows carry no wallet_paid; their amount IS the payment.
  SELECT COALESCE(sum(amount) FILTER (WHERE event_type = 'daily_tax'), 0),
         COALESCE(sum((meta->>'wallet_paid')::integer) FILTER (WHERE event_type = 'daily_tax'), 0)
       + COALESCE(sum(amount) FILTER (WHERE event_type IN ('autopay','manual_payment')), 0)
    INTO v_tax, v_paid
    FROM public.farm_land_tax_events
   WHERE user_id = v_user AND created_at >= v_since;
  v_after := least(v_before, greatest(0, v_tax - v_paid));

  UPDATE public.farm_user_state SET land_tax_debt = v_after WHERE user_id = v_user;
  INSERT INTO public.farm_land_tax_events
    (user_id, event_type, amount, debt_before, debt_after, fair_cap, owned_tiles, excess_tiles, meta)
  VALUES (v_user, 'forgiveness', v_before - v_after, v_before, v_after,
          public.farm_fair_cap(), public.farm_normal_tile_count(v_user),
          greatest(0, public.farm_normal_tile_count(v_user) - public.farm_fair_cap()),
          jsonb_build_object('reason', 'interest forgiven when the debt cap shipped',
                             'tax_since', v_since, 'tax', v_tax, 'paid', v_paid));
END $$;
