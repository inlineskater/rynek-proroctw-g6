// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
//  „Wieżowiec G6" — stack floors, cash out before it falls. The server owns
//  every landing.
// ════════════════════════════════════════════════════════════════════════════
//  The client never rolls a landing, never computes a payout and never learns
//  anything before it is public: each drop is decided from crypto RNG at the
//  moment `build` is called, then animated. No secrets table — see the header
//  of supabase/tower.sql.
//
//  ⚠️ The house edge is applied ONCE at cash-out, never per floor: each floor
//  multiplies the pot by exactly 1/p, so the tower is a martingale and RTP is a
//  flat 95% at any height with any mix of blocks.
//
//  ⚠️ A block whose next multiplier would cross the coin ceiling is NOT
//  OFFERED rather than clamped (clamping would make that floor quietly unfair,
//  the one way the printed odds could lie). When nothing fits, the tower cashes
//  itself out.
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

// Probabilities are in THOUSANDTHS so a landing is an exact integer comparison
// (randomInt(1000) < pm) — no float can make 90% into 89.99…%.
const TIERS = {
  wide:   { pm: 900, label: "Szeroki" },
  normal: { pm: 700, label: "Normalny" },
  narrow: { pm: 450, label: "Wąski" },
};
const TIER_ORDER = ["wide", "normal", "narrow"];

const HOUSE_FACTOR = 0.95;
// Timed COMMUNAL „Amulet Bezwstydnego Fartu" (casino-luck-item.sql): while ANY
// unexpired instance exists, the edge is this instead (RTP 95% -> 98%), exactly
// as in Drabina Kariery. Never set >= 1.
const CASINO_LUCK_HOUSE_FACTOR = 0.98;

// The ceiling that matters is in COINS (a multiplier cap alone is meaningless
// for a 10-coin stake and ruinous for a 10 000-coin one). Same values as
// hilo-action: ~a third of the measured money supply, a genuine all-time event.
const MAX_PAYOUT = 150_000;
const MAX_MULT = 100_000;
const MAX_FLOORS = 60;
const STAKES = [10, 25, 50, 100, 250, 500, 1000];
const MAX_BET = 10_000_000;
const DEFAULT_BET = 50;

function gameError(message) {
  return Object.assign(new Error(message), { isGame: true });
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

function validateBet(raw) {
  const bet = Math.trunc(Number(raw ?? DEFAULT_BET));
  if (!Number.isInteger(bet) || bet < 1 || bet > MAX_BET) throw gameError("Nieprawidłowa stawka.");
  return bet;
}

// Unbiased: rejection-sample instead of `% 1000`, which would favour the low
// values by a hair (2^32 is not a multiple of 1000).
function randomBelow(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

function floor4(n) { return Math.floor(n * 10000) / 10000; }

// The pot as SHOWN: whole coins, rounded down, so the figure on screen is a
// promise the settlement can only meet or beat.
function payoutFor(bet, multiplier, houseFactor) {
  return Math.min(MAX_PAYOUT, Math.floor(Number(bet) * Number(multiplier) * Number(houseFactor)));
}

// The pot as PAID: stochastic rounding, i.e. floor(x) plus one more coin with
// probability frac(x). E[paid] is then exactly x, so the 95% holds at every
// stake — a plain floor() leaks up to one coin a round, which at a 10-coin
// stake is 3.5 points of RTP (measured by scripts/tower-rtp.mjs). Never pays
// less than payoutFor() showed.
function settlePayout(bet, multiplier, houseFactor) {
  const exact = Math.min(MAX_PAYOUT, Number(bet) * Number(multiplier) * Number(houseFactor));
  const whole = Math.floor(exact);
  const frac = exact - whole;
  return whole + (frac > 0 && randomBelow(1_000_000) < Math.round(frac * 1_000_000) ? 1 : 0);
}

// The multiplier at which this stake reaches MAX_PAYOUT.
function capMultiplier(bet, houseFactor) {
  return Math.min(MAX_MULT, MAX_PAYOUT / (Number(bet) * Number(houseFactor)));
}

// What each block would do from here: true probability, the per-floor factor,
// the pot it would become, and whether it is offered at all (a block that
// would cross the ceiling is not — see the header).
function optionsFor(bet, multiplier, houseFactor, floors) {
  const ceiling = capMultiplier(bet, houseFactor);
  const out = {};
  for (const key of TIER_ORDER) {
    const t = TIERS[key];
    const next = multiplier * 1000 / t.pm;
    out[key] = {
      p: t.pm / 1000,
      step: floor4(1000 / t.pm),
      next: floor4(next),
      nextPayout: payoutFor(bet, next, houseFactor),
      allowed: next <= ceiling && floors < MAX_FLOORS,
    };
  }
  return out;
}

function anyAllowed(opts) {
  return TIER_ORDER.some(k => opts[k].allowed);
}

async function casinoLuckFactor(tx) {
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
    return rows.length > 0 ? CASINO_LUCK_HOUSE_FACTOR : HOUSE_FACTOR;
  } catch (err) {
    console.warn("Casino luck lookup unavailable:", err?.message ?? err);
    return HOUSE_FACTOR;
  }
}

function roundOut(row) {
  if (!row) return null;
  const multiplier = Number(row.multiplier);
  const houseFactor = Number(row.house_factor);
  const floors = Number(row.floors);
  return {
    id: row.id,
    bet: Number(row.bet),
    floors,
    multiplier: floor4(multiplier),
    status: row.status,
    history: Array.isArray(row.history) ? row.history : [],
    options: optionsFor(Number(row.bet), multiplier, houseFactor, floors),
    cashOut: payoutFor(row.bet, multiplier, houseFactor),
    casinoLuck: houseFactor !== HOUSE_FACTOR,
    maxMultiplier: floor4(capMultiplier(row.bet, houseFactor)),
    maxPayout: MAX_PAYOUT,
    maxFloors: MAX_FLOORS,
  };
}

async function activeRound(tx, userId, forUpdate = false) {
  const rows = forUpdate
    ? await tx`select * from public.tower_rounds where user_id = ${userId} and status = 'active' for update`
    : await tx`select * from public.tower_rounds where user_id = ${userId} and status = 'active'`;
  return rows[0] ?? null;
}

async function coinsOf(tx, userId, forUpdate = false) {
  const rows = forUpdate
    ? await tx`select coins from public.profiles where id = ${userId} for update`
    : await tx`select coins from public.profiles where id = ${userId}`;
  if (!rows[0]) throw gameError("Nie znaleziono profilu.");
  return Number(rows[0].coins);
}

function blockMix(history) {
  const mix = { wide: 0, normal: 0, narrow: 0 };
  for (const h of history) if (h.won && mix[h.tier] !== undefined) mix[h.tier] += 1;
  return mix;
}

// Close a round: write the spin row (history, Hazardista and the economy stats
// read tower_spins, never tower_rounds) and pay out if anything is owed.
async function finish(tx, round, result, payout) {
  const history = Array.isArray(round.history) ? round.history : [];
  await tx`
    update public.tower_rounds
       set status = ${result}, ended_at = now(), floors = ${round.floors},
           multiplier = ${round.multiplier}, history = ${JSON.stringify(history)}::jsonb
     where id = ${round.id} and status = 'active'
  `;
  await tx`
    insert into public.tower_spins
      (user_id, round_id, bet, floors, multiplier, total_won, result, blocks, item_effect)
    values (${round.user_id}, ${round.id}, ${round.bet}, ${round.floors},
            ${round.multiplier}, ${payout}, ${result},
            ${JSON.stringify(blockMix(history))}::jsonb,
            ${Number(round.house_factor) !== HOUSE_FACTOR ? "casino_luck" : null})
  `;
  if (payout > 0) {
    const rows = await tx`
      update public.profiles set coins = coins + ${payout}
       where id = ${round.user_id} returning coins
    `;
    return Number(rows[0].coins);
  }
  return await coinsOf(tx, round.user_id);
}

async function handleState(user) {
  return await db.begin(async tx => {
    const row = await activeRound(tx, user.id);
    const factor = await casinoLuckFactor(tx);
    return {
      ok: true,
      round: roundOut(row),
      coins: await coinsOf(tx, user.id),
      stakes: STAKES,
      defaultBet: DEFAULT_BET,
      tiers: Object.fromEntries(TIER_ORDER.map(k => [k, { p: TIERS[k].pm / 1000, step: floor4(1000 / TIERS[k].pm) }])),
      maxPayout: MAX_PAYOUT,
      maxFloors: MAX_FLOORS,
      casinoLuck: factor !== HOUSE_FACTOR,
      houseFactor: factor,
    };
  });
}

async function handleStart(user, payload) {
  const bet = validateBet(payload?.bet);
  return await db.begin(async tx => {
    if (await activeRound(tx, user.id, true)) throw gameError("Masz już budowę w toku.");
    // Lock the balance BEFORE taking the stake, same order as every other table.
    const coins = await coinsOf(tx, user.id, true);
    if (coins < bet) throw gameError("Za mało monet.");
    const factor = await casinoLuckFactor(tx);
    await tx`update public.profiles set coins = coins - ${bet} where id = ${user.id}`;
    const rows = await tx`
      insert into public.tower_rounds (user_id, bet, house_factor)
      values (${user.id}, ${bet}, ${factor})
      returning *
    `;
    return { ok: true, round: roundOut(rows[0]), coins: coins - bet, casinoLuck: factor !== HOUSE_FACTOR };
  });
}

async function handleBuild(user, payload) {
  const tier = TIER_ORDER.includes(payload?.tier) ? payload.tier : null;
  if (!tier) throw gameError("Wybierz blok.");
  return await db.begin(async tx => {
    const round = await activeRound(tx, user.id, true);
    if (!round) throw gameError("Nie masz budowy w toku.");

    const bet = Number(round.bet);
    const houseFactor = Number(round.house_factor);
    const floors = Number(round.floors);
    const multiplier = Number(round.multiplier);
    const opts = optionsFor(bet, multiplier, houseFactor, floors);
    if (!opts[tier].allowed) throw gameError("Ten blok przebiłby sufit wypłaty — wybierz niższy albo wypłać.");

    const pm = TIERS[tier].pm;
    const won = randomBelow(1000) < pm;
    // Where on the tower the block settles, purely cosmetic: a safe landing
    // sits near the centre, a failed one hangs past the edge. Rolled here so
    // every viewer of the feed sees the same tower.
    const offset = won
      ? (randomBelow(61) - 30) / 100            // -0.30..+0.30 of a block width
      : (randomBelow(2) ? 1 : -1) * (0.62 + randomBelow(30) / 100);
    const history = (Array.isArray(round.history) ? round.history : [])
      .concat([{ tier, p: pm / 1000, won, offset }]);

    if (!won) {
      const closing = { ...round, history };
      const coins = await finish(tx, closing, "collapsed", 0);
      return { ok: true, result: "collapsed", tier, won, offset, floors, multiplier: floor4(multiplier), payout: 0, coins, history };
    }

    const nextMult = multiplier * 1000 / pm;
    const nextFloors = floors + 1;
    const nextOpts = optionsFor(bet, nextMult, houseFactor, nextFloors);

    if (!anyAllowed(nextOpts)) {
      // Nothing fits under the ceiling any more — pay out rather than leave a
      // tower that can no longer grow.
      const closing = { ...round, floors: nextFloors, multiplier: nextMult, history };
      const payout = settlePayout(bet, nextMult, houseFactor);
      const coins = await finish(tx, closing, "cashed", payout);
      return { ok: true, result: "capped", tier, won, offset, floors: nextFloors, multiplier: floor4(nextMult), payout, coins, history };
    }

    const rows = await tx`
      update public.tower_rounds
         set floors = ${nextFloors}, multiplier = ${nextMult},
             history = ${JSON.stringify(history)}::jsonb
       where id = ${round.id} and status = 'active'
      returning *
    `;
    return { ok: true, result: "landed", tier, won, offset, round: roundOut(rows[0]), coins: await coinsOf(tx, user.id) };
  });
}

async function handleCashOut(user) {
  return await db.begin(async tx => {
    const round = await activeRound(tx, user.id, true);
    if (!round) throw gameError("Nie masz budowy w toku.");
    if (Number(round.floors) < 1) {
      // Cashing out an empty plot would just refund 95% of the stake — a
      // guaranteed loss nobody means to take.
      throw gameError("Postaw przynajmniej jedno piętro.");
    }
    const payout = settlePayout(round.bet, Number(round.multiplier), Number(round.house_factor));
    const coins = await finish(tx, round, "cashed", payout);
    return { ok: true, result: "cashed", payout, coins,
             floors: Number(round.floors), multiplier: floor4(Number(round.multiplier)) };
  });
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  try {
    const user = await requireUser(req);
    const payload = await req.json().catch(() => ({}));
    switch (payload?.action) {
      case "state":    return json(req, await handleState(user));
      case "start":    return json(req, await handleStart(user, payload));
      case "build":    return json(req, await handleBuild(user, payload));
      case "cash_out": return json(req, await handleCashOut(user));
      default:         return json(req, { ok: false, error: "Nieznana akcja." }, 400);
    }
  } catch (err) {
    const message = err?.isGame ? err.message : "Coś poszło nie tak.";
    if (!err?.isGame) console.error("tower-action", err);
    return json(req, { ok: false, error: message }, err?.isGame ? 400 : 500);
  }
});
