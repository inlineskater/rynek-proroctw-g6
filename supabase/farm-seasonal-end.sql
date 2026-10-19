-- ═══════════════════════════════════════════════════════════════════════════
--  „🏆 Wyzwanie tygodnia" — END OF THE WEEKLY FARM CONTRACTS (2026-10-20)
-- ═══════════════════════════════════════════════════════════════════════════
--  Owner's call: the week of 2026-10-19 (🎃 Dynia)
--  is the LAST weekly crop contract. It runs and pays out normally — the
--  Monday 2026-10-26 00:00 Warsaw award cron (and the hourly catch-up in
--  farm-seasonal-award-reliability.sql) settle it like every week before it.
--  From 2026-10-26 on, no new contract is ever created.
--
--  Run after farm-seasonal-contracts.sql + farm-seasonal-award-reliability.sql;
--  idempotent. ⚠️ Re-run this after re-running either of those files — both
--  own a function redefined here and would quietly restart the contracts.
--
--  ONE switch, farm_seasonal_species_for_week(), does the real work: every
--  path that creates an event (sell_crop_to_npc in anti-inflation.sql, the
--  display RPC, the award) only acts when it returns a species, and
--  farm-orders.sql's „never the contract crop" test is IS DISTINCT FROM, so a
--  NULL simply lets every crop back into the mix orders. The two other
--  redefinitions only stop functions that would otherwise RAISE once there is
--  no species (seasonal_event_no_species) from turning into weekly cron errors.
--
--  Nothing is deleted: past events, sales, awards and the leaderboards stay
--  readable, and the client mirror (FARM_SEASONAL_LAST_WEEK in index.html)
--  hides the 🏆 Wyzwanie tab from the same week.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.farm_seasonal_last_week()
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$ SELECT DATE '2026-10-19'; $$;

CREATE OR REPLACE FUNCTION public.farm_seasonal_species_for_week(p_week_start date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_week_start < DATE '2026-07-06' THEN NULL
    WHEN p_week_start > public.farm_seasonal_last_week() THEN NULL
    ELSE (ARRAY[
      'carrot',
      'potato',
      'tomato',
      'corn',
      'chili',
      'strawberry',
      'pumpkin',
      'grapes',
      'pineapple'
    ])[
      (((p_week_start - DATE '2026-07-06') / 7) % 9) + 1
    ]
  END;
$$;

-- The client calls this on every Wyzwanie/price render; after the end it
-- answers „ended" instead of raising seasonal_event_no_species.
CREATE OR REPLACE FUNCTION public.farm_ensure_seasonal_display_event()
RETURNS json
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_week date := public.farm_seasonal_week_start(now());
  v_event public.farm_seasonal_events%ROWTYPE;
BEGIN
  IF v_week < DATE '2026-07-06' THEN
    v_week := DATE '2026-07-06';
  END IF;
  IF v_week > public.farm_seasonal_last_week() THEN
    RETURN json_build_object('ok', true, 'ended', true,
      'last_week', public.farm_seasonal_last_week());
  END IF;

  v_event := public.ensure_farm_seasonal_event(v_week);
  RETURN json_build_object('ok', true, 'event_id', v_event.id, 'week_start', v_event.week_start);
END;
$$;

-- award_farm_seasonal_week() calls ensure_farm_seasonal_event(), which would
-- RAISE for every week after the last one — skip those here so the Monday
-- cron reports „skipped" instead of failing every week forever. 2026-10-26
-- still pays the 2026-10-19 week (it is not > last week).
CREATE OR REPLACE FUNCTION public.award_farm_seasonal_week_cron()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_attempt integer := 0;
  v_max     integer := 5;
  v_week    date := public.farm_seasonal_week_start(now() - interval '7 days');
  v_result  json;
BEGIN
  -- DST-safe gate: the cron fires at both 22:00 and 23:00 UTC (the two hours
  -- that can be Warsaw midnight); act only when it is genuinely 00:xx Warsaw.
  IF EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Warsaw'))::integer <> 0 THEN
    RETURN json_build_object('ok', true, 'skipped', 'not_midnight_warsaw');
  END IF;
  IF v_week > public.farm_seasonal_last_week() THEN
    RETURN json_build_object('ok', true, 'skipped', 'contracts_ended', 'week_start', v_week);
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_result := public.award_farm_seasonal_week(v_week);
      RETURN v_result;
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure THEN
        IF v_attempt >= v_max THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.4 * v_attempt);  -- brief backoff, then retry
    END;
  END LOOP;
END;
$function$;
