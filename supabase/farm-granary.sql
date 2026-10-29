-- ════════════════════════════════════════════════════════════════════════════
--  🏛️ „Spichlerz biura" — a permanent crop sink at full market value (2026-10-29)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after office-goal-crop-donations.sql (uses farm_crop_market_value() and
--  copies its crop donations in). Idempotent; supersedes nothing.
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  Fair share (farm-fair-share.sql) pays 5% past 2× a player's weekly share. The
--  crop donation to the Wspólny Cel was the one place a pile above that line
--  still counted at FULL value: Kornel gave 24,252 crops worth 126,415 in four
--  days (24–28.10) and the goal closed on 28.10. With no goal open (owner's
--  call: no next goal), that surplus can only sell for 5% or rot.
--
--  The Spichlerz keeps the outlet open forever, with no target: crops are
--  destroyed and counted at qty × spot price (farm_crop_market_value(): the
--  NPC's current effective price, before fair share and collector, no per-sale
--  dip because the market is only READ). The reward is RECOGNITION, never coins:
--  an all-time and a weekly ranking, and a title (farm_granary_titles()) shown
--  in the player window.
--
--  ⚠️ No coin moves, so there is NO coin_transactions row and nothing here is in
--  farm_burn_per_day(), the four frontend coin consumers or economy-stats.sql —
--  the same reasoning as office-goal-crop-donations.sql. Donating cannot raise
--  the NPC budget, and destroying crops mints nothing.
--
--  The 126,493 of crops already given to the Wspólny Cel are copied in once
--  (goal_contribution_id is UNIQUE, so a re-run adds nothing), so the people
--  who carried the first goal start with the credit they earned.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.farm_granary_donations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crop_type            text NOT NULL,
  qty                  integer NOT NULL CHECK (qty > 0),
  value                bigint NOT NULL CHECK (value > 0),
  -- Set only on rows copied from office_goal_contributions (source = 'crops').
  goal_contribution_id uuid UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS farm_granary_user_idx ON public.farm_granary_donations (user_id);
CREATE INDEX IF NOT EXISTS farm_granary_time_idx ON public.farm_granary_donations (created_at DESC);

ALTER TABLE public.farm_granary_donations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "farm_granary_select" ON public.farm_granary_donations;
CREATE POLICY "farm_granary_select" ON public.farm_granary_donations
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.farm_granary_donations FROM anon, authenticated;
GRANT SELECT ON public.farm_granary_donations TO authenticated;

-- One-time carry-over of the Wspólny Cel crop donations.
INSERT INTO public.farm_granary_donations (user_id, crop_type, qty, value, goal_contribution_id, created_at)
SELECT c.user_id, c.crop_type, c.crop_qty, c.amount, c.id, c.created_at
  FROM public.office_goal_contributions c
 WHERE c.source = 'crops' AND c.crop_type IS NOT NULL AND c.crop_qty > 0 AND c.amount > 0
ON CONFLICT (goal_contribution_id) DO NOTHING;


-- ── Titles (policy, served to the client — no client constant) ─────────────
-- All-time donated value thresholds. Kornel's carried-over 126k lands on
-- 🏛️ Gospodarz; 👑 is a long way off on purpose.
CREATE OR REPLACE FUNCTION public.farm_granary_titles()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT '[{"min":5000,"emoji":"🌾","name":"Siewca"},
           {"min":25000,"emoji":"🧺","name":"Żniwiarz"},
           {"min":100000,"emoji":"🏛️","name":"Gospodarz Spichlerza"},
           {"min":500000,"emoji":"👑","name":"Dobrodziej Biura"}]'::jsonb;
$fn$;

CREATE OR REPLACE FUNCTION public.farm_granary_title_for(p_total bigint)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT t FROM jsonb_array_elements(public.farm_granary_titles()) t
   WHERE (t->>'min')::bigint <= COALESCE(p_total, 0)
   ORDER BY (t->>'min')::bigint DESC LIMIT 1;
$fn$;

-- Per-player all-time totals + title. Read by the player window (#pu-overlay).
CREATE OR REPLACE VIEW public.farm_granary_totals
WITH (security_invoker = true) AS
SELECT d.user_id, sum(d.value)::bigint AS total, sum(d.qty)::bigint AS qty,
       public.farm_granary_title_for(sum(d.value)::bigint) AS title
  FROM public.farm_granary_donations d
 GROUP BY d.user_id;
GRANT SELECT ON public.farm_granary_totals TO authenticated;


-- ── Donate ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.donate_crops_to_granary(p_crop_type text, p_qty integer)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user   uuid := auth.uid();
  v_avail  integer;
  v_value  bigint;
  v_left   integer;
  v_take   integer;
  v_lot    record;
  v_total  bigint;
  v_inv    integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'bad_qty'; END IF;

  -- Lock the lots first, then count them: two concurrent donations of the same
  -- pile can't both pass the availability check.
  PERFORM 1 FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now()
   FOR UPDATE;
  SELECT COALESCE(sum(qty), 0) INTO v_avail FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();
  IF v_avail < p_qty THEN RAISE EXCEPTION 'not_enough_crops'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.farm_market WHERE crop_type = p_crop_type) THEN
    RAISE EXCEPTION 'no_market';
  END IF;
  v_value := floor(public.farm_crop_market_value(p_crop_type, p_qty))::bigint;
  IF v_value < 1 THEN RAISE EXCEPTION 'too_small'; END IF;

  -- FIFO by soonest expiry, exactly like a sale.
  v_left := p_qty;
  FOR v_lot IN
    SELECT id, qty FROM public.farm_inventory
     WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now()
     ORDER BY expires_at, id
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := least(v_left, v_lot.qty);
    IF v_take >= v_lot.qty THEN
      DELETE FROM public.farm_inventory WHERE id = v_lot.id;
    ELSE
      UPDATE public.farm_inventory SET qty = qty - v_take WHERE id = v_lot.id;
    END IF;
    v_left := v_left - v_take;
  END LOOP;

  INSERT INTO public.farm_granary_donations (user_id, crop_type, qty, value)
  VALUES (v_user, p_crop_type, p_qty, v_value);

  SELECT COALESCE(sum(value), 0) INTO v_total
    FROM public.farm_granary_donations WHERE user_id = v_user;
  SELECT COALESCE(sum(qty), 0) INTO v_inv FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();

  RETURN json_build_object('ok', true, 'crop_type', p_crop_type, 'donated_qty', p_qty,
                           'value', v_value, 'my_total', v_total,
                           'title', public.farm_granary_title_for(v_total),
                           'inventory_qty', v_inv);
END;
$fn$;

REVOKE ALL ON FUNCTION public.donate_crops_to_granary(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.donate_crops_to_granary(text, integer) TO authenticated;


-- ── Read model ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_granary_state()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH wk AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw')
            AT TIME ZONE 'Europe/Warsaw') AS start_at
  )
  SELECT json_build_object(
    'titles',      public.farm_granary_titles(),
    'total',       (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations),
    'total_qty',   (SELECT COALESCE(sum(qty), 0)   FROM public.farm_granary_donations),
    'week_total',  (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations, wk
                     WHERE created_at >= wk.start_at),
    'my_total',    (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations
                     WHERE user_id = auth.uid()),
    'my_week',     (SELECT COALESCE(sum(value), 0) FROM public.farm_granary_donations, wk
                     WHERE user_id = auth.uid() AND created_at >= wk.start_at),
    'all_time', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.id AS user_id, p.nick, gt.total, gt.qty, gt.title
          FROM public.farm_granary_totals gt
          JOIN public.profiles p ON p.id = gt.user_id
         ORDER BY gt.total DESC LIMIT 20) t), '[]'::json),
    'week', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.id AS user_id, p.nick, sum(d.value)::bigint AS total, sum(d.qty)::bigint AS qty
          FROM public.farm_granary_donations d
          JOIN wk ON d.created_at >= wk.start_at
          JOIN public.profiles p ON p.id = d.user_id
         GROUP BY p.id, p.nick
         ORDER BY sum(d.value) DESC LIMIT 20) t), '[]'::json),
    'recent', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.nick, d.crop_type, d.qty, d.value, d.created_at
          FROM public.farm_granary_donations d
          JOIN public.profiles p ON p.id = d.user_id
         WHERE d.goal_contribution_id IS NULL
         ORDER BY d.created_at DESC LIMIT 10) t), '[]'::json)
  );
$fn$;

REVOKE ALL ON FUNCTION public.farm_granary_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_granary_state() TO authenticated;

