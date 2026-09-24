-- ════════════════════════════════════════════════════════════════════════════
--  „Automat Monet G6" 🪙 — a physical coin pusher (internal name: coinpusher)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: coin-transactions.sql. Idempotent.
--  Run order: coinpusher.sql, THEN re-run hazard-views.sql + coin-inflow-stats.sql
--             + economy-stats.sql + last-active.sql (all four grew a coinpusher
--             branch), then `supabase functions deploy coinpusher-action`.
--
--  ── The game ───────────────────────────────────────────────────────────────
--  Every player owns ONE persistent machine. You drop a coin; it falls onto a
--  moving pusher block, the pile shoves forward, and whatever goes over the
--  front edge is yours. Whatever goes over the SIDES (the gutters) is the
--  house's — exactly the edge a real arcade pusher has.
--
--  The physics runs in the browser (Rapier, games/coinpusher-core.js) and is
--  never steered: nothing on the server decides what falls.
--
--  ── Why the client cannot print money: the machine is a CLOSED LOOP ────────
--  The server cannot see coins fall, so it does not try to verify physics. It
--  bounds the CLAIM instead. Every coin in a machine is a row here with a
--  server-issued id and a value; a coin is paid at most once (status guard on
--  the UPDATE) and only if it is in the caller's machine. So over a machine's
--  whole life:
--
--      paid out  ≤  stakes dropped in  +  one starter pile (140 × 1 🪙)
--
--  and everything that is not a stake — refill coins, gold coins, jackpot
--  tokens, coin rain — is paid for out of `house_bank`, which is filled ONLY by
--  a share of that same machine's gutter losses. A hacked client that claims
--  every coin as a prize gets its own stakes back and nothing else: it never
--  loses to the gutters, so its bank stays empty and it never sees a special.
--  The honest return comes out of the physics (measured by
--  scripts/coinpusher-sim.mjs, ~86% of exits go over the front) plus the
--  recycled share of the gutters — see docs/coinpusher.md.
--
--  ── Stats rows: one per SESSION, booked at SETTLEMENT ──────────────────────
--  A drop writes no stats row: a coin sitting in the machine is not lost yet
--  (it may still come over the front), exactly like an unfinished tower. When
--  coins resolve, `collect` adds to the player's open session row:
--      bet       += Σ funded of the resolved coins (what they cost the player)
--      total_won += Σ value of the prize coins
--  so sum(bet − total_won) is real house net and hazard_stats,
--  game_transactions, coin-inflow and economy house-net take it like any other
--  *_spins table. ⚠️ Per-drop rows would book every coin in the machine as
--  burned the moment it went in — and farm_burn_per_day() (0.9 × casino burn
--  funds the farm NPC budget) would pay out on losses that never happened.
--  A session closes after 8 min of quiet (= the feed's SESSION_GAP_MS), at
--  Warsaw midnight (the economy buckets by day), and when the amulet flips.
--  Consumers read `updated_at` as the row's time.
--  Deliberately NOT in bank.sql's casino-share basis (nor hilo/tower): a
--  machine can hold coins across days, and that basis floors each day at 0.
--  Not realtime-published: session rows are UPDATEd constantly; the tab polls.
--  Last-active is stamped from coinpusher_coins (every drop INSERTs one).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coinpusher_machines (
  user_id         uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Gutter revenue kept back to fund refills and specials. Never negative.
  house_bank      bigint NOT NULL DEFAULT 0 CHECK (house_bank >= 0),
  starter_granted boolean NOT NULL DEFAULT false,
  -- Cosmetic snapshot of the pile so it survives a reload. NEVER trusted for
  -- money: the coin rows below are the machine's contents.
  layout          jsonb,
  layout_saved_at timestamptz,
  -- Handed to the tab that last called `state`; every write must carry it,
  -- so two tabs can't run two diverging simulations of the same coins.
  lease           text,
  -- Token bucket for drops (DROP_RATE_PER_S / DROP_BURST in the function).
  drop_tokens     real NOT NULL DEFAULT 6,
  last_drop_at    timestamptz,
  session_id      uuid,
  drops           bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coinpusher_coins (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('house','standard','gold','jackpot','rain')),
  value       bigint NOT NULL CHECK (value > 0),
  -- What the PLAYER paid for this coin: the stake for a drop (also for a
  -- gold/jackpot upgrade, whose premium came from the bank), 0 for starter,
  -- refill and rain coins. Booked as `bet` when the coin resolves.
  funded      bigint NOT NULL DEFAULT 0 CHECK (funded >= 0),
  status      text NOT NULL DEFAULT 'in_machine'
                CHECK (status IN ('in_machine','prize','gutter','lost')),
  -- The client's idempotency key for a drop: a retried request returns the
  -- coin it already bought instead of taking the stake twice.
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Machine columns added after the first draft (idempotent on re-run).
ALTER TABLE public.coinpusher_machines ADD COLUMN IF NOT EXISTS lease text;
ALTER TABLE public.coinpusher_machines ADD COLUMN IF NOT EXISTS drop_tokens real NOT NULL DEFAULT 3;
ALTER TABLE public.coinpusher_machines ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE public.coinpusher_coins    ADD COLUMN IF NOT EXISTS funded bigint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS coinpusher_coins_request_idx
  ON public.coinpusher_coins (user_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coinpusher_coins_in_machine_idx
  ON public.coinpusher_coins (user_id) WHERE status = 'in_machine';

CREATE TABLE IF NOT EXISTS public.coinpusher_spins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- uuid: game_transactions UNIONs ids
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bet           bigint NOT NULL DEFAULT 0 CHECK (bet >= 0),
  total_won     bigint NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  prize_coins   integer NOT NULL DEFAULT 0,
  gutter_coins  integer NOT NULL DEFAULT 0,
  gold_coins    integer NOT NULL DEFAULT 0,
  jackpot_coins integer NOT NULL DEFAULT 0,
  item_effect   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coinpusher_spins_user_idx    ON public.coinpusher_spins (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS coinpusher_spins_updated_idx ON public.coinpusher_spins (updated_at DESC);

ALTER TABLE public.coinpusher_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coinpusher_coins    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coinpusher_spins    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coinpusher_machines_own" ON public.coinpusher_machines;
CREATE POLICY "coinpusher_machines_own" ON public.coinpusher_machines
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "coinpusher_coins_own" ON public.coinpusher_coins;
CREATE POLICY "coinpusher_coins_own" ON public.coinpusher_coins
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "coinpusher_spins_select" ON public.coinpusher_spins;
CREATE POLICY "coinpusher_spins_select" ON public.coinpusher_spins
  FOR SELECT TO authenticated USING (true);

-- No client writes anywhere: the Edge Function writes over SUPABASE_DB_URL.
REVOKE ALL ON public.coinpusher_machines FROM anon, authenticated;
REVOKE ALL ON public.coinpusher_coins    FROM anon, authenticated;
REVOKE ALL ON public.coinpusher_spins    FROM anon, authenticated;
GRANT SELECT ON public.coinpusher_machines TO authenticated;
GRANT SELECT ON public.coinpusher_coins    TO authenticated;
GRANT SELECT ON public.coinpusher_spins    TO authenticated;

-- ── Boards ─────────────────────────────────────────────────────────────────
-- This week's haul: what went over the front edge, against what it cost.
CREATE OR REPLACE VIEW public.coinpusher_week_totals WITH (security_invoker = false) AS
SELECT s.user_id, p.nick,
       SUM(s.total_won)::bigint     AS won,
       SUM(s.bet)::bigint           AS staked,
       SUM(s.prize_coins)::integer  AS prize_coins,
       SUM(s.jackpot_coins)::integer AS jackpots,
       MAX(s.updated_at) AS last_at
FROM public.coinpusher_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
WHERE s.updated_at >= date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw')
                     AT TIME ZONE 'Europe/Warsaw'
GROUP BY s.user_id, p.nick;

-- Live feed of play sessions.
CREATE OR REPLACE VIEW public.coinpusher_recent WITH (security_invoker = false) AS
SELECT s.id, s.user_id, p.nick, s.bet, s.total_won, s.prize_coins, s.gutter_coins,
       s.gold_coins, s.jackpot_coins, s.updated_at
FROM public.coinpusher_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
ORDER BY s.updated_at DESC
LIMIT 30;

REVOKE SELECT ON public.coinpusher_week_totals, public.coinpusher_recent FROM anon;
GRANT  SELECT ON public.coinpusher_week_totals, public.coinpusher_recent TO authenticated;

NOTIFY pgrst, 'reload schema';
