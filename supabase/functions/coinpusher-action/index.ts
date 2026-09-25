// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
//  „Automat Monet G6" — the SHARED coin pusher's bank. It never decides what falls.
// ════════════════════════════════════════════════════════════════════════════
//  One machine for everybody (supabase/coinpusher-shared.sql). One connected
//  player's browser — the HOST, holder of `host_lease` — runs the physics and
//  streams it to everyone over Realtime; this function owns only the money:
//
//    state      the machine: coins (with owners), bank, host, the one pre-fill
//    host_beat  every client, every 3 s: renew / take over / resign the host
//               lease; also how the host learns whether anyone is watching
//    drop       any player: debit the stake, put a coin THEY own into the
//               machine, broadcast `spawn` so the host drops it
//    collect    host only: pay each prize coin to its OWNER (never the
//               reporter); ownerless coins to the most recent thrower (capped);
//               gutters feed the bank; book sessions; broadcast `paid`
//    pocket     host only: a paid-for coin passed a pin-board pocket, or the
//               tower tipped — a bonus bought from the bank
//    save_layout host only: the pile's shape, for the next host
//
//  Everything that is not a stake is paid out of the bank at issue, and the
//  bank is only ever filled by gutter losses, so the machine as a whole can pay
//  out at most what was thrown in plus its ONE pre-fill.
//
//  Lock order everywhere: coinpusher_shared row → coinpusher_players rows →
//  profiles rows (the latter two in user-id order).
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
const MACHINE = "main";
const TOPIC = "coinpusher_main";
const STAKES = [100];               // one denomination: every coin thrown is 100 🪙
const DEFAULT_STAKE = 100;
// The shared machine's one-time pre-fill: ownerless 100 🪙 coins, minus any
// private-machine coins that migrated in. The game's only deliberate mint —
// one machine instead of 140 × 100 per player.
const SHARED_PREFILL = 220;
const COIN_VALUE = 100;
const REFILL_TARGET = 160;          // top a thin pile up to this on load, 100 🪙 a coin from the bank
const REFILL_MAX = 60;
const MAX_IN_MACHINE = 520;
// Per-player token bucket: spamming the button is the game.
const DROP_RATE_PER_S = 8;
const DROP_BURST = 6;
// Prizes only while the motor could be running (the host parks it
// MOTOR_IDLE_S after the last throw by ANYONE, and starts parked).
const MOTOR_IDLE_S = 60;
const CLAIM_WINDOW_S = 150;
const MIN_COIN_AGE_MS = 1500;       // no coin physically leaves faster than this
const MAX_COLLECT_BATCH = 100;
const MAX_LAYOUT_BYTES = 160_000;
const LAYOUT_MIN_INTERVAL_MS = 3000;
const SESSION_GAP_S = 8 * 60;
// Host lease: renewed every 3 s by the host; a client may take over once it is
// this stale. Clients that should not host (phones) wait longer, so a desktop
// in the room wins the race.
const HOST_TTL_S = 8;
const HOST_TTL_WEAK_S = 16;
const VIEWER_SEEN_S = 10;
// Ownerless coins (house pre-fill, refills, tower shower with no recent thrower)
// go to the most recent thrower within this window, capped per player/minute;
// otherwise they are booked like a gutter coin (recycled into the bank).
const OWNERLESS_WINDOW_S = 30;
const OWNERLESS_CAP_PER_MIN = 3000;

const RECYCLE = 0.40;
const CASINO_LUCK_RECYCLE = 0.70;
const BANK_CAP = 20_000;            // half of it = the 10 000 jackpot ceiling

// Specials — rolled per drop in TEN-THOUSANDTHS, only if the bank can pay.
const GOLD_P = 300;                 // 3%    🟡 the 1 000 🪙 coin
const GOLD_MULT = 10;
const JACKPOT_P = 50;               // 0.5%  💎 jackpot token
const JACKPOT_MIN_MULT = 10;
const JACKPOT_MAX_MULT = 100;       // 100 × 100 🪙 = 10 000 max
const MAX_PAYOUT = 150_000;
const RAIN_P = 300;                 // 3% per drop, once eligible
const RAIN_MIN = 12;
const RAIN_MAX = 24;
const RAIN_BANK_SHARE = 0.5;
// Pin-board pockets and the jackpot tower.
const POCKET_MAX_AGE_S = 20;
const POCKET_RAIN_COINS = 8;
const POCKET_GOLD_VALUE = 1000;
const TOWER_SHOWER_COINS = 18;
const TOWER_MIN_GAP_S = 20;

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
  return { id: String(r.id), kind: r.kind, value: Number(r.value), owner: r.user_id ?? null };
}

// Realtime broadcast from the server (same REST call crash-action uses). Best
// effort: a lost message only delays the host's spawn by the next `state`.
function broadcast(messages) {
  if (!messages.length) return;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const job = fetch(`${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ messages: messages.map(m => ({ topic: TOPIC, event: m.event, payload: m.payload })) }),
  }).catch(err => console.error("coinpusher broadcast failed", err));
  try { EdgeRuntime.waitUntil(job); } catch { /* local runtime */ }
}

async function lockShared(tx) {
  const rows = await tx`select * from public.coinpusher_shared where id = ${MACHINE} for update`;
  if (!rows[0]) throw gameError("Automat nie jest skonfigurowany.");
  return rows[0];
}

function isHost(m, userId, lease) {
  return m.host_user === userId && !!lease && m.host_lease === String(lease);
}

function requireHost(m, userId, lease) {
  if (!isHost(m, userId, lease)) throw gameError("Nie jesteś już gospodarzem automatu.", "host");
}

async function lockPlayer(tx, userId) {
  await tx`insert into public.coinpusher_players (user_id) values (${userId}) on conflict (user_id) do nothing`;
  return (await tx`select * from public.coinpusher_players where user_id = ${userId} for update`)[0];
}

async function coinsOf(tx, userId, forUpdate = false) {
  const rows = forUpdate
    ? await tx`select coins from public.profiles where id = ${userId} for update`
    : await tx`select coins from public.profiles where id = ${userId}`;
  if (!rows[0]) throw gameError("Nie znaleziono profilu.");
  return Number(rows[0].coins);
}

async function inMachineCount(tx) {
  const rows = await tx`
    select count(*)::int as n from public.coinpusher_coins
     where machine_id = ${MACHINE} and status = 'in_machine'
  `;
  return Number(rows[0].n);
}

async function insertCoins(tx, ownerId, kind, value, n) {
  if (n <= 0) return [];
  return await tx`
    insert into public.coinpusher_coins (user_id, machine_id, kind, value, funded)
    select ${ownerId}::uuid, ${MACHINE}, ${kind}::text, ${value}::bigint, 0 from generate_series(1, ${n}::int)
    returning id, user_id, kind, value
  `;
}

async function nicksOf(tx, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = await tx`select id, nick from public.profiles where id = any(${list}::uuid[])`;
  return Object.fromEntries(rows.map(r => [r.id, r.nick]));
}

function recentThrower(m) {
  if (!m.last_thrower || !m.last_throw_at) return null;
  return Date.now() - new Date(m.last_throw_at).getTime() < OWNERLESS_WINDOW_S * 1000 ? m.last_thrower : null;
}

// ── state ───────────────────────────────────────────────────────────────────
async function handleState(user) {
  return await db.begin(async tx => {
    const m = await lockShared(tx);
    let bank = Number(m.house_bank);
    if (!m.prefilled) {
      const have = await inMachineCount(tx);
      await insertCoins(tx, null, "house", COIN_VALUE, Math.max(0, SHARED_PREFILL - have));
      await tx`update public.coinpusher_shared set prefilled = true where id = ${MACHINE}`;
    }
    const count = await inMachineCount(tx);
    const refill = Math.max(0, Math.min(REFILL_TARGET - count, REFILL_MAX, Math.floor(bank / COIN_VALUE)));
    if (refill > 0) {
      await insertCoins(tx, null, "rain", COIN_VALUE, refill);
      bank -= refill * COIN_VALUE;
      await tx`update public.coinpusher_shared set house_bank = ${bank}, updated_at = now() where id = ${MACHINE}`;
    }
    await lockPlayer(tx, user.id);
    const coins = await tx`
      select id, user_id, kind, value from public.coinpusher_coins
       where machine_id = ${MACHINE} and status = 'in_machine' order by id
    `;
    const nicks = await nicksOf(tx, [...coins.map(c => c.user_id), m.host_user, m.last_thrower]);
    const luck = await casinoLuck(tx);
    const hostAlive = m.host_seen_at && Date.now() - new Date(m.host_seen_at).getTime() < HOST_TTL_S * 1000;
    return {
      ok: true,
      shared: true,
      coins: coins.map(coinOut),
      nicks,
      layout: m.layout ?? null,
      host: hostAlive ? { user: m.host_user, nick: nicks[m.host_user] ?? null } : null,
      lastThrowAgoMs: m.last_throw_at ? Date.now() - new Date(m.last_throw_at).getTime() : null,
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
      topic: TOPIC,
    };
  });
}

// ── host_beat ───────────────────────────────────────────────────────────────
async function handleHostBeat(user, payload) {
  const lease = payload?.lease ? String(payload.lease) : null;
  const canHost = payload?.canHost !== false;
  const visible = payload?.visible !== false;
  const resign = payload?.resign === true;
  return await db.begin(async tx => {
    const m = await lockShared(tx);
    await tx`
      insert into public.coinpusher_players (user_id, seen_at) values (${user.id}, now())
      on conflict (user_id) do update set seen_at = now()
    `;
    const ageS = m.host_seen_at ? (Date.now() - new Date(m.host_seen_at).getTime()) / 1000 : Infinity;
    let host = false, newLease = null;
    if (isHost(m, user.id, lease)) {
      if (resign || !visible) {
        await tx`update public.coinpusher_shared set host_user = null, host_lease = null, host_seen_at = null where id = ${MACHINE}`;
      } else {
        await tx`update public.coinpusher_shared set host_seen_at = now() where id = ${MACHINE}`;
        host = true; newLease = lease;
      }
    } else if (!resign && visible && ageS > (canHost ? HOST_TTL_S : HOST_TTL_WEAK_S)) {
      newLease = crypto.randomUUID();
      await tx`
        update public.coinpusher_shared
           set host_user = ${user.id}, host_lease = ${newLease}, host_seen_at = now()
         where id = ${MACHINE}
      `;
      host = true;
    }
    const cur = host ? user.id : (ageS <= HOST_TTL_S || isHost(m, user.id, lease) ? m.host_user : null);
    const viewers = await tx`
      select count(*)::int as n from public.coinpusher_players
       where seen_at > now() - make_interval(secs => ${VIEWER_SEEN_S}::double precision)
         and user_id <> ${cur ?? user.id}
    `;
    const nicks = await nicksOf(tx, [cur]);
    return {
      ok: true,
      host,
      lease: newLease,
      hostUser: cur,
      hostNick: cur ? nicks[cur] ?? null : null,
      viewers: Number(viewers[0].n),
      lastThrowAgoMs: m.last_throw_at ? Date.now() - new Date(m.last_throw_at).getTime() : null,
      bank: Number(m.house_bank),
      // Every client's balance, every beat: a win lands on the thrower's
      // account whoever's browser reported it, so this is how they see it
      // even if they missed the `paid` broadcast.
      balance: await coinsOf(tx, user.id),
    };
  });
}

// ── drop ────────────────────────────────────────────────────────────────────
async function handleDrop(user, payload) {
  const stake = validateStake(payload?.stake);
  const requestId = validateRequestId(payload?.requestId);
  const x = Math.max(-100, Math.min(100, Number(payload?.x) || 0));
  return await db.begin(async tx => {
    const m = await lockShared(tx);
    const dup = await tx`
      select id, user_id, kind, value from public.coinpusher_coins
       where user_id = ${user.id} and request_id = ${requestId}
    `;
    if (dup[0]) {
      return { ok: true, duplicate: true, coin: coinOut(dup[0]), rain: [],
               balance: await coinsOf(tx, user.id), bank: Number(m.house_bank) };
    }
    const p = await lockPlayer(tx, user.id);
    const now = Date.now();
    const last = p.last_drop_at ? new Date(p.last_drop_at).getTime() : 0;
    const tokens = Math.min(DROP_BURST, Number(p.drop_tokens) + (now - last) / 1000 * DROP_RATE_PER_S);
    if (tokens < 1) throw gameError("Spokojnie — jedna moneta naraz.");
    if (await inMachineCount(tx) >= MAX_IN_MACHINE) throw gameError("Automat jest pełny — poczekaj, aż coś spadnie.");

    const balance = await coinsOf(tx, user.id, true);
    if (balance < stake) throw gameError("Za mało monet.");
    await tx`update public.profiles set coins = coins - ${stake} where id = ${user.id}`;

    let bank = Number(m.house_bank);
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
    const inserted = await tx`
      insert into public.coinpusher_coins (user_id, machine_id, kind, value, funded, request_id)
      values (${user.id}, ${MACHINE}, ${kind}, ${value}, ${stake}, ${requestId})
      returning id, user_id, kind, value
    `;
    let rain = [];
    const rainN = Math.min(RAIN_MAX, Math.floor(bank * RAIN_BANK_SHARE / stake));
    if (rainN >= RAIN_MIN && randomBelow(10000) < RAIN_P) {
      rain = await insertCoins(tx, user.id, "rain", stake, rainN);   // the thrower's luck
      bank -= rainN * stake;
    }
    await tx`
      update public.coinpusher_shared
         set house_bank = ${bank}, last_thrower = ${user.id}, last_throw_at = now(), updated_at = now()
       where id = ${MACHINE}
    `;
    await tx`
      update public.coinpusher_players
         set last_drop_at = now(), drop_tokens = ${tokens - 1}, seen_at = now()
       where user_id = ${user.id}
    `;
    const nick = (await nicksOf(tx, [user.id]))[user.id] ?? null;
    const coin = coinOut(inserted[0]);
    broadcast([{ event: "spawn", payload: { coin, x, rain: rain.map(coinOut), nick } }]);
    return { ok: true, coin, rain: rain.map(coinOut), balance: balance - stake, bank, x };
  });
}

// ── collect (host only) ─────────────────────────────────────────────────────
function parseEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw gameError("Brak monet do rozliczenia.");
  if (raw.length > MAX_COLLECT_BATCH) throw gameError("Za dużo monet naraz.");
  const out = { prize: [], gutter: [] };
  const seen = new Set();
  for (const e of raw) {
    const id = String(e?.id ?? "");
    if (!/^\d{1,18}$/.test(id) || seen.has(id)) continue;
    const where = e?.where === "prize" ? "prize" : (e?.where === "gutter" || e?.where === "lost") ? "gutter" : null;
    if (!where) continue;
    seen.add(id);
    out[where].push(id);
  }
  return out;
}

// One stats row per player session, booked at SETTLEMENT (see coinpusher.sql).
async function bookSession(tx, userId, bet, won, counts, luck) {
  const effect = luck ? "casino_luck" : null;
  const p = (await tx`select session_id from public.coinpusher_players where user_id = ${userId}`)[0];
  const open = p?.session_id ? await tx`
    select id from public.coinpusher_spins
     where id = ${p.session_id}
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
    values (${userId}, ${bet}, ${won}, ${counts.prize}, ${counts.gutter}, ${counts.gold}, ${counts.jackpot}, ${effect})
    returning id
  `;
  await tx`
    insert into public.coinpusher_players (user_id, session_id) values (${userId}, ${rows[0].id})
    on conflict (user_id) do update set session_id = excluded.session_id
  `;
}

async function handleCollect(user, payload) {
  const ev = parseEvents(payload?.events);
  return await db.begin(async tx => {
    const m = await lockShared(tx);
    requireHost(m, user.id, payload?.lease);
    const lastThrow = m.last_throw_at ? new Date(m.last_throw_at).getTime() : 0;
    const claimable = Date.now() - lastThrow < CLAIM_WINDOW_S * 1000;
    const ids = [...ev.prize, ...ev.gutter];
    const rows = await tx`
      select id, user_id, kind, value, funded, created_at from public.coinpusher_coins
       where id = any(${ids}::bigint[]) and machine_id = ${MACHINE} and status = 'in_machine'
         and created_at < now() - make_interval(secs => ${MIN_COIN_AGE_MS / 1000}::double precision)
       for update
    `;
    const byId = new Map(rows.map(r => [String(r.id), r]));
    const prizeSet = new Set(ev.prize);
    const thrower = recentThrower(m);

    // Decide every coin's fate: [coin, 'prize'|'gutter', recipient|null].
    const fates = [];
    const ownerlessTo = new Map();      // recipient → ownerless value granted in this batch
    let throwerRow = null;
    if (thrower) {
      throwerRow = await lockPlayer(tx, thrower);
      const since = throwerRow.ownerless_since ? new Date(throwerRow.ownerless_since).getTime() : 0;
      if (Date.now() - since > 60_000) throwerRow = { ...throwerRow, ownerless_since: new Date(), ownerless_paid: 0, reset: true };
    }
    let ownerlessRoom = throwerRow ? Math.max(0, OWNERLESS_CAP_PER_MIN - Number(throwerRow.ownerless_paid)) : 0;
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      if (!prizeSet.has(id)) { fates.push([c, "gutter", null]); continue; }
      if (!claimable) continue;                         // stays in the machine
      if (c.user_id) { fates.push([c, "prize", c.user_id]); continue; }
      if (thrower && Number(c.value) <= ownerlessRoom) {
        ownerlessRoom -= Number(c.value);
        ownerlessTo.set(thrower, (ownerlessTo.get(thrower) || 0) + Number(c.value));
        fates.push([c, "prize", thrower]);
      } else {
        fates.push([c, "gutter", null]);                // nobody eligible → recycled
      }
    }
    if (!fates.length) return { ok: true, paid: {}, settled: [], bank: Number(m.house_bank), claimable };

    const prizeIds = fates.filter(f => f[1] === "prize").map(f => String(f[0].id));
    const gutterIds = fates.filter(f => f[1] === "gutter").map(f => String(f[0].id));
    if (prizeIds.length) await tx`update public.coinpusher_coins set status = 'prize', resolved_at = now() where id = any(${prizeIds}::bigint[])`;
    if (gutterIds.length) await tx`update public.coinpusher_coins set status = 'gutter', resolved_at = now() where id = any(${gutterIds}::bigint[])`;

    const luck = await casinoLuck(tx);
    const gutterValue = fates.filter(f => f[1] === "gutter").reduce((s, f) => s + Number(f[0].value), 0);
    const recycled = Math.floor(gutterValue * (luck ? CASINO_LUCK_RECYCLE : RECYCLE));
    const bank = Math.min(BANK_CAP, Number(m.house_bank) + recycled);
    if (bank !== Number(m.house_bank)) {
      await tx`update public.coinpusher_shared set house_bank = ${bank}, updated_at = now() where id = ${MACHINE}`;
    }
    if (throwerRow && ownerlessTo.size) {
      await tx`
        update public.coinpusher_players
           set ownerless_since = ${throwerRow.reset ? new Date() : throwerRow.ownerless_since},
               ownerless_paid = ${Number(throwerRow.reset ? 0 : throwerRow.ownerless_paid) + (ownerlessTo.get(thrower) || 0)}
         where user_id = ${thrower}
      `;
    }

    // Per player: what they won, and what their own resolved coins had cost them.
    const per = new Map();
    const get = u => { if (!per.has(u)) per.set(u, { won: 0, bet: 0, prize: 0, gutter: 0, gold: 0, jackpot: 0, ids: [] }); return per.get(u); };
    for (const [c, where, to] of fates) {
      if (c.user_id) {
        const o = get(c.user_id);
        o.bet += Number(c.funded);
        if (where === "gutter") o.gutter++;
      }
      if (where === "prize" && to) {
        const r = get(to);
        r.won += Number(c.value); r.prize++; r.ids.push(String(c.id));
        if (c.kind === "gold") r.gold++;
        if (c.kind === "jackpot") r.jackpot++;
      }
    }
    const users = [...per.keys()].sort();
    for (const u of users) {
      const o = per.get(u);
      if (o.won > 0) await tx`update public.profiles set coins = coins + ${o.won} where id = ${u}`;
      if (o.bet > 0 || o.won > 0) await bookSession(tx, u, o.bet, o.won, o, luck);
    }
    await tx`
      insert into public.coinpusher_exits (coin_id, owner_id, paid_to, where_to, value, host_user)
      select * from unnest(${fates.map(f => String(f[0].id))}::bigint[], ${fates.map(f => f[0].user_id)}::uuid[],
                           ${fates.map(f => f[2])}::uuid[], ${fates.map(f => f[1])}::text[],
                           ${fates.map(f => Number(f[0].value))}::bigint[], ${fates.map(() => user.id)}::uuid[])
    `;
    const nicks = await nicksOf(tx, users);
    const paid = {};
    for (const u of users) {
      const o = per.get(u);
      if (o.won > 0) paid[u] = { amount: o.won, ids: o.ids, nick: nicks[u] ?? null, jackpot: o.jackpot, gold: o.gold };
    }
    if (Object.keys(paid).length) broadcast([{ event: "paid", payload: { paid, bank } }]);
    return { ok: true, paid, settled: fates.map(f => String(f[0].id)), bank, claimable };
  });
}

// ── pocket (host only) ──────────────────────────────────────────────────────
async function handlePocket(user, payload) {
  const kind = String(payload?.pocket ?? "");
  if (!["rain", "gold", "tower"].includes(kind)) throw gameError("Nieznana kieszeń.");
  return await db.begin(async tx => {
    const m = await lockShared(tx);
    requireHost(m, user.id, payload?.lease);
    let bank = Number(m.house_bank);
    const lastThrow = m.last_throw_at ? new Date(m.last_throw_at).getTime() : 0;
    if (Date.now() - lastThrow > CLAIM_WINDOW_S * 1000) return { ok: true, coins: [], bank, reason: "idle" };

    let coins = [], owner = null;
    if (kind === "tower") {
      const last = m.last_tower_at ? new Date(m.last_tower_at).getTime() : 0;
      if (Date.now() - last < TOWER_MIN_GAP_S * 1000) return { ok: true, coins: [], bank, reason: "cooldown" };
      owner = recentThrower(m);
      const n = Math.min(TOWER_SHOWER_COINS, Math.floor(bank / COIN_VALUE));
      if (n >= 6) { coins = await insertCoins(tx, owner, "rain", COIN_VALUE, n); bank -= n * COIN_VALUE; }
      await tx`update public.coinpusher_shared set last_tower_at = now() where id = ${MACHINE}`;
    } else {
      const id = String(payload?.coinId ?? "");
      if (!/^\d{1,18}$/.test(id)) throw gameError("Nieprawidłowa moneta.");
      const hit = await tx`
        update public.coinpusher_coins set pocketed_at = now()
         where id = ${id}::bigint and machine_id = ${MACHINE} and status = 'in_machine'
           and funded > 0 and pocketed_at is null
           and created_at > now() - make_interval(secs => ${POCKET_MAX_AGE_S}::double precision)
        returning user_id
      `;
      if (!hit.length) return { ok: true, coins: [], bank, reason: "not_eligible" };
      owner = hit[0].user_id;                          // the bonus belongs to whoever threw the coin
      if (kind === "rain") {
        const n = Math.min(POCKET_RAIN_COINS, Math.floor(bank / COIN_VALUE));
        if (n >= 4) { coins = await insertCoins(tx, owner, "rain", COIN_VALUE, n); bank -= n * COIN_VALUE; }
      } else if (bank >= POCKET_GOLD_VALUE) {
        coins = await insertCoins(tx, owner, "gold", POCKET_GOLD_VALUE, 1);
        bank -= POCKET_GOLD_VALUE;
      }
    }
    if (coins.length) {
      await tx`update public.coinpusher_shared set house_bank = ${bank}, updated_at = now() where id = ${MACHINE}`;
      const nick = owner ? (await nicksOf(tx, [owner]))[owner] ?? null : null;
      broadcast([{ event: "bonus", payload: { pocket: kind, owner, nick, coins: coins.length, bank } }]);
    }
    return { ok: true, pocket: kind, coins: coins.map(coinOut), bank };
  });
}

// ── save_layout (host only) ─────────────────────────────────────────────────
async function handleSaveLayout(user, payload) {
  const layout = payload?.layout;
  if (!layout || layout.v !== 1 || !Array.isArray(layout.coins)) throw gameError("Zły układ.");
  const text = JSON.stringify(layout);
  if (text.length > MAX_LAYOUT_BYTES) throw gameError("Układ za duży.");
  const rows = await db`
    update public.coinpusher_shared
       set layout = ${text}::jsonb, layout_saved_at = now()
     where id = ${MACHINE}
       and host_user = ${user.id} and host_lease = ${String(payload?.lease ?? "")}
       and (layout_saved_at is null
            or layout_saved_at < now() - make_interval(secs => ${LAYOUT_MIN_INTERVAL_MS / 1000}::double precision))
    returning id
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
      case "host_beat":   return json(req, await handleHostBeat(user, payload));
      case "drop":        return json(req, await handleDrop(user, payload));
      case "collect":     return json(req, await handleCollect(user, payload));
      case "pocket":      return json(req, await handlePocket(user, payload));
      case "save_layout": return json(req, await handleSaveLayout(user, payload));
      default:            return json(req, { ok: false, error: "Nieznana akcja." }, 400);
    }
  } catch (err) {
    const message = err?.isGame ? err.message : "Coś poszło nie tak.";
    if (!err?.isGame) console.error("coinpusher-action", err);
    return json(req, { ok: false, error: message, code: err?.code ?? null }, err?.isGame ? 400 : 500);
  }
});
