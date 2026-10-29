-- ════════════════════════════════════════════════════════════════════════════
--  🗳️ „Głos Biura" — the office decides what gets built, and reports bugs
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER: schema.sql, chat.sql, last-active.sql. Idempotent.
--  economy_stats() is patched IN PLACE at the bottom of this file (deployed
--  copies carry in-place patches the repo file lacks, so re-running
--  economy-stats.sql is not needed and not advised for this change).
--
--  ── Why ────────────────────────────────────────────────────────────────────
--  OSRS-style: players propose ideas, everyone votes, the weekly winner is
--  BUILT — by a scheduled Claude Code session (docs/community-automation.md),
--  not by the owner. The same session triages bug tickets every night.
--
--  ── Shape ──────────────────────────────────────────────────────────────────
--  Ideas belong to a Warsaw week (Monday). All week anyone may add up to
--  community_ideas_per_week() ideas and upvote as many as they like (never
--  their own). The Monday run calls community_close_week(): the most-voted idea
--  wins IF it has ≥ community_win_threshold() votes (half the players active in
--  14 days), the rest become 'lost'. When the build lands, community_mark_idea
--  (…'shipped'…) pays the author community_idea_reward() = 5 000 🪙 exactly once.
--
--  Tickets ('bug' / 'problem' / 'exploit') are public so duplicates are visible.
--  The nightly run ANALYSES each one: a real bug becomes 'confirmed' (and later
--  'fixing'/'fixed') and pays the reporter community_bug_reward() = 500 🪙 ONCE;
--  'not_a_bug' / 'duplicate' / 'needs_info' / 'wontfix' pay nothing. Only the
--  first report of a bug is paid — later ones are marked 'duplicate'.
--
--  Everything is public (owner's call, 2026-10-29): ideas, votes, tickets and
--  community_log, the event log of every submission, decision and payout with
--  Claude's reasoning. The one exception is an 'exploit' ticket's BODY while it
--  is still open — its title, status and log entries are public, the recipe is
--  not, until it is fixed or closed. A public "how to print coins" post would be
--  a worse bug than the one it reports.
--
--  ⚠️ The automation RPCs (close_week / mark_idea / mark_ticket) have NO client
--  grant. Only service_role / the SQL editor can call them, so a player cannot
--  mark their own idea shipped and collect the reward.
--  ABUSE FINE (owner's call, 2026-10-29): a ticket or idea that tries to get
--  something for nothing — "give me 1 000 000 coins", "make me admin", an
--  instruction aimed at the bot — is fined community_abuse_fine() = 500 🪙 by
--  community_fine(), once per item (`fined_at IS NULL` guard), never below 0
--  coins. The player gets a whisper explaining why and the room is told.
--  Honest feature/balance requests ("farm should pay more") are NOT abuse.
--
--  ⚠️ `community_idea_reward` and `community_bug_reward` are MINTS; the fine
--  (`community_abuse_fine`) is a BURN: it is in economy-stats.sql's
--  ledger_minted, tabs/stats.js's label chain (not NEUTRAL — it is income) and
--  ACT_COIN_REASONS in index.html.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Policy knobs ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.community_idea_reward()     RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 5000 $$;
CREATE OR REPLACE FUNCTION public.community_bug_reward()      RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 500 $$;
CREATE OR REPLACE FUNCTION public.community_abuse_fine()      RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 500 $$;
CREATE OR REPLACE FUNCTION public.community_ideas_per_week()  RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
CREATE OR REPLACE FUNCTION public.community_tickets_per_day() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

CREATE OR REPLACE FUNCTION public.community_week_start(p_ts timestamptz DEFAULT now())
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT date_trunc('week', p_ts AT TIME ZONE 'Europe/Warsaw')::date;
$$;

-- Half of the non-admin players active in the last 14 days, never below 2 — so
-- one player voting for a friend's idea can never decide a week on their own.
CREATE OR REPLACE FUNCTION public.community_win_threshold()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(2, ceil(count(*) / 2.0)::integer)
    FROM public.profiles
   WHERE NOT is_admin
     AND last_active_at > now() - interval '14 days';
$$;
GRANT EXECUTE ON FUNCTION public.community_win_threshold() TO authenticated;


-- ── Tables ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_ideas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  body        text NOT NULL DEFAULT '' CHECK (char_length(body) <= 1000),
  week_start  date NOT NULL,
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','won','building','shipped','rejected','lost')),
  votes       integer NOT NULL DEFAULT 0,   -- denormalised, maintained by the RPC
  note        text,                         -- Claude's player-facing note
  pr_url      text,
  commit_sha  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  shipped_at  timestamptz,
  rewarded_at timestamptz
);
CREATE INDEX IF NOT EXISTS community_ideas_week_idx   ON public.community_ideas (week_start, votes DESC);
CREATE INDEX IF NOT EXISTS community_ideas_status_idx ON public.community_ideas (status);

CREATE TABLE IF NOT EXISTS public.community_idea_votes (
  idea_id    uuid NOT NULL REFERENCES public.community_ideas(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.community_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'bug' CHECK (kind IN ('bug','problem','exploit')),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  body        text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  tab         text,
  client_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','confirmed','fixing','fixed','not_a_bug','wontfix','duplicate','needs_info','abuse')),
  severity    text CHECK (severity IN ('low','medium','high','critical')),
  note        text,                         -- Claude's assessment, player-facing
  pr_url      text,
  commit_sha  text,
  duplicate_of uuid REFERENCES public.community_tickets(id) ON DELETE SET NULL,
  rewarded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- The status CHECK changed after the first version of this file; re-assert it.
ALTER TABLE public.community_tickets DROP CONSTRAINT IF EXISTS community_tickets_status_check;
ALTER TABLE public.community_tickets ADD CONSTRAINT community_tickets_status_check
  CHECK (status IN ('new','confirmed','fixing','fixed','not_a_bug','wontfix','duplicate','needs_info','abuse'));
ALTER TABLE public.community_tickets ADD COLUMN IF NOT EXISTS fined_at timestamptz;
ALTER TABLE public.community_ideas   ADD COLUMN IF NOT EXISTS fined_at timestamptz;

-- The public log: one row per submission, decision, status change and payout.
-- Written only by the RPCs below; everyone reads it.
CREATE TABLE IF NOT EXISTS public.community_log (
  id         bigserial PRIMARY KEY,
  ref_kind   text NOT NULL CHECK (ref_kind IN ('idea','ticket','week')),
  ref_id     uuid,
  user_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,  -- whom it concerns
  actor      text NOT NULL DEFAULT 'claude' CHECK (actor IN ('claude','player')),
  event      text NOT NULL,      -- submitted / won / lost / status / reward / fine / closed
  status     text,
  title      text,
  note       text,
  coins      integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_log_time_idx ON public.community_log (created_at DESC);
CREATE INDEX IF NOT EXISTS community_log_ref_idx  ON public.community_log (ref_id, created_at);
CREATE INDEX IF NOT EXISTS community_tickets_status_idx ON public.community_tickets (status, created_at);
CREATE INDEX IF NOT EXISTS community_tickets_author_idx ON public.community_tickets (author_id, created_at DESC);


-- ── RLS: public read (exploits private), no client write ───────────────────
ALTER TABLE public.community_ideas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_idea_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_tickets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_log        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS community_ideas_select ON public.community_ideas;
CREATE POLICY community_ideas_select ON public.community_ideas
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS community_votes_select ON public.community_idea_votes;
CREATE POLICY community_votes_select ON public.community_idea_votes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS community_tickets_select ON public.community_tickets;
CREATE POLICY community_tickets_select ON public.community_tickets
  FOR SELECT TO authenticated
  USING (kind <> 'exploit' OR status IN ('fixed','not_a_bug','wontfix','duplicate','abuse')
         OR author_id = auth.uid() OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS community_log_select ON public.community_log;
CREATE POLICY community_log_select ON public.community_log
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.community_ideas      FROM anon, authenticated;
REVOKE ALL ON public.community_idea_votes FROM anon, authenticated;
REVOKE ALL ON public.community_tickets    FROM anon, authenticated;
GRANT SELECT ON public.community_ideas      TO authenticated;
GRANT SELECT ON public.community_idea_votes TO authenticated;
GRANT SELECT ON public.community_tickets    TO authenticated;
REVOKE ALL ON public.community_log FROM anon, authenticated;
GRANT SELECT ON public.community_log TO authenticated;


-- ── Chat announcer ─────────────────────────────────────────────────────────
-- Same pattern as farm-world-events.sql: a room message sent as the admin
-- profile under its own display name.
CREATE OR REPLACE FUNCTION public.community_announce(p_msg text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_admin uuid;
BEGIN
  IF to_regclass('public.chat_messages') IS NULL THEN RETURN; END IF;
  SELECT id INTO v_admin FROM public.profiles WHERE is_admin ORDER BY created_at LIMIT 1;
  IF v_admin IS NOT NULL THEN
    INSERT INTO public.chat_messages (sender_id, recipient_id, sender_nick, body)
    VALUES (v_admin, NULL, '🗳️ Głos Biura', left(p_msg, 1000));
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.community_announce(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.community_log_event(
  p_ref_kind text, p_ref_id uuid, p_user uuid, p_actor text, p_event text,
  p_status text, p_title text, p_note text, p_coins integer DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  INSERT INTO public.community_log (ref_kind, ref_id, user_id, actor, event, status, title, note, coins)
  VALUES (p_ref_kind, p_ref_id, p_user, p_actor, p_event, p_status, left(p_title, 120), left(p_note, 1000), p_coins);
$fn$;
REVOKE ALL ON FUNCTION public.community_log_event(text, uuid, uuid, text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;


-- ── Player RPCs ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.community_submit_idea(p_title text, p_body text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_week  date := public.community_week_start();
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
  v_n     integer;
  v_last  timestamptz;
  v_id    uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF char_length(v_title) < 3 OR char_length(v_title) > 80 THEN RAISE EXCEPTION 'bad_title'; END IF;
  IF char_length(v_body) > 1000 THEN RAISE EXCEPTION 'body_too_long'; END IF;

  -- Serialise one player's submissions so two quick clicks can't both pass the cap.
  PERFORM pg_advisory_xact_lock(hashtext('community_idea:' || v_user::text));
  SELECT count(*), max(created_at) INTO v_n, v_last
    FROM public.community_ideas WHERE author_id = v_user AND week_start = v_week;
  IF v_n >= public.community_ideas_per_week() THEN RAISE EXCEPTION 'idea_limit'; END IF;
  IF v_last > now() - interval '30 seconds' THEN RAISE EXCEPTION 'too_fast'; END IF;

  INSERT INTO public.community_ideas (author_id, title, body, week_start)
  VALUES (v_user, v_title, v_body, v_week)
  RETURNING id INTO v_id;
  PERFORM public.community_log_event('idea', v_id, v_user, 'player', 'submitted', 'open', v_title, NULL);
  RETURN json_build_object('ok', true, 'id', v_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.community_toggle_vote(p_idea uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_idea  public.community_ideas%ROWTYPE;
  v_voted boolean;
  v_votes integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_idea FROM public.community_ideas WHERE id = p_idea FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_idea.status <> 'open' OR v_idea.week_start <> public.community_week_start() THEN
    RAISE EXCEPTION 'voting_closed';
  END IF;
  IF v_idea.author_id = v_user THEN RAISE EXCEPTION 'own_idea'; END IF;

  DELETE FROM public.community_idea_votes WHERE idea_id = p_idea AND user_id = v_user;
  IF FOUND THEN
    v_voted := false;
  ELSE
    INSERT INTO public.community_idea_votes (idea_id, user_id) VALUES (p_idea, v_user);
    v_voted := true;
  END IF;

  UPDATE public.community_ideas
     SET votes = (SELECT count(*) FROM public.community_idea_votes WHERE idea_id = p_idea)
   WHERE id = p_idea
  RETURNING votes INTO v_votes;
  RETURN json_build_object('ok', true, 'voted', v_voted, 'votes', v_votes);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.community_submit_ticket(
  p_kind text, p_title text, p_body text, p_tab text, p_meta jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user  uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
  v_n     integer;
  v_id    uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_kind NOT IN ('bug','problem','exploit') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF char_length(v_title) < 3 OR char_length(v_title) > 120 THEN RAISE EXCEPTION 'bad_title'; END IF;
  IF char_length(v_body) > 2000 THEN RAISE EXCEPTION 'body_too_long'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('community_ticket:' || v_user::text));
  SELECT count(*) INTO v_n FROM public.community_tickets
   WHERE author_id = v_user AND created_at > now() - interval '1 day';
  IF v_n >= public.community_tickets_per_day() THEN RAISE EXCEPTION 'ticket_limit'; END IF;

  INSERT INTO public.community_tickets (author_id, kind, title, body, tab, client_meta)
  VALUES (v_user, p_kind, v_title, v_body, left(p_tab, 40),
          CASE WHEN jsonb_typeof(p_meta) = 'object' AND length(p_meta::text) <= 2000
               THEN p_meta ELSE '{}'::jsonb END)
  RETURNING id INTO v_id;
  PERFORM public.community_log_event('ticket', v_id, v_user, 'player', 'submitted', 'new',
    CASE WHEN p_kind = 'exploit' THEN '🔒 ' || v_title ELSE v_title END, NULL);
  RETURN json_build_object('ok', true, 'id', v_id);
END;
$fn$;

-- Everything the tab needs in one round trip.
CREATE OR REPLACE FUNCTION public.community_state()
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT json_build_object(
    'week_start', public.community_week_start(),
    'threshold',  public.community_win_threshold(),
    'reward',     public.community_idea_reward(),
    'ideas_per_week', public.community_ideas_per_week(),
    'ideas', COALESCE((
      SELECT json_agg(x ORDER BY x.votes DESC, x.created_at) FROM (
        SELECT i.id, i.title, i.body, i.status, i.votes, i.note, i.created_at,
               i.author_id, p.nick AS author_nick,
               EXISTS (SELECT 1 FROM public.community_idea_votes v
                        WHERE v.idea_id = i.id AND v.user_id = auth.uid()) AS my_vote
          FROM public.community_ideas i JOIN public.profiles p ON p.id = i.author_id
         WHERE i.week_start = public.community_week_start()
      ) x), '[]'::json),
    'history', COALESCE((
      SELECT json_agg(x ORDER BY x.week_start DESC) FROM (
        SELECT i.id, i.title, i.body, i.status, i.votes, i.note, i.week_start,
               i.pr_url, i.commit_sha, i.shipped_at, p.nick AS author_nick
          FROM public.community_ideas i JOIN public.profiles p ON p.id = i.author_id
         WHERE i.status IN ('won','building','shipped')
            OR (i.status = 'rejected' AND i.decided_at IS NOT NULL AND i.week_start < public.community_week_start())
         ORDER BY i.week_start DESC LIMIT 30
      ) x), '[]'::json),
    'tickets', COALESCE((
      SELECT json_agg(x ORDER BY x.created_at DESC) FROM (
        -- Every ticket is listed; only an OPEN exploit's body is withheld.
        SELECT t.id, t.kind, t.title,
               CASE WHEN t.kind = 'exploit'
                     AND t.status NOT IN ('fixed','not_a_bug','wontfix','duplicate','abuse')
                     AND t.author_id IS DISTINCT FROM auth.uid()
                     AND NOT public.is_admin(auth.uid())
                    THEN NULL ELSE t.body END AS body,
               t.tab, t.status, t.severity, t.note, t.commit_sha, t.duplicate_of,
               t.rewarded_at, t.fined_at, t.created_at, t.updated_at, t.author_id, p.nick AS author_nick
          FROM public.community_tickets t JOIN public.profiles p ON p.id = t.author_id
         ORDER BY t.created_at DESC LIMIT 80
      ) x), '[]'::json),
    -- Every idea, newest first, for the 📜 Dziennik table (one row per idea).
    'all_ideas', COALESCE((
      SELECT json_agg(x ORDER BY x.created_at DESC) FROM (
        SELECT i.id, i.title, i.status, i.votes, i.note, i.week_start, i.commit_sha,
               i.rewarded_at, i.fined_at, i.created_at, p.nick AS author_nick
          FROM public.community_ideas i JOIN public.profiles p ON p.id = i.author_id
         ORDER BY i.created_at DESC LIMIT 80
      ) x), '[]'::json),
    'bug_reward', public.community_bug_reward(),
    'abuse_fine', public.community_abuse_fine(),
    'log', COALESCE((
      SELECT json_agg(x ORDER BY x.created_at DESC) FROM (
        SELECT l.id, l.ref_kind, l.ref_id, l.actor, l.event, l.status, l.title, l.note,
               l.coins, l.created_at, p.nick
          FROM public.community_log l LEFT JOIN public.profiles p ON p.id = l.user_id
         ORDER BY l.created_at DESC LIMIT 150
      ) x), '[]'::json)
  );
$fn$;

REVOKE ALL ON FUNCTION public.community_submit_idea(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.community_toggle_vote(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.community_submit_ticket(text, text, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.community_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.community_submit_idea(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_toggle_vote(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_submit_ticket(text, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.community_state() TO authenticated;


-- ── Automation RPCs (service_role / SQL editor only) ───────────────────────
-- Close a finished week: the top idea wins if it reached the threshold.
-- Idempotent — a week that already has a decided idea is left alone.
CREATE OR REPLACE FUNCTION public.community_close_week(p_week date)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_thr    integer := public.community_win_threshold();
  v_winner public.community_ideas%ROWTYPE;
  v_nick   text;
BEGIN
  IF p_week >= public.community_week_start() THEN RAISE EXCEPTION 'week_not_over'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('community_close_week'));

  IF EXISTS (SELECT 1 FROM public.community_ideas
              WHERE week_start = p_week AND status IN ('won','building','shipped')) THEN
    RETURN json_build_object('ok', true, 'already_closed', true);
  END IF;

  SELECT * INTO v_winner FROM public.community_ideas
   WHERE week_start = p_week AND status = 'open' AND votes >= v_thr
   ORDER BY votes DESC, created_at
   LIMIT 1;

  WITH lost AS (
    UPDATE public.community_ideas
       SET status = 'lost', decided_at = now()
     WHERE week_start = p_week AND status = 'open'
       AND id IS DISTINCT FROM v_winner.id
    RETURNING id, author_id, title, votes
  )
  INSERT INTO public.community_log (ref_kind, ref_id, user_id, event, status, title, note)
  SELECT 'idea', id, author_id, 'lost', 'lost', title, votes || ' głosów (próg ' || v_thr || ')'
    FROM lost;

  IF v_winner.id IS NULL THEN
    PERFORM public.community_log_event('week', NULL, NULL, 'claude', 'closed', NULL,
      'Tydzień od ' || to_char(p_week, 'DD.MM'), 'Żaden pomysł nie osiągnął progu ' || v_thr || ' głosów.');
    RETURN json_build_object('ok', true, 'winner', NULL, 'threshold', v_thr);
  END IF;

  UPDATE public.community_ideas SET status = 'won', decided_at = now() WHERE id = v_winner.id;
  PERFORM public.community_log_event('idea', v_winner.id, v_winner.author_id, 'claude', 'won', 'won',
    v_winner.title, v_winner.votes || ' głosów (próg ' || v_thr || ')');
  SELECT nick INTO v_nick FROM public.profiles WHERE id = v_winner.author_id;
  PERFORM public.community_announce(
    '🏆 Pomysł tygodnia wygrał: „' || v_winner.title || '” (' || coalesce(v_nick, '?') || ', '
    || v_winner.votes || ' głosów). Zaczynam budować!');
  RETURN json_build_object('ok', true, 'winner', v_winner.id, 'title', v_winner.title,
                           'votes', v_winner.votes, 'threshold', v_thr);
END;
$fn$;

-- Status change for an idea. 'shipped' pays the author ONCE: the reward is
-- guarded by `rewarded_at IS NULL` on the UPDATE itself, not by a prior SELECT.
CREATE OR REPLACE FUNCTION public.community_mark_idea(
  p_id uuid, p_status text, p_note text DEFAULT NULL,
  p_commit text DEFAULT NULL, p_pr_url text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_idea   public.community_ideas%ROWTYPE;
  v_author uuid;
  v_reward integer := public.community_idea_reward();
  v_paid   boolean := false;
  v_nick   text;
  v_prev   text;
BEGIN
  IF p_status NOT IN ('open','won','building','shipped','rejected','lost') THEN
    RAISE EXCEPTION 'bad_status';
  END IF;
  SELECT status INTO v_prev FROM public.community_ideas WHERE id = p_id FOR UPDATE;
  UPDATE public.community_ideas
     SET status = p_status,
         note = coalesce(p_note, note),
         commit_sha = coalesce(p_commit, commit_sha),
         pr_url = coalesce(p_pr_url, pr_url),
         decided_at = coalesce(decided_at, CASE WHEN p_status <> 'open' THEN now() END),
         shipped_at = CASE WHEN p_status = 'shipped' THEN coalesce(shipped_at, now()) ELSE shipped_at END
   WHERE id = p_id
  RETURNING * INTO v_idea;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF p_status = 'shipped' THEN
    UPDATE public.community_ideas SET rewarded_at = now()
     WHERE id = p_id AND rewarded_at IS NULL
    RETURNING author_id INTO v_author;
    IF v_author IS NOT NULL THEN
      UPDATE public.profiles SET coins = coins + v_reward WHERE id = v_author;
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (v_author, v_reward, 'community_idea_reward',
              jsonb_build_object('idea_id', p_id, 'title', v_idea.title));
      v_paid := true;
      PERFORM public.community_log_event('idea', p_id, v_author, 'claude', 'reward', 'shipped',
        v_idea.title, 'Nagroda za zwycięski pomysł', v_reward);
    END IF;
  END IF;
  IF p_status IS DISTINCT FROM v_prev THEN
    PERFORM public.community_log_event('idea', p_id, v_idea.author_id, 'claude', 'status', p_status,
      v_idea.title, p_note);
  END IF;

  SELECT nick INTO v_nick FROM public.profiles WHERE id = v_idea.author_id;
  IF p_status = 'shipped' AND v_paid THEN
    PERFORM public.community_announce(
      '🚀 Gotowe! Pomysł „' || v_idea.title || '” jest już na portalu. '
      || coalesce(v_nick, 'Autor') || ' dostaje ' || v_reward || ' 🪙. Odśwież stronę.'
      || coalesce(' ' || p_note, ''));
  ELSIF p_status = 'building' AND v_prev IS DISTINCT FROM 'building' THEN
    PERFORM public.community_announce('🛠️ „' || v_idea.title || '”: ' || coalesce(p_note, 'w budowie.'));
  ELSIF p_status = 'rejected' AND v_prev IS DISTINCT FROM 'rejected' THEN
    PERFORM public.community_announce('❌ Pomysł „' || v_idea.title || '” odrzucony: ' || coalesce(p_note, '—'));
  END IF;

  RETURN json_build_object('ok', true, 'status', p_status, 'paid', v_paid);
END;
$fn$;

-- Claude's verdict on a ticket. 'confirmed' / 'fixing' / 'fixed' all mean
-- "this is a REAL bug" and pay the reporter community_bug_reward() once
-- (`rewarded_at IS NULL` on the UPDATE is the double-pay guard). Every other
-- status pays nothing. p_duplicate_of links a duplicate to the paid original.
CREATE OR REPLACE FUNCTION public.community_mark_ticket(
  p_id uuid, p_status text, p_severity text DEFAULT NULL, p_note text DEFAULT NULL,
  p_commit text DEFAULT NULL, p_pr_url text DEFAULT NULL, p_duplicate_of uuid DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_t      public.community_tickets%ROWTYPE;
  v_prev   text;
  v_author uuid;
  v_reward integer := public.community_bug_reward();
  v_paid   boolean := false;
  v_title  text;
BEGIN
  SELECT status INTO v_prev FROM public.community_tickets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  UPDATE public.community_tickets
     SET status = p_status,
         severity = coalesce(p_severity, severity),
         note = coalesce(p_note, note),
         commit_sha = coalesce(p_commit, commit_sha),
         pr_url = coalesce(p_pr_url, pr_url),
         duplicate_of = coalesce(p_duplicate_of, duplicate_of),
         updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_t;

  v_title := CASE WHEN v_t.kind = 'exploit' THEN '🔒 ' || v_t.title ELSE v_t.title END;

  IF p_status IN ('confirmed','fixing','fixed') THEN
    UPDATE public.community_tickets SET rewarded_at = now()
     WHERE id = p_id AND rewarded_at IS NULL
    RETURNING author_id INTO v_author;
    IF v_author IS NOT NULL THEN
      UPDATE public.profiles SET coins = coins + v_reward WHERE id = v_author;
      INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
      VALUES (v_author, v_reward, 'community_bug_reward',
              jsonb_build_object('ticket_id', p_id, 'title', v_title));
      v_paid := true;
      PERFORM public.community_log_event('ticket', p_id, v_author, 'claude', 'reward', p_status,
        v_title, 'Nagroda za zgłoszenie prawdziwego błędu', v_reward);
    END IF;
  END IF;

  IF p_status IS DISTINCT FROM v_prev OR p_note IS NOT NULL THEN
    PERFORM public.community_log_event('ticket', p_id, v_t.author_id, 'claude', 'status', p_status,
      v_title, p_note);
  END IF;

  IF p_status = 'fixed' AND v_prev <> 'fixed' THEN
    PERFORM public.community_announce('🐞✅ Naprawione: „' || v_title || '”. Dzięki za zgłoszenie!');
  ELSIF v_paid THEN
    PERFORM public.community_announce('🐞 Potwierdzony błąd: „' || v_title || '” — zgłaszający dostaje '
      || v_reward || ' 🪙.');
  END IF;
  RETURN json_build_object('ok', true, 'status', p_status, 'paid', v_paid);
END;
$fn$;

-- Fine an abuse attempt. p_ref_kind = 'ticket' | 'idea'. Marks the item
-- ('abuse' / 'rejected'), burns up to community_abuse_fine() coins ONCE, whispers
-- the player and announces it in the room.
CREATE OR REPLACE FUNCTION public.community_fine(p_ref_kind text, p_id uuid, p_note text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_user  uuid;
  v_title text;
  v_fine  integer;
  v_nick  text;
  v_admin uuid;
BEGIN
  IF coalesce(btrim(p_note), '') = '' THEN RAISE EXCEPTION 'note_required'; END IF;
  IF p_ref_kind = 'ticket' THEN
    UPDATE public.community_tickets
       SET status = 'abuse', note = p_note, fined_at = now(), updated_at = now()
     WHERE id = p_id AND fined_at IS NULL
    RETURNING author_id, title INTO v_user, v_title;
  ELSIF p_ref_kind = 'idea' THEN
    UPDATE public.community_ideas
       SET status = 'rejected', note = p_note, fined_at = now(), decided_at = coalesce(decided_at, now())
     WHERE id = p_id AND fined_at IS NULL
    RETURNING author_id, title INTO v_user, v_title;
  ELSE
    RAISE EXCEPTION 'bad_ref_kind';
  END IF;
  IF v_user IS NULL THEN RETURN json_build_object('ok', true, 'already_fined', true); END IF;

  -- Never below 0 coins: take the fine or whatever is left, whichever is less.
  SELECT nick, LEAST(GREATEST(coins, 0), public.community_abuse_fine())::integer
    INTO v_nick, v_fine
    FROM public.profiles WHERE id = v_user FOR UPDATE;
  UPDATE public.profiles SET coins = coins - v_fine WHERE id = v_user;
  IF v_fine > 0 THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    VALUES (v_user, -v_fine, 'community_abuse_fine',
            jsonb_build_object('ref_kind', p_ref_kind, 'ref_id', p_id, 'title', v_title, 'note', p_note));
  END IF;
  PERFORM public.community_log_event(p_ref_kind, p_id, v_user, 'claude', 'fine',
    CASE WHEN p_ref_kind = 'ticket' THEN 'abuse' ELSE 'rejected' END, v_title, p_note, -v_fine);

  IF to_regclass('public.chat_messages') IS NOT NULL THEN
    SELECT id INTO v_admin FROM public.profiles WHERE is_admin ORDER BY created_at LIMIT 1;
    IF v_admin IS NOT NULL AND v_admin <> v_user THEN
      INSERT INTO public.chat_messages (sender_id, recipient_id, sender_nick, body)
      VALUES (v_admin, v_user, '🗳️ Głos Biura', left(
        '⚖️ Kara ' || v_fine || ' 🪙 za zgłoszenie „' || v_title || '”. Powód: ' || p_note
        || ' Zgłoszenia i pomysły służą do ulepszania portalu, nie do wyłudzania monet.', 1000));
    END IF;
  END IF;
  PERFORM public.community_announce('⚖️ ' || coalesce(v_nick, 'Gracz') || ' dostaje karę ' || v_fine
    || ' 🪙 za próbę wyłudzenia przez ' || CASE WHEN p_ref_kind = 'ticket' THEN 'zgłoszenie' ELSE 'pomysł' END
    || ' („' || v_title || '”). ' || p_note);
  RETURN json_build_object('ok', true, 'fined', v_fine, 'user', v_user);
END;
$fn$;
REVOKE ALL ON FUNCTION public.community_fine(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.community_fine(text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.community_close_week(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.community_mark_idea(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.community_mark_ticket(uuid, text, text, text, text, text);
REVOKE ALL ON FUNCTION public.community_mark_ticket(uuid, text, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.community_close_week(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.community_mark_idea(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.community_mark_ticket(uuid, text, text, text, text, text, uuid) TO service_role;


-- ── Realtime ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.community_ideas;   EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.community_log;     EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;


-- ── economy_stats(): count the rewards as minted and the fine as burned ─────
-- Same in-place technique as lottery-draw.sql: the live definition carries
-- patches (lottery, hybrid stat_value) that supabase/economy-stats.sql may not,
-- so it is edited where it stands. Guarded + idempotent; RAISEs if an anchor
-- is missing instead of silently doing nothing.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'economy_stats'
   LIMIT 1;
  IF v_def IS NULL THEN
    RAISE NOTICE 'economy_stats() not installed — skipping (economy-stats.sql already lists the reasons).';
    RETURN;
  END IF;
  IF position('community_idea_reward' IN v_def) > 0 THEN
    RAISE NOTICE 'economy_stats() already counts Głos Biura — nothing to patch.';
    RETURN;
  END IF;
  v_new := replace(v_def, '''bank_share_buyback'')',
    '''bank_share_buyback'',''community_idea_reward'',''community_bug_reward'')');
  v_new := replace(v_new, '''bank_share_buy'')',
    '''bank_share_buy'',''community_abuse_fine'')');
  IF position('community_idea_reward' IN v_new) = 0 OR position('community_abuse_fine' IN v_new) = 0 THEN
    RAISE EXCEPTION 'economy_stats(): reason lists not found — add the community_* reasons by hand (see supabase/community.sql).';
  END IF;
  EXECUTE v_new;
  RAISE NOTICE 'economy_stats(): Głos Biura reasons added.';
END $$;

NOTIFY pgrst, 'reload schema';
