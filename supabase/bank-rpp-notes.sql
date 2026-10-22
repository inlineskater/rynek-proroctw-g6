-- ════════════════════════════════════════════════════════════════════════════
--  Bank G6: 🏛️ Rada Polityki Pieniężnej G6 — daily chat communiqué  (2026-10-23)
-- ════════════════════════════════════════════════════════════════════════════
--  Run after bank.sql, anti-inflation.sql, bank-loans.sql and chat.sql.
--  Idempotent; supersedes nothing.
--
--  Every limit in the Bank is already recomputed once a Warsaw day from measured
--  data (bank_ensure_limits → bank_limits) and the farm's NPC buyer rolls its
--  demand twice a day (farm_market_pressure). Nobody saw those decisions unless
--  they opened the „Limity i budżet" tab. Now the „RPP G6" announces them in the
--  office chat at 09:00 Warsaw: inflation, economy health, today's caps against
--  yesterday's, the NPC buyer's rate and who can take a Kredyt.
--
--  One note per Warsaw date (bank_rpp_notes PK); cron hourly at minute 12,
--  gated on Warsaw hour 9 so it is right across DST. Posted as the admin
--  profile with sender_nick „🏛️ RPP G6". Pure read + one chat row: no coins.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bank_rpp_notes (
  note_date date PRIMARY KEY,
  body      text NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bank_rpp_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bank_rpp_notes_select" ON public.bank_rpp_notes;
CREATE POLICY "bank_rpp_notes_select" ON public.bank_rpp_notes FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.bank_rpp_notes FROM anon, authenticated;
GRANT SELECT ON public.bank_rpp_notes TO authenticated;

-- „12 345" — thin-space-free, plain space thousands like the rest of the UI.
CREATE OR REPLACE FUNCTION public.rpp_n(n numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $c$
  SELECT replace(to_char(round(COALESCE(n, 0)), 'FM999,999,999,990'), ',', ' ')
$c$;

-- „↑ z 11 000" / „bez zmian" against yesterday's value.
CREATE OR REPLACE FUNCTION public.rpp_delta(p_now numeric, p_prev numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $c$
  SELECT CASE WHEN p_prev IS NULL OR p_now = p_prev THEN 'bez zmian'
              WHEN p_now > p_prev THEN '↑ z ' || public.rpp_n(p_prev)
              ELSE '↓ z ' || public.rpp_n(p_prev) END
$c$;

CREATE OR REPLACE FUNCTION public.bank_rpp_note_post(p_force boolean DEFAULT false)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_today  date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  t        public.bank_limits%ROWTYPE;
  y        public.bank_limits%ROWTYPE;
  m        public.farm_market_pressure%ROWTYPE;
  v_median numeric;
  v_mood   text;
  v_body   text;
  v_admin  uuid;
BEGIN
  IF NOT p_force AND EXTRACT(HOUR FROM now() AT TIME ZONE 'Europe/Warsaw')::int <> 9 THEN
    RETURN json_build_object('ok', true, 'skipped', 'not_9_warsaw');
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_rpp_notes WHERE note_date = v_today) THEN
    RETURN json_build_object('ok', true, 'skipped', 'already_posted');
  END IF;

  PERFORM public.bank_ensure_limits();
  SELECT * INTO t FROM public.bank_limits WHERE effective_date = v_today;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'no_limits_today'); END IF;
  SELECT * INTO y FROM public.bank_limits WHERE effective_date < v_today ORDER BY effective_date DESC LIMIT 1;
  SELECT * INTO m FROM public.farm_market_pressure ORDER BY rolled_at DESC LIMIT 1;
  IF to_regprocedure('public.farm_net_worth(uuid)') IS NOT NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY public.farm_net_worth(p.id)) INTO v_median
      FROM public.profiles p
     WHERE NOT COALESCE(p.is_admin, false) AND p.last_active_at > now() - interval '14 days';
  END IF;

  v_mood := CASE WHEN t.health_bps >= 7000 THEN 'gospodarka zdrowa — Bank rozluźnia politykę'
                 WHEN t.health_bps >= 4000 THEN 'gospodarka rozgrzana — Rada zachowuje ostrożność'
                 ELSE 'inflacja wysoka — Rada zacieśnia politykę' END;

  v_body := '🏛️ Komunikat RPP G6 z ' || to_char(v_today, 'DD.MM') || ' — ' || v_mood || '.'
    || E'\n• 📈 Inflacja: ' || CASE WHEN t.net_mint_day >= 0 THEN '+' ELSE '−' END
       || public.rpp_n(abs(t.net_mint_day)) || ' 🪙/dzień ('
       || replace(to_char(t.inflation_bps / 100.0, 'FM990.00'), '.', ',') || '% podaży), kondycja '
       || round(t.health_bps / 100.0) || '%'
       || CASE WHEN y.effective_date IS NOT NULL THEN ' (wczoraj ' || round(y.health_bps / 100.0) || '%)' ELSE '' END || '.'
    || E'\n• 🏦 Limit lokaty ' || public.rpp_n(t.lokata_cap) || ' 🪙 (' || public.rpp_delta(t.lokata_cap, y.lokata_cap) || '), '
       || 'skarbonki ' || public.rpp_n(t.piggy_cap) || ' 🪙 (' || public.rpp_delta(t.piggy_cap, y.piggy_cap) || '), '
       || 'emisja obligacji ' || t.bond_edition || ' szt. (' || public.rpp_delta(t.bond_edition, y.bond_edition) || ').'
    || CASE WHEN m.rolled_at IS NOT NULL THEN
         E'\n• 🌾 Skup NPC płaci ' || round(m.demand_bps / 100.0) || '% stawki, budżet ' || public.rpp_n(m.budget_per_day) || ' 🪙/dzień.'
       ELSE '' END
    || CASE WHEN v_median IS NOT NULL THEN
         E'\n• 🤝 Kredyt dla rolnika: dla majątku poniżej ' || public.rpp_n(v_median) || ' 🪙.'
       ELSE '' END;

  INSERT INTO public.bank_rpp_notes (note_date, body) VALUES (v_today, v_body);
  SELECT id INTO v_admin FROM public.profiles WHERE is_admin ORDER BY created_at LIMIT 1;
  IF v_admin IS NOT NULL THEN
    INSERT INTO public.chat_messages (sender_id, recipient_id, sender_nick, body)
    VALUES (v_admin, NULL, '🏛️ RPP G6', left(v_body, 1000));
  END IF;
  RETURN json_build_object('ok', true, 'body', v_body);
END;
$fn$;

REVOKE ALL ON FUNCTION public.bank_rpp_note_post(boolean) FROM PUBLIC, anon, authenticated;

-- A dry run for whoever tunes the wording: the text without posting anything.
CREATE OR REPLACE FUNCTION public.bank_rpp_note_preview()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_out json;
BEGIN
  BEGIN
    v_out := public.bank_rpp_note_post(true);
    RAISE EXCEPTION 'rollback' USING DETAIL = v_out::text;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'rollback' THEN
      GET STACKED DIAGNOSTICS v_out = PG_EXCEPTION_DETAIL;
      RETURN v_out->>'body';
    END IF;
    RAISE;
  END;
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_rpp_note_preview() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('bank_rpp_note', '12 * * * *', $cron$SELECT public.bank_rpp_note_post();$cron$);
  END IF;
END $$;
