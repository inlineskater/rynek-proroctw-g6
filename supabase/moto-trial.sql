-- Moto Trial G6. Apply before season-award-gating.sql, last-active.sql and economy-stats.sql.
-- Physics/course v3 are immutable once a competitive week opens: any change ships as a new version with new course ids.
CREATE OR REPLACE FUNCTION public.moto_trial_week_start(p_ts timestamptz DEFAULT now()) RETURNS date
LANGUAGE sql STABLE SET search_path=public AS $$ SELECT date_trunc('week',p_ts AT TIME ZONE 'Europe/Warsaw')::date $$;
CREATE OR REPLACE FUNCTION public.moto_trial_course_for_week(p_week date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_week=DATE '2026-10-26' THEN 'mountain_v3' ELSE 'quarry_v3' END $$;
CREATE TABLE IF NOT EXISTS public.moto_trial_rounds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 nick_snapshot text NOT NULL, mode text NOT NULL CHECK(mode IN ('season','arcade')), week_start date NOT NULL,
 course_id text NOT NULL CHECK(course_id IN ('quarry_v3','mountain_v3')), version integer NOT NULL CHECK(version=3),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 submitted_at timestamptz, abandoned boolean NOT NULL DEFAULT false, result jsonb
);
CREATE INDEX IF NOT EXISTS moto_trial_rounds_user_idx ON public.moto_trial_rounds(user_id,started_at DESC);
CREATE TABLE IF NOT EXISTS public.moto_trial_scores (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),round_id uuid NOT NULL UNIQUE REFERENCES public.moto_trial_rounds(id),
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,nick_snapshot text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('season','arcade')),week_start date NOT NULL,course_id text NOT NULL CHECK(course_id IN ('quarry_v3','mountain_v3')),version integer NOT NULL CHECK(version=3),
 score integer NOT NULL CHECK(score BETWEEN 0 AND 10000),completed boolean NOT NULL,completion_ms integer,
 duration_ms integer NOT NULL,submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),client_meta jsonb NOT NULL DEFAULT '{}',
 CHECK((completed AND score=10000 AND completion_ms BETWEEN 1 AND 180000) OR (NOT completed AND score<10000 AND completion_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS moto_trial_scores_rank_idx ON public.moto_trial_scores(mode,week_start,course_id,score DESC,completion_ms,submitted_at);
CREATE TABLE IF NOT EXISTS public.moto_trial_weekly_awards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),week_start date NOT NULL,user_id uuid NOT NULL REFERENCES public.profiles(id),nick_snapshot text NOT NULL,
 course_id text NOT NULL,version integer NOT NULL,rank integer NOT NULL CHECK(rank BETWEEN 1 AND 3),score integer NOT NULL,completion_ms integer,
 prize_coins integer NOT NULL CHECK(prize_coins IN (1000,500,200)),awarded_at timestamptz NOT NULL DEFAULT now(),UNIQUE(week_start,rank),UNIQUE(week_start,user_id)
);
ALTER TABLE public.moto_trial_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moto_trial_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moto_trial_weekly_awards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS moto_round_read ON public.moto_trial_rounds;
CREATE POLICY moto_round_read ON public.moto_trial_rounds FOR SELECT TO authenticated USING(user_id=auth.uid());
DROP POLICY IF EXISTS moto_score_read ON public.moto_trial_scores;
CREATE POLICY moto_score_read ON public.moto_trial_scores FOR SELECT TO authenticated USING(true);
DROP POLICY IF EXISTS moto_award_read ON public.moto_trial_weekly_awards;
CREATE POLICY moto_award_read ON public.moto_trial_weekly_awards FOR SELECT TO authenticated USING(true);
REVOKE ALL ON public.moto_trial_rounds,public.moto_trial_scores,public.moto_trial_weekly_awards FROM anon,authenticated;
GRANT SELECT ON public.moto_trial_rounds,public.moto_trial_scores,public.moto_trial_weekly_awards TO authenticated;
CREATE OR REPLACE VIEW public.moto_trial_weekly_best WITH(security_invoker=true) AS
WITH best AS (
 SELECT DISTINCT ON(week_start,user_id) * FROM public.moto_trial_scores
 WHERE mode='season' AND course_id=public.moto_trial_course_for_week(week_start)
 ORDER BY week_start,user_id,score DESC,completion_ms ASC NULLS LAST,submitted_at,id
) SELECT row_number() OVER(PARTITION BY week_start ORDER BY score DESC,completion_ms ASC NULLS LAST,submitted_at,id)::integer AS rank,
 user_id,nick_snapshot AS nick,week_start,course_id,version,score,completed,completion_ms,duration_ms,submitted_at FROM best;
CREATE OR REPLACE VIEW public.moto_trial_current_week WITH(security_invoker=true) AS
 SELECT * FROM public.moto_trial_weekly_best WHERE week_start=public.moto_trial_week_start();
CREATE OR REPLACE VIEW public.moto_trial_all_time WITH(security_invoker=true) AS
WITH best AS (
 SELECT DISTINCT ON(course_id,user_id) * FROM public.moto_trial_scores
 ORDER BY course_id,user_id,score DESC,completion_ms ASC NULLS LAST,submitted_at,id
) SELECT row_number() OVER(PARTITION BY course_id ORDER BY score DESC,completion_ms ASC NULLS LAST,submitted_at,id)::integer AS rank,
 user_id,nick_snapshot AS nick,course_id,version,score,completed,completion_ms,duration_ms,submitted_at FROM best;
CREATE OR REPLACE VIEW public.moto_trial_recent_awards WITH(security_invoker=true) AS
 SELECT week_start,user_id,nick_snapshot AS nick,course_id,rank,score,completion_ms,prize_coins,awarded_at FROM public.moto_trial_weekly_awards;
GRANT SELECT ON public.moto_trial_weekly_best,public.moto_trial_current_week,public.moto_trial_all_time,public.moto_trial_recent_awards TO authenticated;
CREATE OR REPLACE FUNCTION public.award_moto_trial_week(p_week_start date DEFAULT public.moto_trial_week_start(now()-interval '7 days'))
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer; total integer;
BEGIN
 IF p_week_start>=public.moto_trial_week_start() THEN RAISE EXCEPTION 'week_not_closed'; END IF;
 IF public.seasonal_game_for_week(p_week_start)<>'moto_trial' THEN RETURN json_build_object('ok',true,'skipped',true); END IF;
 PERFORM pg_advisory_xact_lock(hashtext('moto_trial_award'),p_week_start-DATE '2000-01-01');
 WITH added AS (
 INSERT INTO public.moto_trial_weekly_awards(week_start,user_id,nick_snapshot,course_id,version,rank,score,completion_ms,prize_coins)
 SELECT week_start,user_id,nick,course_id,version,rank,score,completion_ms,CASE rank WHEN 1 THEN 1000 WHEN 2 THEN 500 ELSE 200 END
 FROM public.moto_trial_weekly_best WHERE week_start=p_week_start AND rank<=3 AND score>0
 ON CONFLICT DO NOTHING RETURNING user_id,prize_coins
 ), paid AS (UPDATE public.profiles p SET coins=p.coins+a.prize_coins FROM added a WHERE p.id=a.user_id RETURNING a.prize_coins)
 SELECT count(*),coalesce(sum(prize_coins),0) INTO n,total FROM paid;
 RETURN json_build_object('ok',true,'awards_created',n,'coins_awarded',total);
END $$;
REVOKE ALL ON FUNCTION public.award_moto_trial_week(date) FROM PUBLIC,anon,authenticated;
-- Block the generic client-reported arcade RPC too: server replay is mandatory.
CREATE OR REPLACE FUNCTION public.moto_trial_protect_arcade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.game_type='moto_trial' AND coalesce(auth.role(),'') IN ('anon','authenticated') THEN RAISE EXCEPTION 'server_replay_required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS moto_trial_protect_arcade ON public.arcade_scores;
CREATE TRIGGER moto_trial_protect_arcade BEFORE INSERT OR UPDATE ON public.arcade_scores FOR EACH ROW EXECUTE FUNCTION public.moto_trial_protect_arcade();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='moto_trial_scores') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.moto_trial_scores; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='moto_trial_weekly_awards') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.moto_trial_weekly_awards; END IF;
END $$;
SELECT cron.schedule('moto_trial_weekly_awards','0 22,23 * * 0',$cron$
 SELECT CASE WHEN extract(hour FROM now() AT TIME ZONE 'Europe/Warsaw')=0
 THEN public.award_moto_trial_week(public.moto_trial_week_start(now()-interval '7 days')) ELSE '{}'::json END;
$cron$);
