-- ════════════════════════════════════════════════════════════════════════════
--  🥷 Robin Hood theft  (2026-10-23)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after farm-neighbours.sql. Idempotent.
--  ⚠️ Supersedes farm_steal_crop() from farm-neighbours.sql — re-run this after
--     re-running that.
--
--  Theft ran from the rich to the poor: over 14 days the top two players took
--  most of it, mostly from Filip, Maciek and Ilo — the players who check in
--  less often and can least afford it. Now you may only steal from a player
--  whose NET WORTH (cash + user_assets_value(), the leaderboard's own
--  definition) is higher than yours. The richest player can steal from nobody;
--  the poorest from everyone. Every other rule (12 h grace, scarecrow, 5/day,
--  3 thieves per cycle, 10%) is unchanged.
--
--  farm_robin_hood_targets() gives the client the set of owners the caller may
--  rob, so the 🥷 badge only appears where a theft would succeed.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.farm_net_worth(p_uid uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $nw$
  SELECT COALESCE((SELECT coins FROM public.profiles WHERE id = p_uid), 0)
       + COALESCE(public.user_assets_value(p_uid), 0)
$nw$;
REVOKE ALL ON FUNCTION public.farm_net_worth(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.farm_robin_hood_targets()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $rh$
  WITH me AS (SELECT public.farm_net_worth(auth.uid()) AS nw)
  SELECT COALESCE(array_agg(o.owner_id), '{}')
    FROM (SELECT DISTINCT owner_id FROM public.farm_tiles
           WHERE owner_id IS NOT NULL AND owner_id <> auth.uid()) o, me
   WHERE public.farm_net_worth(o.owner_id) > me.nw
$rh$;
REVOKE ALL ON FUNCTION public.farm_robin_hood_targets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_robin_hood_targets() TO authenticated;

CREATE OR REPLACE FUNCTION public.farm_steal_crop(p_x integer, p_y integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_user   uuid := auth.uid();
  v_tile   public.farm_tiles%ROWTYPE;
  v_def    public.farm_card_defs%ROWTYPE;
  v_today  timestamptz := date_trunc('day', now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw';
  v_used   integer;
  v_thieves integer;
  v_calc   json;
  v_qty    integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('farm_neighbour:' || v_user::text));

  SELECT * INTO v_tile FROM public.farm_tiles WHERE x = p_x AND y = p_y FOR UPDATE;
  IF NOT FOUND OR v_tile.planted_species IS NULL THEN RAISE EXCEPTION 'tile_empty'; END IF;
  IF v_tile.owner_id = v_user THEN RAISE EXCEPTION 'own_tile'; END IF;
  IF v_tile.ready_at IS NULL
     OR now() < GREATEST(v_tile.ready_at, public.farm_steal_launch_at())
                + make_interval(hours => public.farm_steal_grace_hours()) THEN
    RAISE EXCEPTION 'not_stealable_yet';
  END IF;
  IF public.farm_is_protected(v_tile.owner_id) THEN RAISE EXCEPTION 'protected'; END IF;
  -- farm-robin-hood.sql: only from someone richer than you.
  IF public.farm_net_worth(v_user) >= public.farm_net_worth(v_tile.owner_id) THEN
    RAISE EXCEPTION 'robin_hood';
  END IF;

  SELECT count(*) INTO v_used FROM public.farm_tile_events
   WHERE user_id = v_user AND kind = 'steal' AND created_at >= v_today;
  IF v_used >= public.farm_steal_per_day() THEN RAISE EXCEPTION 'steal_limit_day'; END IF;
  IF EXISTS (SELECT 1 FROM public.farm_tile_events
              WHERE x = p_x AND y = p_y AND planted_at = v_tile.planted_at
                AND kind = 'steal' AND user_id = v_user) THEN
    RAISE EXCEPTION 'already_stolen';
  END IF;
  SELECT count(*) INTO v_thieves FROM public.farm_tile_events
   WHERE x = p_x AND y = p_y AND planted_at = v_tile.planted_at AND kind = 'steal';
  IF v_thieves >= public.farm_steal_thieves_per_cycle() THEN RAISE EXCEPTION 'steal_limit_tile'; END IF;

  SELECT * INTO v_def FROM public.farm_card_defs WHERE species = v_tile.planted_species;
  v_calc := public.farm_harvest_yield(v_tile, v_tile.owner_id, public.farm_tile_core_yield(v_tile), v_def.crop_type);
  v_qty  := floor((v_calc->>'gross')::numeric * public.farm_steal_share())::integer;
  -- Never take more than is left on the plant.
  v_qty  := LEAST(v_qty, (v_calc->>'yield')::integer);
  IF v_qty < 1 THEN RAISE EXCEPTION 'nothing_to_steal'; END IF;

  INSERT INTO public.farm_tile_events (x, y, planted_at, kind, user_id, owner_id, species, crop_type, qty)
  VALUES (p_x, p_y, v_tile.planted_at, 'steal', v_user, v_tile.owner_id, v_tile.planted_species, v_def.crop_type, v_qty);

  INSERT INTO public.farm_inventory (user_id, crop_type, qty, harvested_at, expires_at)
  VALUES (v_user, v_def.crop_type, v_qty, now(), now() + interval '5 days');

  INSERT INTO public.farm_user_state (user_id, steals_done) VALUES (v_user, 1)
  ON CONFLICT (user_id) DO UPDATE SET steals_done = public.farm_user_state.steals_done + 1;

  RETURN json_build_object('ok', true, 'qty', v_qty, 'crop_type', v_def.crop_type,
                           'left_today', public.farm_steal_per_day() - v_used - 1);
END;
$fn$;
