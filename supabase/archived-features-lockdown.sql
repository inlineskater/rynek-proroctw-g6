-- ═══════════════════════════════════════════════════════════════════════════
--  Archived features lockdown (2026-10-20)
-- ═══════════════════════════════════════════════════════════════════════════
--  archive.sql only closed the ROUTES of the nine archived tabs (Rynki,
--  Mundial, Ruletka, Sloty, Poker, Miny, Rakieta, Koło Żubra, Wspólne Płótno):
--  a tab left open from before the deploy, or a direct API call, could still
--  bet, trade and paint. This file closes the server-side write paths that are
--  plain SQL RPCs. The other seven archived features write only through their
--  Edge Functions, which now refuse every mutating action with
--  `code: "feature_archived"` and keep serving `state`/`history` reads.
--
--  Closed here (EXECUTE revoked from PUBLIC, anon and authenticated):
--    place_bet      — Rynki: buy YES/NO shares
--    create_market  — Rynki: open a new market
--    resolve_market — Rynki: settle a market (pays out)
--    place_pixel    — Wspólne Płótno: paint a pixel
--  Every overload is covered (the loop matches by name), so a stale 3-arg
--  create_market from an old prod-hardening.sql run can't stay open either.
--
--  Reads are untouched: SELECT on markets/trades/football_*/canvas_pixels/…
--  stays granted, so 📦 Archiwum (archive_summary()) and 📈 Statystyki
--  (Trafność reads markets) keep working. No other client-callable write RPC
--  exists for these features on prod (checked 2026-10-20 against pg_proc).
--
--  Checked before revoking (prod, 2026-10-20): 0 unresolved markets, every
--  football bet settled (258 won / 275 lost), no open roulette/wheel bets, no
--  roulette seats, poker holds only the 3 bot seats, no active mines/crash
--  round. Nobody had coins sitting in a closed feature.
--
--  ⚠️ Re-running schema.sql, prod-hardening.sql, security-fixes-2026-07-18.sql,
--  canvas.sql, canvas-free-for-all.sql or canvas-paint-log.sql re-GRANTs these
--  functions — re-run this file after any of them.
--
--  To reopen a feature: remove it from ARCHIVED_TABS in index.html, GRANT
--  EXECUTE on its functions back to authenticated, and drop the archive guard
--  from its Edge Function.
--
--  An admin can still settle a market from the SQL editor (postgres keeps
--  EXECUTE; resolve_market reads auth.uid(), so supply an admin's id):
--    BEGIN;
--    SELECT set_config('request.jwt.claims', '{"sub":"<admin uuid>"}', true);
--    SELECT public.resolve_market('<market uuid>', 'YES');
--    COMMIT;
--
--  Idempotent. Run after archive.sql.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('place_bet', 'create_market', 'resolve_market', 'place_pixel')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    RAISE NOTICE 'archived-features-lockdown: revoked %', f;
  END LOOP;
END $$;

-- Verify: every row must say false.
SELECT p.oid::regprocedure AS fn,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('place_bet', 'create_market', 'resolve_market', 'place_pixel')
 ORDER BY 1;
