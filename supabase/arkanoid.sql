-- „Arkanoid G6" (arkanoid) seasonal game support for Rynek Proroctw G6.
--
-- Breakout with office bricks: a paddle (a keyboard), a ball, and six
-- hand-built office floors — Open Space, the corporate pyramid, the filing
-- wall, the cubicles, the desk checkerboard and the CEO's safe — that loop
-- faster once cleared. Three lives, capsules from broken bricks (wider paddle,
-- slower ball, extra life, three balls). A round ends when the last ball is
-- lost, or at the 5-minute replay ceiling.
--
-- Scoring: 10 × band per colour brick, 60 per segregator (2 hits), 100 per
-- safe (3 hits), 5 per chip, 25 per capsule, 500 per cleared floor plus a
-- 1000-point time bonus that decays over 120 s. A good round lands 8-11 000;
-- a never-wrong bot tops out ~17 000 inside the ceiling, hence the 40 000 cap
-- (see scripts/arkanoid-balance.mjs).
--
-- ANTI-CHEAT. The client logs only paddle-target changes and launches, as
-- (tick, value) pairs; arkanoid-action replays seed + log through a
-- byte-identical copy of the simulation (scripts/arkanoid-parity.mjs), and
-- requires the round to have taken at least as much wall clock as the ticks
-- it simulated.
--
-- Run after supabase/schema.sql and supabase/hero-items.sql.
-- After running this file:
--   • re-run supabase/season-award-gating.sql (updated with the `arkanoid`
--     rotation entry, the 2026-09-28 override, and pins for the three weeks
--     whose rotation slot a 15th game would otherwise reshuffle) — without it
--     the week is played and NOBODY IS PAID;
--   • re-run supabase/arcade.sql (whitelists 'arkanoid', caps it at 40000)
--     so the free „Wszystkie Gry" path works too;
--   • re-run supabase/last-active.sql so arkanoid_scores stamps the Biuro rail.

CREATE OR REPLACE FUNCTION public.arkanoid_week_start(p_ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Monday-starting week (Mon..Sun) in Europe/Warsaw.
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

CREATE TABLE IF NOT EXISTS public.arkanoid_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  seed          integer NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.arkanoid_scores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id       uuid NOT NULL UNIQUE REFERENCES public.arkanoid_rounds(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot  text NOT NULL,
  week_start     date NOT NULL,
  score          integer NOT NULL CHECK (score >= 0),
  levels_cleared integer NOT NULL DEFAULT 0 CHECK (levels_cleared >= 0),
  bricks         integer NOT NULL DEFAULT 0 CHECK (bricks >= 0),
  capsules       integer NOT NULL DEFAULT 0 CHECK (capsules >= 0),
  lives_lost     integer NOT NULL DEFAULT 0 CHECK (lives_lost >= 0),
  paddle_hits    integer NOT NULL DEFAULT 0 CHECK (paddle_hits >= 0),
  inputs         integer NOT NULL DEFAULT 0 CHECK (inputs >= 0),
  ticks          integer NOT NULL DEFAULT 0 CHECK (ticks >= 0),
  duration_ms    integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  -- Carries the SAVE RATE: paddle returns / (returns + balls lost). Every
  -- seasonal scores table has an `accuracy` column and index.html's
  -- SEASON_LIVE_DEFAULT tiebreaks the live podium on it, so the name is fixed
  -- even though the quantity is game-specific.
  accuracy       numeric(5,2) NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  client_meta    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.arkanoid_weekly_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    date NOT NULL,
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nick_snapshot text NOT NULL,
  rank          integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  score         integer NOT NULL CHECK (score >= 0),
  duration_ms   integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  prize_coins   integer NOT NULL CHECK (prize_coins > 0),
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, rank),
  UNIQUE (week_start, user_id)
);

CREATE INDEX IF NOT EXISTS arkanoid_rounds_user_time_idx
  ON public.arkanoid_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS arkanoid_rounds_expires_idx
  ON public.arkanoid_rounds(expires_at)
  WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS arkanoid_scores_week_rank_idx
  ON public.arkanoid_scores(week_start, score DESC, submitted_at ASC);

CREATE INDEX IF NOT EXISTS arkanoid_scores_user_time_idx
  ON public.arkanoid_scores(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS arkanoid_awards_week_idx
  ON public.arkanoid_weekly_awards(week_start DESC, rank ASC);

ALTER TABLE public.arkanoid_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arkanoid_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arkanoid_weekly_awards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "arkanoid_rounds_select_own" ON public.arkanoid_rounds;
CREATE POLICY "arkanoid_rounds_select_own" ON public.arkanoid_rounds
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "arkanoid_scores_select" ON public.arkanoid_scores;
CREATE POLICY "arkanoid_scores_select" ON public.arkanoid_scores
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "arkanoid_awards_select" ON public.arkanoid_weekly_awards;
CREATE POLICY "arkanoid_awards_select" ON public.arkanoid_weekly_awards
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.arkanoid_rounds, public.arkanoid_scores, public.arkanoid_weekly_awards
  FROM anon, authenticated;
GRANT SELECT ON public.arkanoid_rounds, public.arkanoid_scores, public.arkanoid_weekly_awards
  TO authenticated;

CREATE OR REPLACE VIEW public.arkanoid_current_week WITH (security_invoker = true) AS
WITH current_week AS (
  SELECT public.arkanoid_week_start(now()) AS week_start
),
round_counts AS (
  SELECT user_id, week_start, COUNT(*)::integer AS rounds_played
  FROM public.arkanoid_scores
  GROUP BY user_id, week_start
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start,
    s.score,
    COALESCE((s.client_meta->>'base_score')::int, s.score) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    s.levels_cleared,
    s.bricks,
    s.capsules,
    s.lives_lost,
    s.paddle_hits,
    s.ticks,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.arkanoid_scores s
  JOIN current_week cw ON cw.week_start = s.week_start
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id AND rc.week_start = s.week_start
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  week_start,
  score,
  levels_cleared,
  bricks,
  capsules,
  lives_lost,
  paddle_hits,
  ticks,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.arkanoid_all_time WITH (security_invoker = true) AS
WITH round_counts AS (
  SELECT user_id, COUNT(*)::integer AS rounds_played
  FROM public.arkanoid_scores
  GROUP BY user_id
),
user_best AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id,
    s.nick_snapshot AS nick,
    s.week_start AS best_week_start,
    s.score,
    COALESCE((s.client_meta->>'base_score')::int, s.score) AS base_score,
    COALESCE((s.client_meta->'item_effect'->>'bonus')::int, 0) AS item_bonus,
    s.levels_cleared,
    s.bricks,
    s.capsules,
    s.lives_lost,
    s.paddle_hits,
    s.ticks,
    s.duration_ms,
    s.accuracy,
    s.submitted_at,
    COALESCE(rc.rounds_played, 1) AS rounds_played
  FROM public.arkanoid_scores s
  LEFT JOIN round_counts rc ON rc.user_id = s.user_id
  ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
)
SELECT
  (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank,
  user_id,
  nick,
  best_week_start,
  score,
  levels_cleared,
  bricks,
  capsules,
  lives_lost,
  paddle_hits,
  ticks,
  duration_ms,
  accuracy,
  rounds_played,
  submitted_at,
  base_score,
  item_bonus
FROM user_best
ORDER BY rank;

CREATE OR REPLACE VIEW public.arkanoid_recent_awards WITH (security_invoker = true) AS
SELECT
  id,
  week_start,
  user_id,
  nick_snapshot AS nick,
  rank,
  score,
  duration_ms,
  prize_coins,
  awarded_at
FROM public.arkanoid_weekly_awards
ORDER BY week_start DESC, rank ASC;

CREATE OR REPLACE FUNCTION public.award_arkanoid_week(
  p_week_start date DEFAULT public.arkanoid_week_start(now() - interval '7 days')
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_week date := public.arkanoid_week_start(now());
  v_inserted_count integer := 0;
  v_total_prize integer := 0;
  v_awards json;
BEGIN
  IF p_week_start >= v_current_week THEN
    RAISE EXCEPTION 'week_not_closed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.arkanoid_weekly_awards WHERE week_start = p_week_start) THEN
    SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
      INTO v_awards
    FROM (
      SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
      FROM public.arkanoid_weekly_awards
      WHERE week_start = p_week_start
      ORDER BY rank
    ) a;

    RETURN json_build_object(
      'ok', true,
      'already_awarded', true,
      'week_start', p_week_start,
      'awards', v_awards
    );
  END IF;

  WITH user_best AS (
    SELECT DISTINCT ON (s.user_id)
      s.user_id,
      s.nick_snapshot,
      s.score,
      s.duration_ms,
      s.submitted_at
    FROM public.arkanoid_scores s
    WHERE s.week_start = p_week_start
    ORDER BY s.user_id, s.score DESC, s.submitted_at ASC
  ),
  ranked AS (
    SELECT
      user_id,
      nick_snapshot,
      score,
      duration_ms,
      (ROW_NUMBER() OVER (ORDER BY score DESC, submitted_at ASC))::integer AS rank
    FROM user_best
  ),
  winners AS (
    SELECT
      user_id,
      nick_snapshot,
      rank,
      score,
      duration_ms,
      CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 WHEN 3 THEN 200 END AS prize_coins
    FROM ranked
    WHERE rank <= 3
  ),
  inserted AS (
    INSERT INTO public.arkanoid_weekly_awards
      (week_start, user_id, nick_snapshot, rank, score, duration_ms, prize_coins)
    SELECT p_week_start, user_id, nick_snapshot, rank, score, duration_ms, prize_coins
    FROM winners
    ON CONFLICT DO NOTHING
    RETURNING *
  ),
  credited AS (
    UPDATE public.profiles p
       SET coins = p.coins + i.prize_coins
      FROM inserted i
     WHERE p.id = i.user_id
     RETURNING i.prize_coins
  )
  SELECT COUNT(*)::integer, COALESCE(SUM(prize_coins), 0)::integer
    INTO v_inserted_count, v_total_prize
  FROM credited;

  SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.rank), '[]'::json)
    INTO v_awards
  FROM (
    SELECT rank, nick_snapshot AS nick, score, duration_ms, prize_coins
    FROM public.arkanoid_weekly_awards
    WHERE week_start = p_week_start
    ORDER BY rank
  ) a;

  RETURN json_build_object(
    'ok', true,
    'already_awarded', false,
    'week_start', p_week_start,
    'awards_created', v_inserted_count,
    'coins_awarded', v_total_prize,
    'awards', v_awards
  );
END;
$$;

REVOKE ALL ON FUNCTION public.arkanoid_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_arkanoid_week(date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.arkanoid_week_start(timestamptz) TO authenticated;
GRANT SELECT ON public.arkanoid_current_week, public.arkanoid_all_time, public.arkanoid_recent_awards
  TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'arkanoid_scores'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.arkanoid_scores;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'arkanoid_weekly_awards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.arkanoid_weekly_awards;
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Season-gated weekly award (the gate lives in seasonal_game_for_week(); the
-- cron command is only parsed at run time, so scheduling works even before the
-- updated season-award-gating.sql is applied — but apply it before Monday).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule(jobname)
    FROM cron.job
    WHERE jobname = 'arkanoid_weekly_awards';

    PERFORM cron.schedule(
      'arkanoid_weekly_awards',
      '0 22,23 * * 0',
      $cron$SELECT CASE
        WHEN EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0
          THEN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw')
        WHEN public.seasonal_game_for_week(public.arkanoid_week_start(now() - interval '7 days')) = 'arkanoid'
          THEN public.award_arkanoid_week(public.arkanoid_week_start(now() - interval '7 days'))
          ELSE json_build_object('ok', true, 'skipped', 'not_in_season') END;$cron$
    );
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
