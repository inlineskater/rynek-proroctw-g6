-- ═══════════════════════════════════════════════════════════════════════════
--  „📦 Archiwum" — read-only history of the archived tabs (2026-10-20)
-- ═══════════════════════════════════════════════════════════════════════════
--  Owner's call after the 2026-10-20 usage audit: Rynki, Mundial, Ruletka,
--  Sloty, Poker, Miny, Rakieta, Koło Żubra and Wspólne Płótno leave the nav.
--  Their tables, Edge Functions and history are untouched; the frontend just
--  stops routing to them and shows this summary on the 📦 Archiwum tab
--  (tabs/archive.js) instead. Idempotent; run any time after the feature files.
--
--  One SECURITY DEFINER aggregate instead of client queries, because the
--  casino history is ~2.5k rows (the 1000-row PostgREST cap would need paging)
--  and poker_hands is not client-readable. Returns aggregates and nicks only —
--  nothing that game_transactions / markets / football_* don't already expose
--  to every player. Admins are excluded everywhere, like every other ranking.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.archive_summary()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH gt AS (
  SELECT * FROM public.game_transactions
   WHERE NOT is_admin AND game IN ('roulette','slots','mines','crash','wheel')
),
casino AS (
  SELECT g.game,
         count(*)                      AS rounds,
         count(DISTINCT g.user_id)     AS players,
         COALESCE(sum(g.bet), 0)       AS bet,
         COALESCE(sum(g.won), 0)       AS won,
         min(g.created_at)::date       AS first_at,
         max(g.created_at)::date       AS last_at,
         (SELECT json_build_object('nick', b.nick_snapshot, 'won', b.won, 'bet', b.bet, 'at', b.created_at::date)
            FROM gt b WHERE b.game = g.game ORDER BY b.won DESC, b.created_at LIMIT 1) AS best_win,
         (SELECT json_build_object('nick', t.nick, 'net', t.net)
            FROM (SELECT max(x.nick_snapshot) AS nick, sum(x.won - x.bet) AS net
                    FROM gt x WHERE x.game = g.game GROUP BY x.user_id
                   ORDER BY 2 DESC LIMIT 1) t) AS top
    FROM gt g
   GROUP BY g.game
),
pl AS (
  SELECT l.* FROM public.poker_ledger l JOIN public.profiles p ON p.id = l.user_id AND NOT p.is_admin
),
poker AS (
  SELECT json_build_object(
    'hands',    (SELECT count(*) FROM public.poker_hands WHERE settled_at IS NOT NULL),
    'players',  (SELECT count(DISTINCT user_id) FROM pl),
    'buy_ins',  (SELECT count(*) FROM pl WHERE type = 'buy_in'),
    'first_at', (SELECT min(created_at)::date FROM pl),
    'last_at',  (SELECT max(created_at)::date FROM pl),
    'ranking',  COALESCE((SELECT json_agg(r ORDER BY r.net DESC) FROM (
                  SELECT max(nick_snapshot) AS nick,
                         sum(CASE WHEN type = 'cashout' THEN amount WHEN type = 'buy_in' THEN -amount ELSE 0 END) AS net
                    FROM pl GROUP BY user_id) r), '[]'::json)
  ) AS j
),
mk AS (
  SELECT m.*, (SELECT nick FROM public.profiles WHERE id = m.created_by) AS creator,
         COALESCE((SELECT sum(amount) FROM public.trades t WHERE t.market_id = m.id), 0) AS pot,
         (SELECT count(DISTINCT user_id) FROM public.trades t WHERE t.market_id = m.id) AS traders
    FROM public.markets m
),
fb AS (
  SELECT b.* FROM public.football_bets b JOIN public.profiles p ON p.id = b.user_id AND NOT p.is_admin
),
football AS (
  SELECT json_build_object(
    'matches',  (SELECT count(*) FROM public.football_matches WHERE settled),
    'first_at', (SELECT min(kickoff)::date FROM public.football_matches),
    'last_at',  (SELECT max(kickoff)::date FROM public.football_matches),
    'bets',     (SELECT count(*) FROM fb),
    'players',  (SELECT count(DISTINCT user_id) FROM fb),
    'staked',   (SELECT COALESCE(sum(stake), 0) FROM fb),
    'paid',     (SELECT COALESCE(sum(potential_payout), 0) FROM fb WHERE status = 'won'),
    'best_win', (SELECT json_build_object('nick', b.nick_snapshot, 'payout', b.potential_payout,
                                          'odds', b.locked_odds, 'match', m.home_team || ' – ' || m.away_team)
                   FROM fb b JOIN public.football_matches m ON m.id = b.match_id
                  WHERE b.status = 'won' ORDER BY b.potential_payout DESC LIMIT 1),
    'ranking',  COALESCE((SELECT json_agg(r ORDER BY r.net DESC) FROM (
                  SELECT max(nick_snapshot) AS nick, count(*) AS bets,
                         count(*) FILTER (WHERE status = 'won') AS hits,
                         sum(CASE WHEN status = 'won' THEN potential_payout ELSE 0 END)
                           - sum(stake) FILTER (WHERE status IN ('won','lost')) AS net
                    FROM fb GROUP BY user_id) r), '[]'::json)
  ) AS j
),
cv AS (
  SELECT l.* FROM public.canvas_paint_log l JOIN public.profiles p ON p.id = l.user_id AND NOT p.is_admin
)
SELECT json_build_object(
  'casino',   COALESCE((SELECT json_agg(c ORDER BY c.rounds DESC) FROM casino c), '[]'::json),
  'poker',    (SELECT j FROM poker),
  'markets',  COALESCE((SELECT json_agg(json_build_object(
                  'icon', icon, 'title', title, 'created_at', created_at::date, 'closes_at', closes_at::date,
                  'resolution', resolution, 'resolved_at', resolved_at::date, 'creator', creator,
                  'pot', pot, 'traders', traders) ORDER BY created_at DESC) FROM mk), '[]'::json),
  'football', (SELECT j FROM football),
  'canvas',   json_build_object(
                'paints',   (SELECT count(*) FROM cv),
                'painters', (SELECT count(DISTINCT user_id) FROM cv),
                'first_at', (SELECT min(painted_at)::date FROM cv),
                'last_at',  (SELECT max(painted_at)::date FROM cv),
                'ranking',  COALESCE((SELECT json_agg(r ORDER BY r.n DESC) FROM (
                              SELECT (SELECT nick FROM public.profiles WHERE id = cv.user_id) AS nick, count(*) AS n
                                FROM cv GROUP BY user_id) r), '[]'::json))
);
$$;

REVOKE ALL ON FUNCTION public.archive_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_summary() TO authenticated;
