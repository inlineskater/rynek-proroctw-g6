-- ════════════════════════════════════════════════════════════════════════════
--  „Wieżowiec G6" — a stacking casino game (internal name: tower)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: coin-transactions.sql. Idempotent.
--  Run order: tower.sql, THEN re-run hazard-views.sql + coin-inflow-stats.sql
--             + economy-stats.sql + last-active.sql (all four grew a tower
--             branch), then `supabase functions deploy tower-action`.
--
--  ── The game ───────────────────────────────────────────────────────────────
--  A crane swings a block over your tower. Before every floor you pick the
--  block, and with it the risk — the TRUE probability is printed on the button:
--
--      🧱 Szeroki   90% it lands    ×1,11 per floor
--      🏢 Normalny  70% it lands    ×1,43 per floor
--      🗼 Wąski     45% it lands    ×2,22 per floor
--
--  It lands: the pot multiplies by the exact inverse of that probability and the
--  tower is a floor taller. It slides off: the tower comes down and the pot is
--  gone. Cash out whenever you have at least one floor.
--
--  ── The house edge is applied ONCE, not per floor ──────────────────────────
--  Same construction as „Drabina Kariery G6" (hilo.sql), for the same reason:
--  each floor multiplies the pot by exactly 1/p, so E[pot after a floor] = pot
--  and the tower is a MARTINGALE. The 5% is taken once at cash-out, so RTP is a
--  flat 95% at any height and with any mix of blocks — no strategy beats any
--  other, only the variance changes. ⚠️ Do not "fix" this by charging the edge
--  per floor; it would compound to 0.54 over 12 floors and punish exactly the
--  tall towers the game exists for.
--
--  ── Why the printed odds can never be a lie ────────────────────────────────
--  Hi-Lo CLAMPS the multiplier when a step would cross its coin ceiling, which
--  quietly makes that one step unfair. Here a block whose next multiplier would
--  cross the ceiling is simply NOT OFFERED (the UI shows why), and when no block
--  fits any more the tower cashes itself out. Every floor that is offered pays
--  its full fair 1/p.
--
--  ── No secrets table ───────────────────────────────────────────────────────
--  The landing is rolled from crypto RNG at the moment the block is dropped and
--  is immediately public; there is no state the player bets against before
--  acting (unlike mines/crash), so nothing needs hiding.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tower_rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bet          bigint NOT NULL CHECK (bet > 0),
  floors       integer NOT NULL DEFAULT 0 CHECK (floors >= 0),
  multiplier   numeric NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  house_factor numeric NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cashed','collapsed')),
  -- [{ tier, p, won }] per drop — the tower's actual shape, drawn by the client.
  history      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

-- One tower under construction per player (a real constraint, not app logic).
CREATE UNIQUE INDEX IF NOT EXISTS tower_rounds_one_active_idx
  ON public.tower_rounds (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS tower_rounds_user_idx
  ON public.tower_rounds (user_id, created_at DESC);

-- Finished towers: history, Hazardista, coin-inflow and economy house-net.
CREATE TABLE IF NOT EXISTS public.tower_spins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_id    uuid REFERENCES public.tower_rounds(id) ON DELETE SET NULL,
  bet         bigint NOT NULL,
  floors      integer NOT NULL,
  multiplier  numeric NOT NULL,
  total_won   bigint NOT NULL DEFAULT 0,
  result      text NOT NULL CHECK (result IN ('cashed','collapsed')),
  -- The block mix, e.g. {"wide":3,"normal":2,"narrow":1}, for the feed.
  blocks      jsonb NOT NULL DEFAULT '{}'::jsonb,
  item_effect text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tower_spins_user_idx    ON public.tower_spins (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tower_spins_floors_idx  ON public.tower_spins (floors DESC, created_at);
CREATE INDEX IF NOT EXISTS tower_spins_created_idx ON public.tower_spins (created_at DESC);

ALTER TABLE public.tower_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tower_spins  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tower_rounds_own" ON public.tower_rounds;
CREATE POLICY "tower_rounds_own" ON public.tower_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "tower_spins_select" ON public.tower_spins;
CREATE POLICY "tower_spins_select" ON public.tower_spins
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.tower_rounds FROM anon, authenticated;
REVOKE ALL ON public.tower_spins  FROM anon, authenticated;
GRANT SELECT ON public.tower_rounds TO authenticated;
GRANT SELECT ON public.tower_spins  TO authenticated;

-- ── Leaderboards ───────────────────────────────────────────────────────────
-- Ranked on HEIGHT, cashed towers only: a tower that fell is not a tower. And
-- not on coins won, which would just rank whoever bets biggest.
CREATE OR REPLACE VIEW public.tower_week_heights WITH (security_invoker = false) AS
SELECT DISTINCT ON (s.user_id)
  s.user_id, p.nick, s.floors, s.multiplier, s.total_won, s.created_at
FROM public.tower_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
WHERE s.result = 'cashed'
  AND s.created_at >= date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw')
                      AT TIME ZONE 'Europe/Warsaw'
ORDER BY s.user_id, s.floors DESC, s.multiplier DESC, s.created_at;

CREATE OR REPLACE VIEW public.tower_all_time_heights WITH (security_invoker = false) AS
SELECT DISTINCT ON (s.user_id)
  s.user_id, p.nick, s.floors, s.multiplier, s.total_won, s.created_at
FROM public.tower_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
WHERE s.result = 'cashed'
ORDER BY s.user_id, s.floors DESC, s.multiplier DESC, s.created_at;

-- Live feed — towers going up and coming down is most of the fun of the room.
CREATE OR REPLACE VIEW public.tower_recent WITH (security_invoker = false) AS
SELECT s.id, s.user_id, p.nick, s.bet, s.floors, s.multiplier, s.total_won,
       s.result, s.blocks, s.created_at
FROM public.tower_spins s
JOIN public.profiles p ON p.id = s.user_id AND NOT COALESCE(p.is_admin, false)
ORDER BY s.created_at DESC
LIMIT 30;

REVOKE SELECT ON public.tower_week_heights, public.tower_all_time_heights, public.tower_recent FROM anon;
GRANT  SELECT ON public.tower_week_heights, public.tower_all_time_heights, public.tower_recent TO authenticated;

DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.tower_spins; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

NOTIFY pgrst, 'reload schema';
