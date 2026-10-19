-- ═══════════════════════════════════════════════════════════════════════════
--  Dead-feature cleanup (2026-10-20). Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════
--  From the 2026-10-20 usage audit (8 of 11 players active in 30 days):
--
--  1. `football_hourly_sync` — the World Cup's last match kicked off
--     2026-07-19 and no bet is open, yet the job still called The Odds API +
--     football-data.org every 6 h. Unscheduled; football-action, its tables
--     and its history are untouched (re-run football.sql's cron block to
--     bring it back for another tournament).
--  2. `farm_weekly_nft_activate_2200/2300` — the weekly NFT series ended with
--     the 2026-10-12 edition and every edition is already active, so
--     farm_activate_weekly_nft() was a daily no-op. The monthly editions are
--     driven by farm_nft_monthly_tick (farm-nft-monthly.sql), not this job.
--  3. Leftover tables of two features whose code is long gone:
--       • „Office Grand Prix" racer (removed 2026-07-23): 2 sessions,
--         16 participants, 1 score, 0 awards.
--       • the old private coin pusher `coin_pusher_*` (replaced by the shared
--         `coinpusher_*` machine): 1 machine row, 4 spins.
--     Nothing outside their own views referenced them (checked pg_depend and
--     every public function body). Rows were exported to backups/ (gitignored)
--     before the drop.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE j text;
BEGIN
  FOREACH j IN ARRAY ARRAY['football_hourly_sync',
                           'farm_weekly_nft_activate_2200',
                           'farm_weekly_nft_activate_2300'] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  END LOOP;
END $$;

DROP VIEW IF EXISTS public.office_grand_prix_weekly_leaderboard;
DROP VIEW IF EXISTS public.office_grand_prix_test_standings;
DROP VIEW IF EXISTS public.office_grand_prix_current_week;
DROP VIEW IF EXISTS public.office_grand_prix_all_time;
DROP VIEW IF EXISTS public.office_grand_prix_recent_awards;
DROP TABLE IF EXISTS public.office_grand_prix_submissions;
DROP TABLE IF EXISTS public.office_grand_prix_scores;
DROP TABLE IF EXISTS public.office_grand_prix_weekly_awards;
DROP TABLE IF EXISTS public.office_grand_prix_participants;
DROP TABLE IF EXISTS public.office_grand_prix_sessions;
DROP FUNCTION IF EXISTS public.office_grand_prix_mode(timestamptz);

DROP TABLE IF EXISTS public.coin_pusher_spins;
DROP TABLE IF EXISTS public.coin_pusher_machine;

COMMIT;
