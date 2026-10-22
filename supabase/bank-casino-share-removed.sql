-- ════════════════════════════════════════════════════════════════════════════
--  Bank G6: 🎰 Udział w Kasynie REMOVED  (2026-10-23)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after bank.sql. Idempotent. ⚠️ Re-run after re-running bank.sql, which
--  re-grants bank_buy_share.
--
--  Owner's call. The product paid 3% of the trailing-7-day casino house net per
--  share, and nine of the casino tabs were archived on 2026-10-20, so its
--  income was about to dry up. The 20 sold shares (4 holders × 5, 20,000 each)
--  had already paid 80,466 in dividends.
--
--  What this does:
--   1. bank_buy_share() always raises 'share_retired', and the client grant is
--      revoked. Nothing else changes in bank.sql: the dividend step in
--      bank_settle_due() only pays holdings with redeemed_at IS NULL, so with
--      every share redeemed it pays nothing, forever.
--   2. Every unredeemed share is BOUGHT BACK at the price its holder paid
--      (purchase_price), stamped redeemed_at and taken off the resale market.
--      The refund is booked as 'bank_share_buyback' (a mint offsetting the
--      original 'bank_share_buy' burn) and goes through
--      farm_apply_land_tax_autopay like any other proceeds, so an unpaid land
--      tax is settled from it first. Aggregated per user before touching
--      profiles (bank.sql's warning: an UPDATE … FROM a multi-row CTE updates a
--      row once).
--
--  ⚠️ New coin reason 'bank_share_buyback' — wired into all four frontend
--  consumers (tabs/stats.js NEUTRAL + label, ACT_COIN_REASONS) and into
--  economy-stats.sql's ledger_minted.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bank_buy_share(p_qty integer DEFAULT 1)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RAISE EXCEPTION 'share_retired';
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_buy_share(integer) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  r      record;
  v_tax  json;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bank_share_primary_sale'));

  FOR r IN
    WITH q AS (
      UPDATE public.bank_holdings
         SET redeemed_at = now(), ask_price = NULL
       WHERE kind = 'share' AND redeemed_at IS NULL
      RETURNING owner_id, purchase_price
    )
    SELECT owner_id, sum(purchase_price)::integer AS amount, count(*)::integer AS n
      FROM q GROUP BY owner_id
  LOOP
    UPDATE public.profiles SET coins = coins + r.amount WHERE id = r.owner_id;
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (r.owner_id, r.amount, 'bank_share_buyback',
            jsonb_build_object('shares', r.n, 'note', 'Udział w Kasynie wycofany — odkup po cenie zakupu'));
    -- Unpaid land tax comes out of the refund first, like any other proceeds.
    v_tax := public.farm_apply_land_tax_autopay(r.owner_id, r.amount, 'bank_share_buyback',
                                                jsonb_build_object('shares', r.n));
    IF COALESCE((v_tax->>'tax_paid')::integer, 0) > 0 THEN
      UPDATE public.profiles SET coins = coins - (v_tax->>'tax_paid')::integer WHERE id = r.owner_id;
    END IF;
  END LOOP;
END $$;
