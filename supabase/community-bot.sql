-- ════════════════════════════════════════════════════════════════════════════
--  🗳️ Głos Biura — the scheduled runs' own narrow door into the database
-- ════════════════════════════════════════════════════════════════════════════
--  Run AFTER community.sql. Idempotent.
--
--  The two scheduled Claude Code runs (docs/community-automation.md) cannot be
--  given the Supabase connector, so they call ONE function over the public REST
--  API with the anon key plus a bot key:
--
--    POST /rest/v1/rpc/community_bot  {"p_key": "...", "p_action": "...", "p_args": {...}}
--
--  The key is random; only its sha256 is stored here (community_bot_keys has no
--  client grants), and the plain key lives only in the scheduled tasks' prompts.
--  What the key can do is exactly the list below — read the queue and record
--  decisions through the same service-only RPCs community.sql defines. It can
--  NOT run SQL, touch other tables or move coins any other way. A leaked key is
--  rotated by deleting its row and inserting a new hash.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.community_bot_keys (
  key_sha256 text PRIMARY KEY,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.community_bot_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.community_bot_keys FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.community_bot(p_key text, p_action text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  a jsonb := coalesce(p_args, '{}'::jsonb);
  r json;
BEGIN
  IF p_key IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.community_bot_keys
        WHERE key_sha256 = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'bad_key';
  END IF;

  CASE p_action
  WHEN 'new_tickets' THEN
    SELECT coalesce(json_agg(t ORDER BY t.created_at), '[]'::json) INTO r FROM (
      SELECT id, kind, title, body, tab, client_meta, created_at
        FROM public.community_tickets WHERE status = 'new'
       ORDER BY created_at LIMIT 5) t;
  WHEN 'recent_tickets' THEN
    SELECT coalesce(json_agg(t ORDER BY t.created_at), '[]'::json) INTO r FROM (
      SELECT id, kind, title, status, rewarded_at, created_at
        FROM public.community_tickets
       WHERE created_at > now() - interval '30 days') t;
  WHEN 'open_ideas' THEN
    SELECT coalesce(json_agg(i ORDER BY i.week_start, i.votes DESC), '[]'::json) INTO r FROM (
      SELECT id, title, body, status, votes, week_start
        FROM public.community_ideas
       WHERE status IN ('open','won','building')) i;
  WHEN 'close_week' THEN
    r := public.community_close_week(public.community_week_start() - 7);
  WHEN 'mark_ticket' THEN
    r := public.community_mark_ticket((a->>'id')::uuid, a->>'status', a->>'severity', a->>'note',
                                      a->>'commit', a->>'pr_url', (a->>'duplicate_of')::uuid);
  WHEN 'mark_idea' THEN
    r := public.community_mark_idea((a->>'id')::uuid, a->>'status', a->>'note', a->>'commit', a->>'pr_url');
  WHEN 'fine' THEN
    r := public.community_fine(a->>'ref_kind', (a->>'id')::uuid, a->>'note');
  ELSE
    RAISE EXCEPTION 'bad_action';
  END CASE;
  RETURN r;
END;
$fn$;
REVOKE ALL ON FUNCTION public.community_bot(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.community_bot(text, text, jsonb) TO anon, authenticated;
