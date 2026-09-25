-- ════════════════════════════════════════════════════════════════════════════
--  „Automat Monet G6" — ONE shared machine for everybody (2026-09-25)
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER coinpusher.sql. Idempotent. Then deploy coinpusher-action.
--
--  Until now every player had a private machine (coinpusher_machines, one row
--  per user). This file adds the single shared cabinet everybody sees and
--  throws into together:
--
--    coinpusher_shared    the one machine (id 'main'): bank, pile snapshot,
--                         the HOST lease, the last thrower
--    coinpusher_players   per-player state that used to live on the private
--                         machine row: drop token bucket, stats session,
--                         the ownerless-prize window
--    coinpusher_exits     audit log of every coin that left the shared machine
--    coinpusher_coins     gains machine_id ('main' = shared), and user_id — the
--                         coin's OWNER — becomes nullable: house pre-fill coins
--                         belong to nobody
--
--  ── Who runs the physics ───────────────────────────────────────────────────
--  Supabase cannot run a physics loop around the clock, so one connected
--  player's browser — the HOST — simulates the machine and streams it to
--  everyone over Realtime. The host is whoever holds `host_lease` (renewed every
--  3 s, expires after 8 s); when it lapses the next visible client takes over.
--
--  ── Who gets paid (the trust model) ───────────────────────────────────────
--  Only the host reports exits. The server pays a prize coin to its OWNER (the
--  player who threw it) — never to the reporter. An OWNERLESS coin (house
--  pre-fill, refills) goes to the most recent thrower within 30 s, capped per
--  player per minute; with nobody eligible it is booked like a gutter coin
--  (recycled into the bank). So a modified host can decide whether other
--  people's coins fall, but cannot take them; at most it can time house coins
--  to follow its own throws, which the cap limits. Every exit is written to
--  coinpusher_exits for auditing. The machine still cannot pay out more than
--  was thrown in plus its one pre-fill.
--
--  ── The one-time pre-fill ──────────────────────────────────────────────────
--  The shared machine is filled ONCE with ownerless 100 🪙 coins, up to
--  SHARED_PREFILL in coinpusher-action minus whatever private-machine coins
--  migrate in. This replaces the per-player 140 × 100 pre-fill: one machine is
--  a far smaller mint than one per player.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coinpusher_shared (
  id              text PRIMARY KEY,
  house_bank      bigint NOT NULL DEFAULT 0 CHECK (house_bank >= 0),
  prefilled       boolean NOT NULL DEFAULT false,
  layout          jsonb,
  layout_saved_at timestamptz,
  host_user       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  host_lease      text,
  host_seen_at    timestamptz,
  last_thrower    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_throw_at   timestamptz,
  last_tower_at   timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.coinpusher_shared (id) VALUES ('main') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.coinpusher_players (
  user_id          uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  drop_tokens      real NOT NULL DEFAULT 6,
  last_drop_at     timestamptz,
  session_id       uuid,
  ownerless_since  timestamptz,
  ownerless_paid   bigint NOT NULL DEFAULT 0,
  seen_at          timestamptz
);

CREATE TABLE IF NOT EXISTS public.coinpusher_exits (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coin_id    bigint NOT NULL,
  owner_id   uuid,
  paid_to    uuid,
  where_to   text NOT NULL,
  value      bigint NOT NULL,
  host_user  uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coinpusher_exits_created_idx ON public.coinpusher_exits (created_at DESC);

ALTER TABLE public.coinpusher_coins ADD COLUMN IF NOT EXISTS machine_id text;
ALTER TABLE public.coinpusher_coins ALTER COLUMN user_id DROP NOT NULL;
-- 'retired': house pre-fill taken out of play by the migration below — never
-- paid to anyone, never counted as a house win.
ALTER TABLE public.coinpusher_coins DROP CONSTRAINT IF EXISTS coinpusher_coins_status_check;
ALTER TABLE public.coinpusher_coins ADD CONSTRAINT coinpusher_coins_status_check
  CHECK (status IN ('in_machine','prize','gutter','lost','retired'));
CREATE INDEX IF NOT EXISTS coinpusher_coins_shared_idx
  ON public.coinpusher_coins (machine_id) WHERE status = 'in_machine';

ALTER TABLE public.coinpusher_shared  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coinpusher_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coinpusher_exits   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coinpusher_shared, public.coinpusher_players, public.coinpusher_exits FROM anon, authenticated;
-- No client grants at all: everything goes through coinpusher-action.

-- ── Migration: private machines → the shared one (runs once) ─────────────────
-- Coins players threw keep their owner. House pre-fill coins become ownerless:
-- in a shared machine they belong to whoever's throw shakes them loose.
-- Private banks are pooled into the shared bank (capped like the function's
-- BANK_CAP).
--
-- One cabinet holds about 320 coins comfortably; five private machines held
-- 463 on 2026-09-25 (343 of them house pre-fill). Every coin a PLAYER threw
-- moves in; house pre-fill only up to that total, the rest is retired. At 463
-- the host's physics step costs ~4.5 ms of an 8.3 ms budget and the overfull
-- pile dumps ~270 coins in its first minute.
DO $$
BEGIN
  IF NOT (SELECT prefilled FROM public.coinpusher_shared WHERE id = 'main') THEN
    UPDATE public.coinpusher_coins
       SET machine_id = 'main',
           user_id = CASE WHEN kind = 'house' THEN NULL ELSE user_id END
     WHERE status = 'in_machine' AND machine_id IS NULL;
    UPDATE public.coinpusher_shared
       -- ADD, never assign: the private banks are zeroed right after, so a
       -- re-run must not overwrite what was already pooled.
       SET house_bank = LEAST(20000, house_bank + (SELECT COALESCE(sum(house_bank), 0) FROM public.coinpusher_machines))
     WHERE id = 'main';
    UPDATE public.coinpusher_machines SET house_bank = 0;
    UPDATE public.coinpusher_coins SET status = 'retired', resolved_at = now()
     WHERE id IN (
       SELECT id FROM public.coinpusher_coins
        WHERE machine_id = 'main' AND status = 'in_machine' AND user_id IS NULL AND kind = 'house'
        ORDER BY id DESC
        LIMIT GREATEST(0, (SELECT count(*) FROM public.coinpusher_coins
                            WHERE machine_id = 'main' AND status = 'in_machine') - 320));
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
