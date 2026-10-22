-- ════════════════════════════════════════════════════════════════════════════
--  Crop donations to the Wspólny Cel Biura  (2026-10-22)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after office-goals.sql and farm-fair-share.sql. Idempotent.
--  ⚠️ Supersedes office_goal_state() from office-goals.sql — re-run this after
--     re-running that.
--
--  Fair share (farm-fair-share.sql) made crops past 2× a player's share sell
--  for 5%. The top grower now sits on a pile with almost no coin value, while
--  the communal goal had stalled at 10,069 / 150,000. A donation turns the pile
--  into goal progress at FULL market value:
--
--    value = qty × spot price   — the NPC's current effective price for the crop
--            (recovered toward the anchor, never below the floor), BEFORE the
--            fair-share rate and WITHOUT the collector premium (an NPC bonus,
--            not value).
--
--  No per-sale dip: the market row is only READ, nothing is sold, so the price
--  never moves — and a dip that never happens would only reward splitting one
--  donation into a hundred 1-unit donations. The NPC budget is not spent. No coin moves either way — the crops are
--  destroyed and the goal counter goes up — so there is NO coin_transactions row
--  and donations stay out of farm_burn_per_day(): funding the goal with crops
--  must not raise the NPC budget the way burning coins does, or a crop could be
--  donated into higher prices for the next one. The four frontend coin
--  consumers are untouched.
--
--  Open to every player, not only those past their share: below the share a
--  donation is simply a worse deal than selling, which the UI says.
--  The last donation is clamped like a coin contribution: only as many units
--  as the goal still needs are taken.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.office_goal_contributions
  ADD COLUMN IF NOT EXISTS source    text NOT NULL DEFAULT 'coins',
  ADD COLUMN IF NOT EXISTS crop_type text,
  ADD COLUMN IF NOT EXISTS crop_qty  integer;

DO $$
BEGIN
  ALTER TABLE public.office_goal_contributions
    ADD CONSTRAINT office_goal_contributions_source_check
    CHECK (source IN ('coins', 'crops')
           AND (source = 'coins' OR (crop_type IS NOT NULL AND crop_qty > 0)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- p_qty units at the NPC's current effective spot price (the starting price of
-- sell_crop_to_npc's quote), before fair share and collector. Client mirror:
-- farmDonationValue().
CREATE OR REPLACE FUNCTION public.farm_crop_market_value(p_crop_type text, p_qty integer)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  m       public.farm_market%ROWTYPE;
  v_floor numeric;
  v_cur   numeric;
BEGIN
  SELECT * INTO m FROM public.farm_market WHERE crop_type = p_crop_type;
  IF NOT FOUND OR p_qty IS NULL OR p_qty < 1 THEN RETURN 0; END IF;
  v_floor := COALESCE(m.floor_price, m.base_price * 0.30);
  v_cur   := m.cur_price + (COALESCE(m.anchor_price, m.base_price) - m.cur_price)
             * least(1, EXTRACT(EPOCH FROM (now() - m.last_decay_at)) / 3600.0 * 0.12);
  IF v_cur < v_floor THEN v_cur := v_floor; END IF;
  RETURN p_qty * v_cur;
END;
$fn$;

REVOKE ALL ON FUNCTION public.farm_crop_market_value(text, integer) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.donate_crops_to_office_goal(p_crop_type text, p_qty integer)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user      uuid := auth.uid();
  v_goal      public.office_goals%ROWTYPE;
  v_remaining bigint;
  v_avail     integer;
  v_qty       integer := p_qty;
  v_value     bigint;
  v_take      integer;
  v_left      integer;
  v_lot       record;
  v_completed boolean := false;
  v_my        bigint;
  v_inv       integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'bad_qty'; END IF;

  -- Same lock as office_goal_contribute, taken first: one writer on the counter.
  PERFORM pg_advisory_xact_lock(hashtext('office_goal_contribute'));

  SELECT * INTO v_goal FROM public.office_goals WHERE status = 'open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_open_goal'; END IF;
  v_remaining := v_goal.target_coins - v_goal.raised_coins;
  IF v_remaining < 1 THEN RAISE EXCEPTION 'goal_already_funded'; END IF;

  SELECT COALESCE(sum(qty), 0) INTO v_avail FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();
  IF v_avail < v_qty THEN RAISE EXCEPTION 'not_enough_crops'; END IF;

  v_value := floor(public.farm_crop_market_value(p_crop_type, v_qty))::bigint;
  IF v_value < 1 THEN RAISE EXCEPTION 'no_market'; END IF;

  -- Never take more crops than the goal still needs: the fewest units that
  -- cover what is left, and the last one only counts up to the target.
  IF v_value > v_remaining THEN
    v_qty := GREATEST(1, ceil(v_remaining / public.farm_crop_market_value(p_crop_type, 1))::integer);
    v_value := LEAST(v_remaining, floor(public.farm_crop_market_value(p_crop_type, v_qty))::bigint);
  END IF;

  -- FIFO by soonest expiry, exactly like a sale.
  v_left := v_qty;
  FOR v_lot IN
    SELECT id, qty FROM public.farm_inventory
     WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now()
     ORDER BY expires_at, id
     FOR UPDATE
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

  INSERT INTO public.office_goal_contributions (goal_id, user_id, amount, source, crop_type, crop_qty)
  VALUES (v_goal.id, v_user, v_value, 'crops', p_crop_type, v_qty);

  UPDATE public.office_goals
     SET raised_coins = raised_coins + v_value,
         status       = CASE WHEN raised_coins + v_value >= target_coins THEN 'completed' ELSE status END,
         completed_at = CASE WHEN raised_coins + v_value >= target_coins THEN now() ELSE completed_at END
   WHERE id = v_goal.id
  RETURNING (status = 'completed') INTO v_completed;

  SELECT COALESCE(sum(amount), 0) INTO v_my
    FROM public.office_goal_contributions
   WHERE goal_id = v_goal.id AND user_id = v_user;
  SELECT COALESCE(sum(qty), 0) INTO v_inv FROM public.farm_inventory
   WHERE user_id = v_user AND crop_type = p_crop_type AND expires_at > now();

  RETURN json_build_object('ok', true, 'crop_type', p_crop_type, 'donated_qty', v_qty,
                           'value', v_value, 'my_total', v_my, 'completed', v_completed,
                           'raised', v_goal.raised_coins + v_value,
                           'target', v_goal.target_coins, 'inventory_qty', v_inv);
END;
$fn$;

REVOKE ALL ON FUNCTION public.donate_crops_to_office_goal(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.donate_crops_to_office_goal(text, integer) TO authenticated;


-- office-goals.sql's copy + how much of each contribution came in crops.
CREATE OR REPLACE FUNCTION public.office_goal_state()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH g AS (
    SELECT * FROM public.office_goals
     ORDER BY (status = 'open') DESC, COALESCE(completed_at, opened_at) DESC
     LIMIT 1
  )
  SELECT json_build_object(
    'goal', (SELECT row_to_json(x) FROM (
       SELECT g.id, g.code, g.title, g.subtitle, g.reward_text, g.reward_code,
              g.target_coins, g.raised_coins, g.status, g.completed_at
         FROM g) x),
    'my_total', COALESCE((SELECT sum(c.amount) FROM public.office_goal_contributions c, g
                           WHERE c.goal_id = g.id AND c.user_id = auth.uid()), 0),
    'contributors', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.nick, sum(c.amount)::bigint AS amount,
               COALESCE(sum(c.amount) FILTER (WHERE c.source = 'crops'), 0)::bigint AS crop_amount,
               max(c.created_at) AS last_at
          FROM public.office_goal_contributions c
          JOIN g ON g.id = c.goal_id
          JOIN public.profiles p ON p.id = c.user_id
         GROUP BY p.nick
         ORDER BY sum(c.amount) DESC, max(c.created_at)) t), '[]'::json),
    'recent', COALESCE((SELECT json_agg(row_to_json(t)) FROM (
        SELECT p.nick, c.amount, c.created_at, c.source, c.crop_type, c.crop_qty
          FROM public.office_goal_contributions c
          JOIN g ON g.id = c.goal_id
          JOIN public.profiles p ON p.id = c.user_id
         ORDER BY c.created_at DESC LIMIT 12) t), '[]'::json),
    'extra_tiles', public.farm_extra_tiles_unlocked()
  );
$fn$;

REVOKE ALL ON FUNCTION public.office_goal_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_goal_state() TO authenticated;
