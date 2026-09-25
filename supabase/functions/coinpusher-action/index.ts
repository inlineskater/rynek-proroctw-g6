// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
//  „Automat Monet G6" — the coin pusher's bank. It never decides what falls.
// ════════════════════════════════════════════════════════════════════════════
//  The physics runs in the browser and is never steered. This function owns
//  only the money, and it keeps each player's machine a CLOSED LOOP (see the
//  header of supabase/coinpusher.sql):
//
//    state    create the machine + ONE starter pile, refill from house_bank,
//             hand this tab the lease
//    drop     debit the stake, put a coin worth the stake into the machine
//    collect  pay each claimed coin ONCE, only if it is in the caller's
//             machine (status-guarded UPDATE); gutter coins feed house_bank ×
//             RECYCLE, the rest is burned; book it on the session row
//
//  Everything that is not a stake (refills, gold, jackpot, coin rain) is paid
//  for out of house_bank at the moment it is issued, so no claim — honest or
//  forged — can take out more than went in plus the starter pile.
//
//  ⚠️ Never fund anything in this game from outside the player's own machine
//  (a shared jackpot, a minted bonus): a modified client can claim any coin
//  the instant it exists, so the per-machine loop IS the safety argument.
//
//  Lock order everywhere: coinpusher_machines row, THEN profiles row.
// ════════════════════════════════════════════════════════════════════════════
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const ALLOWED_ORIGINS = new Set([
  "https://inlineskater.github.io",
]);

function corsHeaders(req) {
  const origin = req?.headers?.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://inlineskater.github.io",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const db = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

// ── Machine policy ──────────────────────────────────────────────────────────
// One denomination: every coin thrown in is a 100 🪙 coin. (Older 1–50 🪙
// coins already in a machine keep their value until they fall out.)
const STAKES = [100];
const DEFAULT_STAKE = 100;
// The house pre-fills every machine ONCE with 140 × 100 🪙, like an operator
// filling a real cabinet. This is the game's one deliberate mint: at most
// 14 000 per player, ever (owner's decision, 2026-09-24). Granted by the
// presence of any kind='house' value=100 row, so machines that got the old
// 140 × 1 🪙 pile get this one too — once. Checked under the machine lock.
const STARTER_COINS = 140;
const STARTER_VALUE = 100;
const COIN_VALUE = 100;              // every coin the machine adds by itself is a 100 🪙 coin
const REFILL_TARGET = 120;          // top a thin pile up to this on load, 100 🪙 a coin from the bank
const REFILL_MAX = 60;
const MAX_IN_MACHINE = 320;         // a physical machine only holds so much
// Token bucket, not a fixed gap: network jitter can land two honest 250 ms
// drops 150 ms apart at the server.
const DROP_RATE_PER_S = 8;         // spamming the button is the game
const DROP_BURST = 6;
// Prizes are only accepted while the motor is running. The client parks the
// pusher MOTOR_IDLE_S after the last drop (and starts parked), so a reload can
// never shake coins loose for free; the extra grace covers coins still sliding.
const MOTOR_IDLE_S = 60;
const CLAIM_WINDOW_S = 150;
const MAX_COLLECT_BATCH = 100;
const MAX_LAYOUT_BYTES = 64_000;
const LAYOUT_MIN_INTERVAL_MS = 3000;
// A stats session closes after this much quiet (= the feed's SESSION_GAP_MS)
// and at Warsaw midnight, since the economy buckets game rows by day.
const SESSION_GAP_S = 8 * 60;

// Share of every gutter coin kept in the machine's bank (the rest is burned).
const RECYCLE = 0.40;
// Timed COMMUNAL „Amulet Bezwstydnego Fartu" (casino-luck-item.sql): more of
// the gutter comes back. Funded by losses, so it mints nothing. Never >= 1.
const CASINO_LUCK_RECYCLE = 0.70;
// The bank is float, not a vault: past this the overflow is burned. Keeps the
// gap between "booked as burned" and "actually gone" small.
const BANK_CAP = 20_000;          // half of it = the 10 000 jackpot ceiling

// Specials — rolled per drop in TEN-THOUSANDTHS, and only issued when the
// bank can pay for the part above the stake.
const GOLD_P = 300;                 // 3%    🟡 the 1 000 🪙 coin (10 × the 100 stake)
const GOLD_MULT = 10;
const JACKPOT_P = 50;               // 0.5%  💎 jackpot token
const JACKPOT_MIN_MULT = 10;        //        only if half the bank ≥ 10 × stake
const JACKPOT_MAX_MULT = 100;       // 100 × 100 🪙 = 10 000 max
const MAX_PAYOUT = 150_000;
// 🌧️ Coin rain: once the bank has grown, a drop can shake loose a shower of
// stake-valued coins bought from it.
const RAIN_P = 300;                 // 3% per drop, once eligible
const RAIN_MIN = 12;
const RAIN_MAX = 24;
const RAIN_BANK_SHARE = 0.5;

// ── Pin-board pockets and the jackpot tower (see games/coinpusher-core.js) ──
// The host only REPORTS that a coin passed a pocket / that the tower tipped;
// what that is worth is decided here and paid out of the machine's bank, so a
// forged report can at most spend the bank faster — never mint. A pocket needs
// a coin the player actually paid for (funded > 0), dropped moments ago, and
// counts once per coin (pocketed_at).
const POCKET_MAX_AGE_S = 20;
const POCKET_RAIN_COINS = 8;        // 🌧️ pocket: up to 8 × 100, bank permitting (min 4)
const POCKET_GOLD_VALUE = 1000;     // 🟡 pocket: one 1 000 coin, if the bank covers it
const TOWER_SHOWER_COINS = 18;      // 🗼 tower tip: up to 18 × 100 (min 6)
const TOWER_MIN_GAP_S = 20;         // the bucket can't physically refill faster

function gameError(message, code) {
  return Object.assign(new Error(message), { isGame: true, code });
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw gameError("Musisz być zalogowany.");
  const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła.");
  return data.user;
}

// Unbiased crypto RNG (rejection sampling).
function randomBelow(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

function validateStake(raw) {
  const stake = Math.trunc(Number(raw ?? DEFAULT_STAKE));
  if (!STAKES.includes(stake)) throw gameError("Nieprawidłowa stawka.");
  return stake;
}

function validateRequestId(raw) {
  const id = String(raw ?? "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw gameError("Nieprawidłowe żądanie.");
  return id;
}

async function casinoLuck(tx) {
  try {
    const rows = await tx`
      select 1
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where d.is_active = true
        and d.effect_game = 'casino'
        and d.effect_type = 'casino_luck'
        and i.expires_at is not null
        and i.expires_at > now()
      limit 1
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn("Casino luck lookup unavailable:", err?.message ?? err);
    return false;
  }
}

function coinOut(r) {
  return { id: String(r.id), kind: r.kind, value: Number(r.value) };
}

async function lockMachine(tx, userId) {
  const rows = await tx`select * from public.coinpusher_machines where user_id = ${userId} for update`;
  return rows[0] ?? null;
}

// Every write needs the lease this tab was handed by `state`: two tabs would
// run two diverging simulations of the same coins.
async function lockLeasedMachine(tx, userId, lease) {
  const machine = await lockMachine(tx, userId);
  if (!machine) throw gameError("Odśwież automat.", "lease");
  if (!lease || machine.lease !== String(lease)) {
    throw gameError("Automat jest otwarty w innej karcie.", "lease");
  }
  return machine;
}

async function coinsOf(tx, userId, forUpdate = false) {
  const rows = forUpdate
    ? await tx`select coins from public.profiles where id = ${userId} for update`
    : await tx`select coins from public.profiles where id = ${userId}`;
  if (!rows[0]) throw gameError("Nie znaleziono profilu.");
  return Number(rows[0].coins);
}

async function inMachineCount(tx, userId) {
  const rows = await tx`
    select count(*)::int as n from public.coinpusher_coins
     where user_id = ${userId} and status = 'in_machine'
  `;
  return Number(rows[0].n);
}

// House/refill/rain coins are funded 0: they were bought from the bank, not
// staked, so they never count as money the player put in.
async function insertCoins(tx, userId, kind, value, n) {
  if (n <= 0) return [];
  return await tx`
    insert into public.coinpusher_coins (user_id, kind, value, funded)
    select ${userId}::uuid, ${kind}::text, ${value}::bigint, 0 from generate_series(1, ${n}::int)
    returning id, kind, value
  `;
}

// ── state ───────────────────────────────────────────────────────────────────
async function handleState(user) {
  return await db.begin(async tx => {
    await tx`
      insert into public.coinpusher_machines (user_id) values (${user.id})
      on conflict (user_id) do nothing
    `;
    const machine = await lockMachine(tx, user.id);
    let bank = Number(machine.house_bank);

    // The ONE starter pile a machine ever gets (guarded by the row lock, so
    // two tabs opening the machine for the first time can't both grant it).
    const hadStarter = await tx`
      select 1 from public.coinpusher_coins
       where user_id = ${user.id} and kind = 'house' and value = ${STARTER_VALUE} limit 1
    `;
    if (!hadStarter.length && STARTER_COINS > 0) {
      await insertCoins(tx, user.id, "house", STARTER_VALUE, STARTER_COINS);
    }

    // Refill a thin pile from the bank — 100 🪙 coins, each one paid for.
    const count = await inMachineCount(tx, user.id);
    const refill = Math.max(0, Math.min(REFILL_TARGET - count, REFILL_MAX, Math.floor(bank / COIN_VALUE)));
    if (refill > 0) {
      await insertCoins(tx, user.id, "rain", COIN_VALUE, refill);
      bank -= refill * COIN_VALUE;
    }

    const lease = crypto.randomUUID();
    await tx`
      update public.coinpusher_machines
         set starter_granted = true, house_bank = ${bank}, lease = ${lease}, updated_at = now()
       where user_id = ${user.id}
    `;

    const coins = await tx`
      select id, kind, value from public.coinpusher_coins
       where user_id = ${user.id} and status = 'in_machine'
       order by id
    `;
    const luck = await casinoLuck(tx);
    return {
      ok: true,
      lease,
      coins: coins.map(coinOut),
      layout: machine.layout ?? null,
      balance: await coinsOf(tx, user.id),
      bank,
      bankCap: BANK_CAP,
      stakes: STAKES,
      defaultStake: DEFAULT_STAKE,
      maxInMachine: MAX_IN_MACHINE,
      dropRate: DROP_RATE_PER_S,
      motorIdleS: MOTOR_IDLE_S,
      recycle: luck ? CASINO_LUCK_RECYCLE : RECYCLE,
      casinoLuck: luck,
      goldMult: GOLD_MULT,
    };
  });
}

// ── drop ────────────────────────────────────────────────────────────────────
async function handleDrop(user, payload) {
  const stake = validateStake(payload?.stake);
  const requestId = validateRequestId(payload?.requestId);
  return await db.begin(async tx => {
    const machine = await lockLeasedMachine(tx, user.id, payload?.lease);

    // A retried request gets the coin it already paid for — never a second
    // debit. Checked BEFORE the rate limit, or a retry of a drop that did go
    // through would be refused and its coin never spawned.
    const dup = await tx`
      select id, kind, value from public.coinpusher_coins
       where user_id = ${user.id} and request_id = ${requestId}
    `;
    if (dup[0]) {
      return { ok: true, duplicate: true, coin: coinOut(dup[0]), rain: [],
               balance: await coinsOf(tx, user.id), bank: Number(machine.house_bank) };
    }

    const now = Date.now();
    const last = machine.last_drop_at ? new Date(machine.last_drop_at).getTime() : 0;
    const tokens = Math.min(DROP_BURST, Number(machine.drop_tokens) + (now - last) / 1000 * DROP_RATE_PER_S);
    if (tokens < 1) throw gameError("Spokojnie — jedna moneta naraz.");
    if (await inMachineCount(tx, user.id) >= MAX_IN_MACHINE) {
      throw gameError("Automat jest pełny — poczekaj, aż coś spadnie.");
    }

    const balance = await coinsOf(tx, user.id, true);
    if (balance < stake) throw gameError("Za mało monet.");
    await tx`update public.profiles set coins = coins - ${stake} where id = ${user.id}`;

    let bank = Number(machine.house_bank);
    let kind = "standard";
    let value = stake;
    const roll = randomBelow(10000);
    if (roll < GOLD_P) {
      const extra = (GOLD_MULT - 1) * stake;
      if (bank >= extra) { kind = "gold"; value = GOLD_MULT * stake; bank -= extra; }
    } else if (roll < GOLD_P + JACKPOT_P) {
      const jackpot = Math.min(Math.floor(bank / 2), JACKPOT_MAX_MULT * stake, MAX_PAYOUT);
      if (jackpot >= JACKPOT_MIN_MULT * stake) { kind = "jackpot"; value = jackpot; bank -= jackpot - stake; }
    }

    // `funded` = the stake: an upgrade's premium came from the bank, so only
    // the stake is money the player put in.
    const inserted = await tx`
      insert into public.coinpusher_coins (user_id, kind, value, funded, request_id)
      values (${user.id}, ${kind}, ${value}, ${stake}, ${requestId})
      returning id, kind, value
    `;

    let rain = [];
    const rainN = Math.min(RAIN_MAX, Math.floor(bank * RAIN_BANK_SHARE / stake));
    if (rainN >= RAIN_MIN && randomBelow(10000) < RAIN_P) {
      rain = await insertCoins(tx, user.id, "rain", stake, rainN);
      bank -= rainN * stake;
    }

    await tx`
      update public.coinpusher_machines
         set house_bank = ${bank}, last_drop_at = now(), drop_tokens = ${tokens - 1},
             drops = drops + 1, updated_at = now()
       where user_id = ${user.id}
    `;
    return { ok: true, coin: coinOut(inserted[0]), rain: rain.map(coinOut),
             balance: balance - stake, bank };
  });
}

// ── collect ─────────────────────────────────────────────────────────────────
function parseEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw gameError("Brak monet do rozliczenia.");
  if (raw.length > MAX_COLLECT_BATCH) throw gameError("Za dużo monet naraz.");
  const out = { prize: [], gutter: [] };
  const seen = new Set();
  for (const e of raw) {
    const id = String(e?.id ?? "");
    if (!/^\d{1,18}$/.test(id) || seen.has(id)) continue;
    // 'lost' (left the world) is booked exactly like a gutter: it must never
    // be a free choice of a better return rate.
    const where = e?.where === "prize" ? "prize" : (e?.where === "gutter" || e?.where === "lost") ? "gutter" : null;
    if (!where) continue;
    seen.add(id);
    out[where].push(id);
  }
  return out;
}

async function settleIds(tx, userId, ids, status) {
  if (!ids.length) return [];
  return await tx`
    update public.coinpusher_coins
       set status = ${status}, resolved_at = now()
     where user_id = ${userId}
       and id = any(${ids}::bigint[])
       and status = 'in_machine'
    returning id, kind, value, funded
  `;
}

// One stats row per play session, written at SETTLEMENT: bet = what the
// resolved coins cost the player, total_won = what went over the front. So a
// coin still sitting in the machine is not yet booked as burned — and the
// farm budget (0.9 × casino burn, anti-inflation.sql) never sees a loss that
// hasn't happened.
async function bookSession(tx, machine, userId, bet, won, counts, luck) {
  const effect = luck ? "casino_luck" : null;
  const open = machine.session_id ? await tx`
    select id from public.coinpusher_spins
     where id = ${machine.session_id}
       and updated_at > now() - make_interval(secs => ${SESSION_GAP_S}::double precision)
       and (updated_at at time zone 'Europe/Warsaw')::date = (now() at time zone 'Europe/Warsaw')::date
       and item_effect is not distinct from ${effect}::text
  ` : [];
  if (open[0]) {
    await tx`
      update public.coinpusher_spins
         set bet = bet + ${bet}, total_won = total_won + ${won},
             prize_coins = prize_coins + ${counts.prize}, gutter_coins = gutter_coins + ${counts.gutter},
             gold_coins = gold_coins + ${counts.gold}, jackpot_coins = jackpot_coins + ${counts.jackpot},
             updated_at = now()
       where id = ${open[0].id}
    `;
    return;
  }
  const rows = await tx`
    insert into public.coinpusher_spins
      (user_id, bet, total_won, prize_coins, gutter_coins, gold_coins, jackpot_coins, item_effect)
    values (${userId}, ${bet}, ${won}, ${counts.prize}, ${counts.gutter},
            ${counts.gold}, ${counts.jackpot}, ${effect})
    returning id
  `;
  await tx`update public.coinpusher_machines set session_id = ${rows[0].id} where user_id = ${userId}`;
}

async function handleCollect(user, payload) {
  const ev = parseEvents(payload?.events);
  return await db.begin(async tx => {
    const machine = await lockLeasedMachine(tx, user.id, payload?.lease);

    // Prizes only while the motor could be running (see MOTOR_IDLE_S). A
    // refused prize simply stays in the machine and is back on the next load.
    const lastDrop = machine.last_drop_at ? new Date(machine.last_drop_at).getTime() : 0;
    const claimable = Date.now() - lastDrop < CLAIM_WINDOW_S * 1000;

    const prize = claimable ? await settleIds(tx, user.id, ev.prize, "prize") : [];
    const gutter = await settleIds(tx, user.id, ev.gutter, "gutter");

    const paid = prize.reduce((s, r) => s + Number(r.value), 0);
    const bet = [...prize, ...gutter].reduce((s, r) => s + Number(r.funded), 0);
    const gutterValue = gutter.reduce((s, r) => s + Number(r.value), 0);
    const luck = await casinoLuck(tx);
    // Floor, never round up: the bank may only ever hold less than was lost.
    const recycled = Math.floor(gutterValue * (luck ? CASINO_LUCK_RECYCLE : RECYCLE));
    const bank = Math.min(BANK_CAP, Number(machine.house_bank) + recycled);
    if (bank !== Number(machine.house_bank)) {
      await tx`
        update public.coinpusher_machines set house_bank = ${bank}, updated_at = now()
         where user_id = ${user.id}
      `;
    }

    let balance;
    if (paid > 0) {
      const rows = await tx`
        update public.profiles set coins = coins + ${paid} where id = ${user.id} returning coins
      `;
      balance = Number(rows[0].coins);
    } else {
      balance = await coinsOf(tx, user.id);
    }
    if (prize.length || gutter.length) {
      const count = k => prize.filter(r => r.kind === k).length;
      await bookSession(tx, machine, user.id, bet, paid,
        { prize: prize.length, gutter: gutter.length, gold: count("gold"), jackpot: count("jackpot") }, luck);
    }

    // The status of EVERY id asked about, including ones settled by an earlier
    // (retried) request, so the client can reconcile instead of guessing.
    const asked = [...ev.prize, ...ev.gutter];
    const rows = asked.length ? await tx`
      select id, status, value from public.coinpusher_coins
       where user_id = ${user.id} and id = any(${asked}::bigint[])
    ` : [];
    return {
      ok: true,
      paid,
      paidIds: prize.map(r => String(r.id)),
      statuses: Object.fromEntries(rows.map(r => [String(r.id), r.status])),
      claimable,
      recycled,
      balance,
      bank,
    };
  });
}

// ── save_layout ─────────────────────────────────────────────────────────────
// Purely cosmetic (the pile's shape between visits). Size-capped and
// throttled; never read by anything that moves coins.
// ── pocket ──────────────────────────────────────────────────────────────────
async function handlePocket(user, payload) {
  const kind = String(payload?.pocket ?? "");
  if (!["rain", "gold", "tower"].includes(kind)) throw gameError("Nieznana kieszeń.");
  return await db.begin(async tx => {
    const machine = await lockLeasedMachine(tx, user.id, payload?.lease);
    let bank = Number(machine.house_bank);
    const lastDrop = machine.last_drop_at ? new Date(machine.last_drop_at).getTime() : 0;
    if (Date.now() - lastDrop > CLAIM_WINDOW_S * 1000) return { ok: true, coins: [], bank, reason: "idle" };

    let coins = [];
    if (kind === "tower") {
      const last = machine.last_tower_at ? new Date(machine.last_tower_at).getTime() : 0;
      if (Date.now() - last < TOWER_MIN_GAP_S * 1000) return { ok: true, coins: [], bank, reason: "cooldown" };
      const n = Math.min(TOWER_SHOWER_COINS, Math.floor(bank / 100));
      if (n >= 6) { coins = await insertCoins(tx, user.id, "rain", 100, n); bank -= n * 100; }
      await tx`update public.coinpusher_machines set last_tower_at = now() where user_id = ${user.id}`;
    } else {
      const id = String(payload?.coinId ?? "");
      if (!/^\d{1,18}$/.test(id)) throw gameError("Nieprawidłowa moneta.");
      const hit = await tx`
        update public.coinpusher_coins set pocketed_at = now()
         where id = ${id}::bigint and user_id = ${user.id} and status = 'in_machine'
           and funded > 0 and pocketed_at is null
           and created_at > now() - make_interval(secs => ${POCKET_MAX_AGE_S}::double precision)
        returning id
      `;
      if (!hit.length) return { ok: true, coins: [], bank, reason: "not_eligible" };
      if (kind === "rain") {
        const n = Math.min(POCKET_RAIN_COINS, Math.floor(bank / 100));
        if (n >= 4) { coins = await insertCoins(tx, user.id, "rain", 100, n); bank -= n * 100; }
      } else if (bank >= POCKET_GOLD_VALUE) {
        coins = await insertCoins(tx, user.id, "gold", POCKET_GOLD_VALUE, 1);
        bank -= POCKET_GOLD_VALUE;
      }
    }
    if (coins.length) {
      await tx`update public.coinpusher_machines set house_bank = ${bank}, updated_at = now() where user_id = ${user.id}`;
    }
    return { ok: true, pocket: kind, coins: coins.map(coinOut), bank };
  });
}

async function handleSaveLayout(user, payload) {
  const layout = payload?.layout;
  if (!layout || layout.v !== 1 || !Array.isArray(layout.coins)) throw gameError("Zły układ.");
  const text = JSON.stringify(layout);
  if (text.length > MAX_LAYOUT_BYTES) throw gameError("Układ za duży.");
  const rows = await db`
    update public.coinpusher_machines
       set layout = ${text}::jsonb, layout_saved_at = now()
     where user_id = ${user.id}
       and lease = ${String(payload?.lease ?? "")}
       and (layout_saved_at is null
            or layout_saved_at < now() - make_interval(secs => ${LAYOUT_MIN_INTERVAL_MS / 1000}::double precision))
    returning user_id
  `;
  return { ok: true, saved: rows.length > 0 };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  try {
    const user = await requireUser(req);
    const payload = await req.json().catch(() => ({}));
    switch (payload?.action) {
      case "state":       return json(req, await handleState(user));
      case "drop":        return json(req, await handleDrop(user, payload));
      case "collect":     return json(req, await handleCollect(user, payload));
      case "save_layout": return json(req, await handleSaveLayout(user, payload));
      case "pocket":      return json(req, await handlePocket(user, payload));
      default:            return json(req, { ok: false, error: "Nieznana akcja." }, 400);
    }
  } catch (err) {
    const message = err?.isGame ? err.message : "Coś poszło nie tak.";
    if (!err?.isGame) console.error("coinpusher-action", err);
    return json(req, { ok: false, error: message, code: err?.code ?? null }, err?.isGame ? 400 : 500);
  }
});
