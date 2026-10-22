-- ════════════════════════════════════════════════════════════════════════════
--  Zen garden: water ONCE a day, for 3× the coins  (2026-10-22)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after garden-water-gate.sql / polish-midnight-schedules.sql. Idempotent.
--  ⚠️ Supersedes water_plant_core() from those files — RE-RUN THIS after
--     re-running either. (The bare water_plant() is revoked from clients since
--     the anti-bot gate and is left alone.)
--
--  Was: up to 3 waterings a day, 5 h apart, each paying 15 + 3/streak-day,
--  capped at 30. Measured over 30 days: 7 players, 258 garden-days, 1.93
--  waterings per garden-day, average streak 70 (everyone at the 30 cap),
--  466 coins/day office-wide. Three clicks a day 5 h apart was a chore, not a
--  decision.
--
--  Now: ONE watering per Warsaw day paying exactly what three used to at most,
--  45 + 9/streak-day capped at 90. Nobody who watered every time earns less;
--  anyone who managed 1–2 a day earns more. Projected on the same 258
--  garden-days: ~770 coins/day (+~300/day), noise next to the farm's ~100k/day.
--  Streak and stage rules are unchanged. The 5 h cooldown check stays in place
--  and can no longer bite.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.garden_waters_per_day()
RETURNS integer LANGUAGE sql IMMUTABLE AS $c$ SELECT 1 $c$;

CREATE OR REPLACE FUNCTION public.garden_water_reward(p_streak integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $c$
  SELECT LEAST(45 + (GREATEST(p_streak, 1) - 1) * 9, 90)
$c$;

CREATE OR REPLACE FUNCTION public.water_plant_core(p_user uuid, p_slot_index integer DEFAULT 1)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_user        uuid := p_user;
  v_garden      public.gardens%ROWTYPE;
  v_today       date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_streak      integer;
  v_waters      integer;
  v_reward      integer;
  v_stage       integer;
  v_weekday_gap integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_garden
  FROM public.gardens
  WHERE user_id = v_user AND slot_index = p_slot_index
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_garden'; END IF;

  IF v_garden.last_watered_at IS NOT NULL
     AND v_garden.last_watered_at + interval '5 hours' > now() THEN
    RAISE EXCEPTION 'cooldown';
  END IF;

  IF v_garden.last_water_date = v_today THEN
    v_waters := v_garden.waters_today;
  ELSE
    v_waters := 0;
  END IF;
  IF v_waters >= public.garden_waters_per_day() THEN RAISE EXCEPTION 'daily_limit'; END IF;

  IF v_garden.last_water_date = v_today THEN
    v_streak := v_garden.streak_days;
  ELSIF v_garden.last_water_date = v_today - 1 THEN
    v_streak := v_garden.streak_days + 1;
  ELSIF v_garden.last_water_date IS NOT NULL THEN
    SELECT COUNT(*) INTO v_weekday_gap
    FROM generate_series(
      v_garden.last_water_date + 1,
      v_today - 1,
      '1 day'::interval
    ) AS d
    WHERE EXTRACT(DOW FROM d::date) NOT IN (0, 6);
    IF v_weekday_gap = 0 THEN
      v_streak := v_garden.streak_days + 1;
    ELSE
      v_streak := 1;
    END IF;
  ELSE
    v_streak := 1;
  END IF;

  v_reward := public.garden_water_reward(v_streak);
  v_stage  := LEAST(v_streak, 6);

  UPDATE public.gardens SET
    streak_days     = v_streak,
    stage           = v_stage,
    last_water_date = v_today,
    waters_today    = v_waters + 1,
    last_watered_at = now()
  WHERE id = v_garden.id;

  UPDATE public.profiles SET coins = coins + v_reward WHERE id = v_user;

  INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
  VALUES (v_user, v_reward, 'garden_water',
          jsonb_build_object('slot_index', p_slot_index, 'streak', v_streak, 'stage', v_stage,
                             'waters_today', v_waters + 1, 'via', 'gate'));

  RETURN json_build_object(
    'coins_earned', v_reward,
    'streak_days',  v_streak,
    'stage',        v_stage,
    'waters_today', v_waters + 1,
    'next_water_at', now() + interval '5 hours'
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.water_plant_core(uuid, integer) FROM PUBLIC, anon, authenticated;
