-- ═══════════════════════════════════════════════════════════════════════════
--  „🏛️ Wystawa" REMOVED from the 💎 NFT hub (owner's call, 2026-10-20)
-- ═══════════════════════════════════════════════════════════════════════════
--  Run after farm-nft-social.sql; idempotent. ⚠️ Re-run this after re-running
--  farm-nft-social.sql, which grants these functions to `authenticated` again.
--
--  The Wystawa was used once: the week of 2026-09-28 got one entry, no votes,
--  and settled without a prize, so no 🏆 ribbon exists and nothing is owed.
--  The tables and history stay; only the client entry points are closed.
--
--  An open entry would keep its card out of the Ołtarz (sacrifice_nft raises
--  nft_on_expo) with no UI left to withdraw it, so open weeks are cleared.
--  With the RPCs revoked nothing can settle them either (settle is lazy, run
--  only from these three), so clearing them loses nothing.
-- ═══════════════════════════════════════════════════════════════════════════

DELETE FROM public.farm_nft_expo_votes
 WHERE week_start >= public.farm_current_series_monday();
DELETE FROM public.farm_nft_expo_entries
 WHERE week_start >= public.farm_current_series_monday();

REVOKE EXECUTE ON FUNCTION public.farm_expo_state()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.farm_expo_enter(uuid)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.farm_expo_vote(uuid)   FROM PUBLIC, anon, authenticated;
