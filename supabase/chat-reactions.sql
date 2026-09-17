-- Czat G6 — reactions on messages + animated stickers („Naklejki")
-- Run after supabase/chat.sql. Idempotent: CREATE TABLE IF NOT EXISTS /
-- CREATE OR REPLACE / guarded publication. Safe to re-run.
--
-- Two features, one table:
--   • a REACTION is a row here: (message, user, code). Codes are either funny
--     emoji (laugh, fire, …) or one of our own animated stickers (wojownik_smiech,
--     krol_zly, …) drawn in CSS/SVG by tabs/chat-reactions.js — no image files.
--   • a STICKER MESSAGE needs no SQL at all: it is a normal chat_send() whose
--     body is exactly ':st:<code>:'. The client renders a known code as a big
--     animated sticker and falls back to the raw text for anything else.
--
-- ⚠️ Removing a reaction flips `active` to false; rows are NEVER deleted by the
-- RPC. Supabase realtime does not apply RLS to DELETE payloads, so deleting a
-- reaction on a whisper would broadcast (message id, user id, code) to every
-- connected client. UPDATEs are RLS-filtered like INSERTs, so a whisper's
-- reactions reach only its two parties. Don't "simplify" the toggle into DELETE.
--
-- The code whitelist lives in chat_react_codes() below and is mirrored by
-- CHAT_FX_EMOJI / CHAT_FX_STICKERS in tabs/chat-reactions.js — add a code in both.

-- ── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.chat_reactions (
  message_id bigint NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  user_id    uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code       text   NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, code)
);

CREATE INDEX IF NOT EXISTS chat_reactions_message_idx
  ON public.chat_reactions(message_id) WHERE active;

-- Throttle lookup: the caller's most recent reaction change.
CREATE INDEX IF NOT EXISTS chat_reactions_user_recent_idx
  ON public.chat_reactions(user_id, updated_at DESC);

-- ── RLS: same whisper boundary as chat_messages ────────────────────────────

ALTER TABLE public.chat_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_reactions_select" ON public.chat_reactions;
CREATE POLICY "chat_reactions_select" ON public.chat_reactions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.chat_messages m
     WHERE m.id = chat_reactions.message_id
       AND (m.recipient_id IS NULL OR auth.uid() IN (m.sender_id, m.recipient_id))
  ));

REVOKE ALL ON public.chat_reactions FROM anon, authenticated;
GRANT SELECT ON public.chat_reactions TO authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_reactions;
  END IF;
END;
$$;

-- ── Policy: valid codes ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.chat_react_codes()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    -- emoji (CHAT_FX_EMOJI)
    'laugh','fire','skull','clown','salute','monkey','money','goat',
    -- animated stickers (CHAT_FX_STICKERS)
    'wojownik_smiech','krol_zly','goblin_kasa','zloto_deszcz','smok_ogien',
    'lucznik_foch','swinka_wjazd','budowniczy_zzz','bum_bomba','puchar_taniec',
    'plan_placz','gg_wp'
  ]::text[];
$$;

-- Max distinct active reactions one user may put on one message.
CREATE OR REPLACE FUNCTION public.chat_react_max_per_message()
RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

-- ── RPC: chat_toggle_reaction ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.chat_toggle_reaction(p_message_id bigint, p_code text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_last   timestamptz;
  v_active boolean;
  v_count  int;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_code IS NULL OR NOT (p_code = ANY (public.chat_react_codes())) THEN
    RAISE EXCEPTION 'invalid_reaction';
  END IF;

  -- The message must exist and be visible to the caller (public or own whisper).
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_messages m
     WHERE m.id = p_message_id
       AND (m.recipient_id IS NULL OR v_user IN (m.sender_id, m.recipient_id))
  ) THEN
    RAISE EXCEPTION 'no_such_message';
  END IF;

  SELECT max(updated_at) INTO v_last FROM public.chat_reactions WHERE user_id = v_user;
  IF v_last IS NOT NULL AND now() - v_last < interval '300 milliseconds' THEN
    RAISE EXCEPTION 'too_fast';
  END IF;

  SELECT active INTO v_active
    FROM public.chat_reactions
   WHERE message_id = p_message_id AND user_id = v_user AND code = p_code
   FOR UPDATE;

  IF v_active IS TRUE THEN
    UPDATE public.chat_reactions
       SET active = false, updated_at = now()
     WHERE message_id = p_message_id AND user_id = v_user AND code = p_code;
    RETURN json_build_object('message_id', p_message_id, 'code', p_code, 'active', false);
  END IF;

  SELECT count(*) INTO v_count
    FROM public.chat_reactions
   WHERE message_id = p_message_id AND user_id = v_user AND active;
  IF v_count >= public.chat_react_max_per_message() THEN
    RAISE EXCEPTION 'too_many_reactions';
  END IF;

  INSERT INTO public.chat_reactions (message_id, user_id, code, active, updated_at)
  VALUES (p_message_id, v_user, p_code, true, now())
  ON CONFLICT (message_id, user_id, code) DO UPDATE
    SET active = true, updated_at = now();

  RETURN json_build_object('message_id', p_message_id, 'code', p_code, 'active', true);
END;
$$;

REVOKE ALL ON FUNCTION public.chat_toggle_reaction(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_toggle_reaction(bigint, text) TO authenticated;
