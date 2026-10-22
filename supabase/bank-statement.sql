-- ════════════════════════════════════════════════════════════════════════════
--  Bank G6: 📄 Wyciąg miesięczny — the monthly statement  (2026-10-23)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after bank.sql and bank-loans.sql. Idempotent; supersedes nothing.
--
--  A personal statement for any calendar month (Warsaw), built from the coin
--  ledger (coin_transactions) plus casino play (game_transactions, the view
--  over every spin table). Nothing is stored: the statement is a read.
--
--  Lines are grouped into what a player recognises:
--    income   — farm sales & orders, contract awards, zen watering, Bank yields,
--               marketplace sales, everything else positive
--    spending — farm build-up (boxes, level-ups, plots, breeding, scarecrow),
--               land tax, shop/office goal/marketplace, everything else negative
--    transfers — Bank principal moving between cash and a product (deposit
--               open/close, bond buy/redeem, loan, share buy/buyback): shown on
--               their own because they change cash but not wealth
--    casino   — won − staked, one line
--  plus a day-by-day cash-flow series for the chart, the five biggest single
--  inflows, and the player's rank by net result (income − spending + casino)
--  among everyone with any activity that month.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bank_statement_group(p_reason text, p_delta numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $c$
  SELECT CASE
    WHEN p_reason IN ('bank_deposit_open','bank_deposit_close','bank_bond_buy','bank_bond_redeem',
                      'bank_loan_open','bank_loan_repay','bank_share_buy','bank_share_buyback',
                      'bank_resale_purchase','bank_resale_sale') THEN 'transfer'
    WHEN p_delta >= 0 THEN 'income'
    ELSE 'spending' END
$c$;

CREATE OR REPLACE FUNCTION public.bank_statement_label(p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE AS $c$
  SELECT CASE
    WHEN p_reason IN ('farm_crop_sale') THEN '🌾 Sprzedaż plonów'
    WHEN p_reason IN ('farm_order_payout') THEN '📋 Zamówienia'
    WHEN p_reason LIKE 'farm_seasonal%' THEN '🏆 Kontrakty i nagrody farmy'
    WHEN p_reason = 'garden_water' THEN '💧 Podlewanie Ogrodu Zen'
    WHEN p_reason IN ('daily_interest','bank_deposit_interest','bank_bond_coupon','bank_share_dividend') THEN '🏦 Odsetki i dywidendy'
    WHEN p_reason IN ('farm_box_buy','farm_goldbox_buy','card_levelup','farm_tile_buy','nft_breed','farm_scarecrow_buy') THEN '🌱 Rozbudowa farmy'
    WHEN p_reason LIKE 'farm_land_tax%' THEN '🏛️ Podatek gruntowy'
    WHEN p_reason IN ('marketplace_sale','marketplace_purchase') THEN '🛍️ Targowisko'
    WHEN p_reason = 'office_goal_contribution' THEN '🎯 Wspólny Cel'
    WHEN p_reason IN ('hero_item_purchase','store_purchase') THEN '🛒 Sklep'
    WHEN p_reason IN ('bank_deposit_open','bank_deposit_close') THEN '🏦 Lokaty (wpłaty/wypłaty)'
    WHEN p_reason IN ('bank_bond_buy','bank_bond_redeem','bank_resale_purchase','bank_resale_sale') THEN '📜 Obligacje (zakup/wykup)'
    WHEN p_reason IN ('bank_loan_open','bank_loan_repay') THEN '🤝 Kredyt (wypłata/spłata)'
    WHEN p_reason IN ('bank_share_buy','bank_share_buyback') THEN '🎰 Udziały (zakup/odkup)'
    ELSE '🪙 Inne' END
$c$;

CREATE OR REPLACE FUNCTION public.bank_statement(p_month date DEFAULT NULL)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_m     date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'Europe/Warsaw')::date))::date;
  v_from  timestamptz := v_m::timestamp AT TIME ZONE 'Europe/Warsaw';
  v_to    timestamptz := (v_m + interval '1 month')::timestamp AT TIME ZONE 'Europe/Warsaw';
  v_out   json;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  WITH led AS (
    SELECT ct.reason, ct.delta::numeric AS delta,
           (ct.created_at AT TIME ZONE 'Europe/Warsaw')::date AS d,
           public.bank_statement_group(ct.reason, ct.delta) AS grp
      FROM public.coin_transactions ct
     WHERE ct.user_id = v_user AND ct.created_at >= v_from AND ct.created_at < v_to
  ),
  cas AS (
    SELECT (g.created_at AT TIME ZONE 'Europe/Warsaw')::date AS d, (g.won - g.bet)::numeric AS net
      FROM public.game_transactions g
     WHERE g.user_id = v_user AND g.created_at >= v_from AND g.created_at < v_to
  ),
  lines AS (
    SELECT grp, public.bank_statement_label(reason) AS label, sum(delta) AS amount, count(*) AS n
      FROM led GROUP BY 1, 2
  ),
  days AS (
    SELECT d, sum(net) AS net FROM (
      SELECT d, delta AS net FROM led WHERE grp <> 'transfer'
      UNION ALL SELECT d, net FROM cas) u
     GROUP BY d
  ),
  office AS (
    SELECT u.user_id, sum(u.net) AS net FROM (
      SELECT ct.user_id, ct.delta::numeric AS net FROM public.coin_transactions ct
       WHERE ct.created_at >= v_from AND ct.created_at < v_to
         AND public.bank_statement_group(ct.reason, ct.delta) <> 'transfer'
      UNION ALL
      SELECT g.user_id, (g.won - g.bet)::numeric FROM public.game_transactions g
       WHERE g.created_at >= v_from AND g.created_at < v_to) u
      JOIN public.profiles p ON p.id = u.user_id AND NOT COALESCE(p.is_admin, false)
     GROUP BY u.user_id
  ),
  ranked AS (SELECT user_id, net, rank() OVER (ORDER BY net DESC) AS rk, count(*) OVER () AS cnt FROM office)
  SELECT json_build_object(
    'month', v_m,
    'months', (SELECT json_agg(m ORDER BY m DESC) FROM (
                 SELECT DISTINCT date_trunc('month', (created_at AT TIME ZONE 'Europe/Warsaw'))::date AS m
                   FROM public.coin_transactions WHERE user_id = v_user) mm),
    'cash_now', (SELECT coins FROM public.profiles WHERE id = v_user),
    'income',   COALESCE((SELECT sum(delta) FROM led WHERE grp = 'income'), 0),
    'spending', COALESCE((SELECT -sum(delta) FROM led WHERE grp = 'spending'), 0),
    'casino',   COALESCE((SELECT sum(net) FROM cas), 0),
    'casino_rounds', (SELECT count(*) FROM cas),
    'lines', COALESCE((SELECT json_agg(json_build_object('group', grp, 'label', label, 'amount', amount, 'n', n)
                                ORDER BY grp, abs(amount) DESC) FROM lines), '[]'::json),
    'days', COALESCE((SELECT json_agg(json_build_object('d', d, 'net', net) ORDER BY d) FROM days), '[]'::json),
    'top', COALESCE((SELECT json_agg(t) FROM (
              SELECT public.bank_statement_label(ct.reason) AS label, ct.delta AS amount, ct.created_at
                FROM public.coin_transactions ct
               WHERE ct.user_id = v_user AND ct.created_at >= v_from AND ct.created_at < v_to
                 AND public.bank_statement_group(ct.reason, ct.delta) = 'income'
               ORDER BY ct.delta DESC LIMIT 5) t), '[]'::json),
    'rank', (SELECT rk FROM ranked WHERE user_id = v_user),
    'players', (SELECT max(cnt) FROM ranked)
  ) INTO v_out;
  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_statement(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_statement(date) TO authenticated;
