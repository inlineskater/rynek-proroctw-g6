-- ════════════════════════════════════════════════════════════════════════════
--  Seasonal award catch-up  (2026-10-22)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after season-award-gating.sql (needs seasonal_game_for_week()).
--  Idempotent. Supersedes nothing.
--
--  Every seasonal game's Monday payout is a pg_cron job at '0 22,23 * * 0'.
--  The two UTC hours are a DST GATE, not a retry: only the one that lands on
--  00:00 Warsaw does anything. And ~20 of those jobs, plus the farm jobs, all
--  fire in the same second — on 2026-10-18 tetris_weekly_awards deadlocked
--  against them, its gated twin skipped, and the Tetris week of 2026-10-12 was
--  simply never paid (fixed by hand on 2026-10-22). The farm contract award had
--  the same failure in July (see farm-seasonal-award-reliability.sql).
--
--  seasonal_awards_catchup() runs hourly at minute 45, away from the storm. For
--  each of the last p_weeks CLOSED weeks it asks seasonal_game_for_week() whose
--  week it was and, if that game's <game>_weekly_awards has no row for it while
--  <game>_scores has some, calls award_<game>_week(week). The award functions
--  are already idempotent per week, so a race with the Monday job is harmless.
--  Each call runs in its own subtransaction: one game failing cannot block the
--  others, and the error is returned rather than raised.
--
--  No hour gate on purpose. Adding a game needs nothing here — the naming
--  convention (<game>_scores / <game>_weekly_awards / award_<game>_week) is what
--  every seasonal game already follows.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.seasonal_awards_catchup(p_weeks integer DEFAULT 4)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_this   date := date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_week   date;
  v_game   text;
  v_paid   boolean;
  v_scores boolean;
  v_res    text;
  v_out    jsonb := '[]'::jsonb;
BEGIN
  -- One catch-up at a time; a slow award must not be started twice.
  IF NOT pg_try_advisory_xact_lock(hashtext('seasonal_awards_catchup')) THEN
    RETURN json_build_object('ok', true, 'skipped', 'already_running');
  END IF;

  FOR i IN 1 .. GREATEST(1, p_weeks) LOOP
    v_week := v_this - 7 * i;
    v_game := public.seasonal_game_for_week(v_week);
    CONTINUE WHEN v_game IS NULL
               OR to_regclass('public.' || v_game || '_weekly_awards') IS NULL
               OR to_regclass('public.' || v_game || '_scores') IS NULL
               OR to_regprocedure('public.award_' || v_game || '_week(date)') IS NULL;

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE week_start = $1)',
                   v_game || '_weekly_awards') INTO v_paid USING v_week;
    CONTINUE WHEN v_paid;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE week_start = $1)',
                   v_game || '_scores') INTO v_scores USING v_week;
    CONTINUE WHEN NOT v_scores;

    BEGIN
      EXECUTE format('SELECT public.%I($1)::text', 'award_' || v_game || '_week')
        INTO v_res USING v_week;
      v_out := v_out || jsonb_build_object('week', v_week, 'game', v_game,
                                           'result', v_res::jsonb);
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_object('week', v_week, 'game', v_game,
                                           'error', SQLERRM);
    END;
  END LOOP;

  RETURN json_build_object('ok', true, 'checked_weeks', p_weeks, 'paid', v_out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.seasonal_awards_catchup(integer) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'seasonal_awards_catchup',
      '45 * * * *',
      $cron$SELECT public.seasonal_awards_catchup();$cron$
    );
  END IF;
END $$;
