// ════════════════════════════════════════════════════════════════════════════
//  „Automat Monet G6" — a physical 3D coin pusher (tab module, lazy)
// ════════════════════════════════════════════════════════════════════════════
//  Scope rules (see CLAUDE.md „Lazy tab modules"): this file owns its top-level
//  names — index.html must NOT also declare them — and its function
//  declarations overwrite the no-op stub index.html keeps for switchTab() and
//  doLogout() (`stopCoinPusher`).
//
//  Three layers, kept apart on purpose:
//    physics    games/coinpusher-core.js — Rapier rigid bodies, the kinematic
//               pusher, the prize/gutter volumes. Never steered.
//    money      coinpusher-action — the server pays each coin id once and only
//               if it is in this player's machine. This file never computes a
//               balance or a payout; it shows what the server returns.
//    view       everything below: three.js, HUD, audio, effects.
//
//  three.js and Rapier are imported from jsDelivr the first time the tab
//  opens (ensureLib only loads classic scripts). The CSP carries
//  'wasm-unsafe-eval' for Rapier's inlined WebAssembly. The CSS is injected
//  from here: index.html is up against its payload budget.
// ════════════════════════════════════════════════════════════════════════════

const CP_THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js';
const CP_RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.20.0/dist/rapier.mjs';
const CP_CORE_URL = 'games/coinpusher-core.js';

// All player-facing strings in one place (Polish today; swap per locale).
const CP_TEXT = {
  title: 'Automat Monet G6',
  sub: 'Prawdziwa fizyka: każda moneta to bryła, spychacz pcha stos tylko kontaktem. Co spadnie z przodu — Twoje. Co wpadnie w rynny po bokach — automatu.',
  loadingLibs: 'Wczytywanie silnika 3D i fizyki…',
  loadingMachine: 'Otwieranie automatu…',
  loadingSettle: 'Układanie monet…',
  loadingScene: 'Przygotowanie sceny…',
  drop: 'WRZUĆ',
  auto: 'Auto',
  autoStop: 'Stop',
  turbo: 'Turbo',
  bet: 'Stawka',
  balance: 'Saldo',
  lastWin: 'Ostatnia',
  totalWin: 'Sesja',
  motorIdle: 'Wrzuć monetę, aby uruchomić automat',
  lease: 'Automat jest otwarty w innej karcie.',
  leaseBtn: 'Graj tutaj',
  lost: 'Utracono połączenie — zakłady wstrzymane.',
  retry: 'Połącz ponownie',
  error: 'Automat nie działa.',
  noFunds: 'Za mało monet na tę stawkę.',
  gold: '🟡 Moneta 1000 wpadła do automatu!',
  jackpotIn: '💎 Żeton JACKPOT wpadł do automatu!',
  rain: '🌧️ Deszcz monet!',
  jackpot: 'JACKPOT',
  bigWin: 'DUŻA WYGRANA',
  help: 'Przesuń kursor (lub palec) nad automatem, żeby ustawić zrzut, i wciśnij WRZUĆ (spacja). ←/→ przesuwają zrzut. Moneta spada naprawdę — gdzie wyląduje, decyduje fizyka. Spychacz przesuwa stos; monety spadające z przedniej krawędzi wygrywasz, te z bocznych rynien zabiera automat (to jego przewaga — część z nich wraca do automatu jako złote monety, żetony jackpot i deszcz monet). Silnik staje po minucie bez wrzutu i rusza przy następnej monecie.',
};

const CP_STATES = ['LOADING', 'READY', 'DROPPING', 'PLAYING', 'BONUS', 'BIG_WIN', 'PAUSED', 'CONNECTION_LOST', 'ERROR'];

const CP_QUALITY = {
  LOW:    { pixelRatio: 1,    shadows: false, shadowSize: 0,    tex: 256, antialias: false, sparks: 40,  confetti: 80 },
  MEDIUM: { pixelRatio: 1.5,  shadows: true,  shadowSize: 1024, tex: 256, antialias: true,  sparks: 90,  confetti: 160 },
  HIGH:   { pixelRatio: 2,    shadows: true,  shadowSize: 2048, tex: 512, antialias: true,  sparks: 140, confetti: 260 },
  ULTRA:  { pixelRatio: 2.5,  shadows: true,  shadowSize: 4096, tex: 512, antialias: true,  sparks: 200, confetti: 320 },
};

const CP_CAMERAS = {
  STANDARD:  { pos: [0, 30, 44], look: [0, -1, -3], fov: 36 },
  CLOSE:     { pos: [0, 17, 31], look: [0, -1, 3], fov: 38 },
  TOP:       { pos: [0, 56, 8], look: [0, 0, -3], fov: 36 },
  CINEMATIC: { pos: [0, 24, 40], look: [0, -1, -1], fov: 34 },
};

const CP_LOOKS = ['house', 'coin5', 'coin10', 'coin25', 'coin50', 'coin100', 'gold', 'jackpot'];
const CP_AUTO_COUNTS = [10, 25, 50, 100];
const CP_CLIENT_COOLDOWN_MS = 110;   // spam-friendly; server allows 8/s, burst 6
const CP_AUTO_MS = 480;
const CP_AUTO_TURBO_MS = 300;
const CP_FLUSH_MS = 450;
const CP_LAYOUT_MS = 12000;
const CP_FEED_MS = 30000;
const CP_REALITY_CHECK_MS = 30 * 60 * 1000;

// ── Module state ──────────────────────────────────────────────────────────
let cpLibsPromise = null;
let cpThree = null;
let cpRapier = null;
let cpCore = null;
let cpSim = null;
let cpView = null;         // renderer/scene/camera/meshes
let cpUi = null;           // DOM refs
let cpRaf = 0;
let cpState = 'LOADING';
let cpServer = null;       // last `state` payload (lease, stakes, …)
let cpStake = 10;
let cpDropX = 0;
let cpDropTarget = 0;
let cpInflight = 0;
let cpLastDropAt = 0;
let cpLastMotorAt = 0;
let cpPending = [];        // [{id, where}] awaiting `collect`
let cpFlushing = false;
let cpTimers = {};
let cpAuto = { left: 0, total: 0, timer: 0 };
let cpTurbo = false;
let cpReducedMotion = false;
let cpQualityName = null;
let cpCameraMode = 'STANDARD';
let cpDebug = null;        // debug overlay state (admins / ?cpdebug only)
let cpSession = { started: 0, staked: 0, won: 0, lastWin: 0, lastCheck: 0 };
let cpAudio = null;
let cpFx = null;
let cpLoadToken = 0;
let cpLastFrame = 0;
let cpAcc = 0;
let cpPusherPrev = 0;
let cpShake = 0;
let cpWinHold = 0;
let cpLayoutSig = '';
let cpPageMode = true;     // full-page while playing; ✕ / Esc returns to the normal tab layout

function cpEmit(type, detail) {
  // Integration hook for the host page / analytics. Never carries personal data.
  try { window.dispatchEvent(new CustomEvent('coinpusher', { detail: { type, ...(detail || {}) } })); } catch (_) {}
}

function cpStore(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('cp.' + key) || 'null');
    localStorage.setItem('cp.' + key, JSON.stringify(value));
  } catch (_) { return null; }
  return value;
}

// ── CSS ───────────────────────────────────────────────────────────────────
(function cpInjectCss() {
  if (document.getElementById('coinpusher-css')) return;
  const s = document.createElement('style');
  s.id = 'coinpusher-css';
  s.textContent = `
    #tab-coinpusher main { max-width: 1180px; margin: 0 auto; }
    .cp-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 16px; align-items: start; }
    @media (max-width: 980px) { .cp-wrap { grid-template-columns: minmax(0, 1fr); } }
    .cp-hero { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .cp-hero h2 { margin: 0; font-size: 22px; display: flex; gap: 8px; align-items: center; }
    .cp-hero p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; flex: 1 1 320px; }
    .cp-stage { position: relative; width: 100%; aspect-ratio: 16 / 11; min-height: 340px; max-height: calc(100vh - 170px);
      border-radius: 16px; overflow: hidden; background: radial-gradient(120% 90% at 50% 18%, #2a2116 0%, #120e0a 45%, #050507 100%);
      box-shadow: 0 20px 60px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,210,130,.12); touch-action: none; user-select: none; }
    .cp-stage.is-full { max-height: none; height: 100vh; aspect-ratio: auto; border-radius: 0; }
    /* Full-page mode (the default while playing): the machine fills the whole
       browser window, over the header, nav and chat rail (≤ 61) but under
       modals (100) and toasts (300), so errors and wins still show. */
    .cp-stage.is-page { position: fixed; inset: 0; z-index: 90; width: auto; height: 100vh; height: 100dvh;
      max-height: none; min-height: 0; aspect-ratio: auto; border-radius: 0; box-shadow: none; }
    .cp-stage.is-page .cp-hud-bot { padding-bottom: max(10px, env(safe-area-inset-bottom)); }
    html.cp-page-lock, html.cp-page-lock body { overflow: hidden; }
    @media (max-width: 640px) { .cp-stage { aspect-ratio: 3 / 4; max-height: calc(100vh - 150px); min-height: 380px; border-radius: 12px; } }
    .cp-stage canvas { display: block; width: 100%; height: 100%; outline: none; }
    .cp-hud-top { position: absolute; left: 10px; right: 10px; top: 10px; display: flex; gap: 8px; justify-content: space-between; pointer-events: none; flex-wrap: wrap; }
    .cp-kpi { background: rgba(10,8,6,.62); border: 1px solid rgba(255,214,140,.22); border-radius: 10px; padding: 5px 10px; color: #f6ead2;
      font-variant-numeric: tabular-nums; min-width: 78px; backdrop-filter: blur(4px); }
    .cp-kpi small { display: block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #cdb58a; }
    .cp-kpi b { font-size: 16px; }
    .cp-kpi.is-win b { color: #ffd66b; }
    .cp-status { position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%); padding: 4px 12px; border-radius: 999px;
      font-size: 12px; color: #f7e7c4; background: rgba(0,0,0,.55); border: 1px solid rgba(255,214,140,.25); pointer-events: none; white-space: nowrap; }
    .cp-status[data-state="PLAYING"] { color: #b9f5c8; }
    .cp-status[data-state="CONNECTION_LOST"], .cp-status[data-state="ERROR"] { color: #ffb3a8; }
    .cp-hud-bot { position: absolute; left: 0; right: 0; bottom: 0; padding: 10px; display: flex; gap: 8px; align-items: center; justify-content: center; flex-wrap: wrap;
      background: linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,.6) 45%); }
    .cp-btn { appearance: none; border: 1px solid rgba(255,214,140,.35); background: rgba(24,18,12,.8); color: #f6ead2; border-radius: 10px;
      min-height: 40px; padding: 0 12px; font: 600 13px/1 inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .cp-btn:hover:not(:disabled) { border-color: rgba(255,214,140,.7); }
    .cp-btn:focus-visible { outline: 2px solid #ffd66b; outline-offset: 2px; }
    .cp-btn:disabled { opacity: .45; cursor: not-allowed; }
    .cp-btn.is-on { background: #5b4418; border-color: #ffd66b; }
    .cp-drop { justify-content: center; min-width: 132px; min-height: 52px; font-size: 17px; letter-spacing: .06em; border-radius: 14px; color: #1c1406;
      background: linear-gradient(180deg, #ffe39a, #e0a73b 55%, #b67b1d); border-color: #fff0c2; box-shadow: 0 6px 18px rgba(224,167,59,.35); }
    .cp-drop:disabled { filter: grayscale(.6); }
    .cp-bet { display: inline-flex; align-items: center; gap: 4px; background: rgba(24,18,12,.8); border: 1px solid rgba(255,214,140,.35); border-radius: 10px; padding: 2px; }
    .cp-bet .cp-btn { min-height: 36px; min-width: 36px; padding: 0; justify-content: center; border: 0; }
    .cp-btn[hidden] { display: none; }
    .cp-bet span { padding: 0 8px; min-width: 56px; text-align: center; color: #ffe39a; font-weight: 700; font-variant-numeric: tabular-nums; }
    .cp-auto select { background: transparent; color: inherit; border: 0; font: inherit; }
    .cp-tools { position: absolute; right: 10px; top: 58px; display: flex; flex-direction: column; gap: 6px; }
    .cp-tools .cp-btn { min-height: 34px; min-width: 34px; padding: 0 8px; justify-content: center; font-size: 14px; }
    .cp-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px;
      background: radial-gradient(80% 70% at 50% 40%, rgba(30,22,12,.92), rgba(5,5,7,.97)); color: #f6ead2; text-align: center; padding: 20px; z-index: 3; }
    .cp-overlay h3 { margin: 0; font-size: 26px; letter-spacing: .04em; background: linear-gradient(180deg, #fff1c4, #d99a2b); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .cp-bar { width: min(320px, 80%); height: 6px; border-radius: 6px; background: rgba(255,255,255,.1); overflow: hidden; }
    .cp-bar > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #ffd66b, #e0a73b); transition: width .25s; }
    .cp-overlay p { margin: 0; font-size: 13px; color: #cdb58a; max-width: 420px; }
    .cp-float { position: absolute; left: 0; top: 0; pointer-events: none; font: 800 18px/1 inherit; color: #ffe39a; text-shadow: 0 2px 6px rgba(0,0,0,.8);
      will-change: transform, opacity; white-space: nowrap; }
    .cp-float.is-gutter { color: #9aa0a6; font-size: 13px; font-weight: 600; }
    .cp-banner { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%) scale(.9); opacity: 0; pointer-events: none; text-align: center;
      font: 900 44px/1 inherit; letter-spacing: .08em; color: #fff3c9; text-shadow: 0 0 24px rgba(255,190,60,.8), 0 4px 10px rgba(0,0,0,.8); transition: opacity .25s, transform .35s; z-index: 2; }
    .cp-banner small { display: block; font-size: 20px; margin-top: 8px; color: #ffe39a; }
    .cp-banner.is-on { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    .cp-side { display: flex; flex-direction: column; gap: 12px; }
    .cp-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
    .cp-card h4 { margin: 0 0 8px; font-size: 13px; }
    .cp-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; padding: 4px 0; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
    .cp-row:first-of-type { border-top: 0; }
    .cp-note { font-size: 11px; color: var(--muted); line-height: 1.45; margin-top: 6px; }
    .cp-help { position: absolute; right: 54px; top: 58px; width: min(340px, calc(100% - 70px)); background: rgba(12,9,6,.94); color: #eadcbf; border: 1px solid rgba(255,214,140,.3);
      border-radius: 12px; padding: 12px; font-size: 12.5px; line-height: 1.5; z-index: 2; }
    .cp-help label { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
    .cp-debug { position: absolute; left: 10px; bottom: 76px; background: rgba(0,0,0,.78); color: #b8f7c2; font: 11px/1.4 ui-monospace, monospace; padding: 8px; border-radius: 8px;
      max-height: 60%; overflow: auto; z-index: 2; min-width: 220px; }
    .cp-debug label { display: flex; gap: 6px; align-items: center; color: #e5e5e5; }
    .cp-debug input[type=range] { width: 110px; }
    .cp-debug .cp-btn { min-height: 24px; font-size: 11px; padding: 0 6px; }
    @media (max-width: 640px) {
      .cp-kpi { min-width: 64px; padding: 4px 7px; } .cp-kpi b { font-size: 14px; }
      .cp-drop { flex: 1 1 100%; order: -1; min-height: 56px; }
      .cp-status { bottom: 138px; }
      .cp-tools { top: 104px; }
    }
    @media (prefers-reduced-motion: reduce) { .cp-banner { transition: none; } }
  `;
  document.head.appendChild(s);
})();

// ── Library loading ───────────────────────────────────────────────────────
function cpLoadCore() {
  if (window.CoinPusherCore) return Promise.resolve(window.CoinPusherCore);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CP_CORE_URL + (typeof BUILD_ID !== 'undefined' ? '?v=' + BUILD_ID : '');
    s.onload = () => window.CoinPusherCore ? resolve(window.CoinPusherCore) : reject(new Error('core'));
    s.onerror = () => reject(new Error('core'));
    document.body.appendChild(s);
  });
}

function cpImportLibs(progress) {
  if (cpLibsPromise) return cpLibsPromise;
  let done = 0;
  const tick = () => { done++; progress && progress(done / 4); };
  cpLibsPromise = Promise.all([
    import(CP_THREE_URL).then(m => { tick(); return m; }),
    import(CP_RAPIER_URL).then(async m => { tick(); const R = m.default || m; await R.init(); tick(); return R; }),
    cpLoadCore().then(c => { tick(); return c; }),
  ]).then(([three, rapier, core]) => {
    cpThree = three; cpRapier = rapier; cpCore = core;
    return true;
  }).catch(err => { cpLibsPromise = null; throw err; });
  return cpLibsPromise;
}

// ── Network ───────────────────────────────────────────────────────────────
async function cpInvoke(action, body) {
  const { data, error } = await sb.functions.invoke('coinpusher-action', { body: { action, ...(body || {}) } });
  if (error) {
    let payload = null;
    try { payload = await error.context?.json?.(); } catch (_) {}
    const e = new Error(payload?.error || 'Brak połączenia z automatem.');
    e.code = payload?.code || (payload ? 'game' : 'network');
    throw e;
  }
  if (!data || data.ok === false) {
    const e = new Error(data?.error || 'Błąd automatu.');
    e.code = data?.code || 'game';
    throw e;
  }
  return data;
}

function cpSetBalance(n) {
  if (!Number.isFinite(Number(n))) return;
  if (me) me.coins = Number(n);
  setText(headerCoins, fmtCoins(n));
  if (cpUi) cpUi.balance.textContent = fmtCoins(n);
}

function cpUuid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// ── State machine ─────────────────────────────────────────────────────────
function cpSetState(next, note) {
  if (!CP_STATES.includes(next)) return;
  const prev = cpState;
  cpState = next;
  if (!cpUi) return;
  cpUi.status.dataset.state = next;
  cpUi.status.textContent = note || cpStatusText(next);
  const canDrop = next === 'READY' || next === 'PLAYING' || next === 'BONUS' || next === 'BIG_WIN' || next === 'DROPPING';
  cpUi.drop.disabled = !canDrop;
  if (!canDrop) cpStopAuto();
  if (prev !== next) cpEmit('state', { from: prev, to: next });
}

function cpStatusText(s) {
  switch (s) {
    case 'LOADING': return 'Wczytywanie…';
    case 'READY': return CP_TEXT.motorIdle;
    case 'DROPPING': return 'Moneta w szczelinie…';
    case 'PLAYING': return 'Spychacz pracuje';
    case 'BONUS': return CP_TEXT.rain;
    case 'BIG_WIN': return CP_TEXT.bigWin;
    case 'PAUSED': return 'Pauza';
    case 'CONNECTION_LOST': return CP_TEXT.lost;
    case 'ERROR': return CP_TEXT.error;
  }
  return s;
}

function cpPlayable() {
  return cpState === 'READY' || cpState === 'PLAYING' || cpState === 'BONUS' || cpState === 'BIG_WIN' || cpState === 'DROPPING';
}

// ── Entry point ───────────────────────────────────────────────────────────
async function loadCoinPusher() {
  cpReducedMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) || !!cpStore('reducedMotion');
  if (cpSim && cpView && cpServer) {
    // Coming back to the tab: the machine is still here — just resume.
    if (!cpUi.root.isConnected) document.getElementById('cp-root').replaceChildren(cpUi.root);
    cpResume();
    return;
  }
  const token = ++cpLoadToken;
  cpBuildDom();
  cpApplyPageMode(cpPageMode);
  cpSetState('LOADING');
  cpOverlay('loading', CP_TEXT.loadingLibs, 0.05);
  try {
    await cpImportLibs(p => cpOverlayProgress(0.05 + p * 0.45));
    if (token !== cpLoadToken) return;
    cpOverlay('loading', CP_TEXT.loadingMachine, 0.55);
    const state = await cpInvoke('state');
    if (token !== cpLoadToken) return;
    await cpBuildMachine(state, token);
  } catch (err) {
    if (token !== cpLoadToken) return;
    console.error('coinpusher', err);
    if (err.code === 'network' || /Failed to fetch|NetworkError/i.test(err.message)) {
      cpSetState('CONNECTION_LOST');
      cpOverlay('lost', CP_TEXT.lost);
    } else {
      cpSetState('ERROR', err.message);
      cpOverlay('error', err.message || CP_TEXT.error);
    }
    cpEmit('game_error', { message: String(err.message || err) });
  }
}

async function cpBuildMachine(state, token) {
  cpServer = state;
  cpStake = state.stakes.includes(cpStore('stake')) ? cpStore('stake') : state.defaultStake;
  cpSetBalance(state.balance);
  const saved = cpStore('tuning');
  const overrides = cpDebugAllowed() && saved ? saved : {};
  if (cpSim) { cpSim.dispose(); cpSim = null; }
  cpSim = cpCore.cpCreateSim(cpRapier, { config: overrides });
  cpSim.motorOn = false;                        // parked until the first coin
  cpSim.onCollect = cpOnCollect;
  cpSim.onImpact = cpOnImpact;

  // Rebuild the pile: from the saved shape where it matches the server's
  // coins, otherwise a fresh starting arrangement. Settled hidden, with
  // collection OFF — nothing can be won by reloading.
  const coins = state.coins || [];
  const layout = state.layout && state.layout.v === 1 ? state.layout : null;
  if (layout) cpSim.restore(layout, coins, 7);
  else cpSim.layoutPile(coins, 1);
  cpOverlay('loading', CP_TEXT.loadingSettle, 0.62);
  for (let i = 0; i < 40; i++) {
    const moving = cpSim.settleSteps(15);
    cpOverlayProgress(0.62 + 0.28 * (i + 1) / 40);
    await new Promise(r => setTimeout(r, 0));
    if (token !== cpLoadToken) return;
    if (moving === 0 && i > 2) break;
  }
  cpOverlay('loading', CP_TEXT.loadingScene, 0.94);
  await new Promise(r => setTimeout(r, 0));
  if (!cpView) cpInitView();
  cpRenderUi();
  // Compile every shader and draw one real frame BEFORE the curtain lifts, so
  // the machine never appears half-built or pops in a second later.
  cpView.carriage.position.x = cpDropX;
  cpSyncScene(0, 0);
  cpUpdateCamera(0);
  try { await cpView.renderer.compileAsync(cpView.scene, cpView.camera); } catch (_) {}
  if (token !== cpLoadToken || !cpView) return;
  cpView.renderer.render(cpView.scene, cpView.camera);
  cpOverlay(null);
  cpSession = { started: Date.now(), staked: 0, won: 0, lastWin: 0, lastCheck: Date.now() };
  cpPusherPrev = cpSim.pusherOffset;
  cpSetState('READY');
  cpEmit('game_loaded', { coins: coins.length });
  cpResume();
  cpLoadFeed();
}

function cpResume() {
  cpApplyPageMode(cpPageMode);
  if (!cpSim || !cpView) return;
  cpLastFrame = performance.now();
  cpAcc = 0;
  if (cpState === 'PAUSED') cpSetState(cpSim.motorOn ? 'PLAYING' : 'READY');
  cancelAnimationFrame(cpRaf);
  cpRaf = requestAnimationFrame(cpFrame);
  clearInterval(cpTimers.flush); cpTimers.flush = setInterval(cpFlush, CP_FLUSH_MS);
  clearInterval(cpTimers.layout); cpTimers.layout = setInterval(() => cpSaveLayout(false), CP_LAYOUT_MS);
  clearInterval(cpTimers.feed); cpTimers.feed = setInterval(() => { if (activeTab === 'coinpusher' && !document.hidden) cpLoadFeed(); }, CP_FEED_MS);
  cpResize();
}

// Tab switch (dispose=false) or logout (dispose=true).
function stopCoinPusher(dispose) {
  cancelAnimationFrame(cpRaf); cpRaf = 0;
  document.documentElement.classList.remove('cp-page-lock');
  if (cpUi) cpUi.stage.classList.remove('is-page');
  cpStopAuto();
  for (const k of Object.keys(cpTimers)) { clearInterval(cpTimers[k]); clearTimeout(cpTimers[k]); }
  cpTimers = {};
  if (cpSim && !dispose) {
    cpFlush();
    cpSaveLayout(true);
    if (cpState !== 'LOADING' && cpState !== 'ERROR' && cpState !== 'CONNECTION_LOST') cpSetState('PAUSED');
  }
  if (cpAudio) { try { cpAudio.ctx.suspend(); } catch (_) {} }
  if (dispose) {
    cpLoadToken++;
    if (cpSim) { try { cpSim.dispose(); } catch (_) {} }
    if (cpView) {
      try { cpView.renderer.dispose(); cpView.renderer.forceContextLoss(); } catch (_) {}
      cpView.ro && cpView.ro.disconnect();
    }
    if (cpAudio) { try { cpAudio.ctx.close(); } catch (_) {} }
    cpSim = null; cpView = null; cpServer = null; cpUi = null; cpAudio = null; cpFx = null; cpDebug = null;
    cpPending = []; cpInflight = 0; cpState = 'LOADING'; cpLayoutSig = '';
    const root = document.getElementById('cp-root');
    if (root) root.replaceChildren(el('div', { className: 'loading-center' }, el('div', { className: 'spinner' })));
  }
}

// ── DOM ───────────────────────────────────────────────────────────────────
function cpBuildDom() {
  const root = document.getElementById('cp-root');
  const stage = el('div', { className: 'cp-stage', tabIndex: 0, 'aria-label': 'Automat z monetami — strzałki przesuwają zrzut, spacja wrzuca monetę' });
  const kpi = (label, cls) => {
    const b = el('b', {}, '—');
    const box = el('div', { className: 'cp-kpi' + (cls ? ' ' + cls : '') }, el('small', {}, label), b);
    return [box, b];
  };
  const [balBox, balance] = kpi(CP_TEXT.balance);
  const [lastBox, lastWin] = kpi(CP_TEXT.lastWin, 'is-win');
  const [totBox, totalWin] = kpi(CP_TEXT.totalWin);
  const status = el('div', { className: 'cp-status', role: 'status', 'aria-live': 'polite' }, '');
  const hudTop = el('div', { className: 'cp-hud-top' }, balBox, lastBox, totBox);

  const betLabel = el('span', {}, '—');
  const betMinus = el('button', { className: 'cp-btn', 'aria-label': 'Mniejsza stawka', onclick: () => cpChangeStake(-1) }, '−');
  const betPlus = el('button', { className: 'cp-btn', 'aria-label': 'Większa stawka', onclick: () => cpChangeStake(1) }, '+');
  const bet = el('div', { className: 'cp-bet', title: CP_TEXT.bet }, betMinus, betLabel, betPlus);
  const drop = el('button', { className: 'cp-btn cp-drop', onclick: () => cpDropPressed() }, CP_TEXT.drop);
  const autoSel = el('select', { 'aria-label': 'Liczba automatycznych wrzutów' });
  for (const n of CP_AUTO_COUNTS) autoSel.append(el('option', { value: String(n) }, String(n)));
  const autoBtn = el('button', { className: 'cp-btn cp-auto', onclick: () => cpToggleAuto() }, CP_TEXT.auto);
  const autoWrap = el('div', { className: 'cp-bet cp-auto' }, autoBtn, autoSel);
  const turbo = el('button', { className: 'cp-btn', 'aria-pressed': 'false', onclick: () => cpToggleTurbo() }, '⚡ ' + CP_TEXT.turbo);
  // One button: throw. No auto, no turbo — spam it.
  const hudBot = el('div', { className: 'cp-hud-bot' }, bet, drop);

  const tool = (label, title, fn) => el('button', { className: 'cp-btn', title, 'aria-label': title, onclick: fn }, label);
  const sound = tool('🔊', 'Dźwięk', () => cpToggleSound());
  const cam = tool('🎥', 'Kamera', () => cpCycleCamera());
  const quality = tool('HQ', 'Jakość grafiki', () => cpCycleQuality());
  const page = tool('✕', 'Wyjdź z trybu pełnej strony (Esc)', () => cpSetPageMode(!cpPageMode));
  const full = tool('⛶', 'Pełny ekran', () => cpToggleFullscreen());
  const help = tool('?', 'Pomoc i ustawienia', () => cpToggleHelp());
  const tools = el('div', { className: 'cp-tools' }, page, sound, cam, quality, full, help);

  const banner = el('div', { className: 'cp-banner', 'aria-live': 'assertive' });
  const overlay = el('div', { className: 'cp-overlay' });
  stage.append(hudTop, status, tools, hudBot, banner, overlay);

  const leaders = el('div', { className: 'cp-card' }, el('h4', {}, '🏆 Ten tydzień'));
  const feed = el('div', { className: 'cp-card' }, el('h4', {}, '🪙 Ostatnie sesje'));
  const rules = el('div', { className: 'cp-card' },
    el('h4', {}, 'ℹ️ Jak to działa'),
    el('div', { className: 'cp-note' }, 'Każda moneta ma w banku automatu swój numer. Wygrana to moneta, która naprawdę spadła z przedniej krawędzi — serwer wypłaca ją raz. Monety z bocznych rynien zabiera automat; część ich wartości wraca do Twojego automatu jako monety 1000, żetony jackpot i deszcz monet.'),
    el('div', { className: 'cp-note', id: 'cp-luck-note' }, ''));
  const side = el('div', { className: 'cp-side' }, leaders, feed, rules);
  const hero = el('div', { className: 'cp-hero' },
    el('h2', {}, el('span', {}, '🪙'), el('span', {}, CP_TEXT.title)),
    el('p', {}, CP_TEXT.sub));
  const wrap = el('div', { className: 'cp-wrap' }, hero, el('div', {}, stage), side);
  root.replaceChildren(wrap);

  cpUi = { root: wrap, stage, overlay, status, balance, lastWin, totalWin, betLabel, betMinus, betPlus, drop, autoBtn, autoSel,
    turbo, page, sound, cam, quality, full, help, banner, leaders, feed, helpBox: null, floats: [], sessionNote: null };

  stage.addEventListener('pointermove', cpOnPointer);
  stage.addEventListener('pointerdown', cpOnPointer);
  stage.addEventListener('keydown', cpOnKey);
  document.addEventListener('fullscreenchange', cpResize);
  document.addEventListener('keydown', cpOnPageKey);
  document.addEventListener('visibilitychange', cpOnVisibility);
}

function cpOverlay(kind, text, progress) {
  if (!cpUi) return;
  const o = cpUi.overlay;
  if (!kind) { o.style.display = 'none'; return; }
  o.style.display = '';
  const title = el('h3', {}, kind === 'loading' ? CP_TEXT.title : kind === 'lost' ? 'Brak połączenia' : kind === 'lease' ? 'Automat zajęty' : 'Błąd');
  const children = [title];
  if (kind === 'loading') {
    const bar = el('div', { className: 'cp-bar' }, el('i', {}));
    children.push(bar);
    cpUi.bar = bar.firstChild;
  }
  children.push(el('p', {}, text || ''));
  if (kind === 'lost' || kind === 'error') children.push(el('button', { className: 'cp-btn', onclick: () => cpReconnect() }, CP_TEXT.retry));
  if (kind === 'lease') children.push(el('button', { className: 'cp-btn', onclick: () => cpReconnect() }, CP_TEXT.leaseBtn));
  o.replaceChildren(...children);
  if (progress != null) cpOverlayProgress(progress);
}

function cpOverlayProgress(p) {
  if (cpUi && cpUi.bar) cpUi.bar.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
}

// Reconnect = a fresh `state`: it re-reads the authoritative coins, takes
// the lease back, and rebuilds the pile (keeping the local shape it saved).
async function cpReconnect() {
  const token = ++cpLoadToken;
  cpStopAuto();
  cpOverlay('loading', CP_TEXT.loadingMachine, 0.5);
  try {
    if (!cpThree) await cpImportLibs(p => cpOverlayProgress(p * 0.5));
    if (cpSim) {
      // Keep what the player saw: save the local shape first.
      cpServer = cpServer || {};
      cpServer.layout = cpSim.snapshotLayout();
    }
    const state = await cpInvoke('state');
    if (token !== cpLoadToken) return;
    if (!state.layout && cpServer && cpServer.layout) state.layout = cpServer.layout;
    cpPending = [];
    cpInflight = 0;
    await cpBuildMachine(state, token);
    cpEmit('connection_restored', {});
  } catch (err) {
    if (token !== cpLoadToken) return;
    cpSetState('CONNECTION_LOST');
    cpOverlay('lost', err.message || CP_TEXT.lost);
  }
}

function cpRenderUi() {
  if (!cpUi || !cpServer) return;
  const single = cpServer.stakes.length === 1;
  cpUi.betLabel.textContent = cpStake + ' 🪙' + (single ? ' / moneta' : '');
  const i = cpServer.stakes.indexOf(cpStake);
  cpUi.betMinus.disabled = i <= 0;
  cpUi.betPlus.disabled = i >= cpServer.stakes.length - 1;
  // One denomination: nothing to choose, so no −/+ at all.
  cpUi.betMinus.hidden = single;
  cpUi.betPlus.hidden = single;
  cpUi.sound.textContent = cpAudioMuted() ? '🔇' : '🔊';
  cpUi.quality.textContent = { LOW: 'LQ', MEDIUM: 'MQ', HIGH: 'HQ', ULTRA: 'UQ' }[cpQualityName] || 'HQ';
  cpUi.turbo.classList.toggle('is-on', cpTurbo);
  cpUi.turbo.setAttribute('aria-pressed', String(cpTurbo));
  cpUi.lastWin.textContent = cpSession.lastWin ? '+' + fmtCoins(cpSession.lastWin) : '—';
  const net = cpSession.won - cpSession.staked;
  // Session figure shows the honest net (won − staked), losses included.
  cpUi.totalWin.textContent = (net > 0 ? '+' : '') + fmtCoins(net);
  cpUi.totalWin.parentNode.title = `Wrzucone: ${fmtCoins(cpSession.staked)} 🪙 · wygrane: ${fmtCoins(cpSession.won)} 🪙`;
  const luck = document.getElementById('cp-luck-note');
  if (luck) luck.textContent = cpServer.casinoLuck
    ? '🍀 Amulet aktywny: 70% wartości monet z rynien wraca do automatu (zwykle 40%).'
    : `Z rynien wraca do automatu ${Math.round((cpServer.recycle || 0.4) * 100)}% wartości (maks. ${fmtCoins(cpServer.bankCap || 0)} 🪙 w banku automatu).`;
}

function cpChangeStake(dir) {
  if (!cpServer) return;
  const list = cpServer.stakes;
  const i = Math.max(0, Math.min(list.length - 1, list.indexOf(cpStake) + dir));
  cpStake = list[i];
  cpStore('stake', cpStake);
  cpSound('click');
  cpRenderUi();
}

// ── Input ─────────────────────────────────────────────────────────────────
function cpOnPointer(ev) {
  if (!cpView || !cpSim) return;
  if (ev.target.closest && ev.target.closest('.cp-hud-bot, .cp-tools, .cp-help, .cp-debug, .cp-overlay, .cp-hud-top')) return;
  const rect = cpView.canvas.getBoundingClientRect();
  const D = cpSim.cfg.drop;
  // Map the pointer between where the two ends of the drop rail are on screen.
  const a = cpProject(D.minX, D.y, D.z), b = cpProject(D.maxX, D.y, D.z);
  const px = ev.clientX - rect.left;
  const t = (px - a.x) / Math.max(1, b.x - a.x);
  cpDropTarget = D.minX + Math.max(0, Math.min(1, t)) * (D.maxX - D.minX);
  if (ev.type === 'pointerdown') { cpAudioUnlock(); try { cpUi.stage.focus({ preventScroll: true }); } catch (_) {} }
}

function cpOnKey(ev) {
  if (!cpSim) return;
  const D = cpSim.cfg.drop;
  if (ev.key === 'ArrowLeft') { cpDropTarget = Math.max(D.minX, cpDropTarget - 1.2); ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { cpDropTarget = Math.min(D.maxX, cpDropTarget + 1.2); ev.preventDefault(); }
  else if (ev.key === ' ' || ev.key === 'Enter') { cpDropPressed(); ev.preventDefault(); }
  else if (ev.key === 'ArrowUp') { cpChangeStake(1); ev.preventDefault(); }
  else if (ev.key === 'ArrowDown') { cpChangeStake(-1); ev.preventDefault(); }
}

function cpOnVisibility() {
  if (activeTab !== 'coinpusher' || !cpSim) return;
  if (document.hidden) { cpFlush(); cpSaveLayout(true); if (cpAudio) try { cpAudio.ctx.suspend(); } catch (_) {} }
  else { cpLastFrame = performance.now(); cpAcc = 0; if (cpAudio && !cpAudioMuted()) try { cpAudio.ctx.resume(); } catch (_) {} }
}

// ── Dropping ──────────────────────────────────────────────────────────────
async function cpDropPressed(fromAuto) {
  cpAudioUnlock();
  if (!cpSim || !cpServer || !cpPlayable()) return false;
  const now = performance.now();
  if (now - cpLastDropAt < CP_CLIENT_COOLDOWN_MS || cpInflight >= 4) return false;
  if (me && Number(me.coins) < cpStake) { toast(CP_TEXT.noFunds); cpStopAuto(); return false; }
  cpLastDropAt = now;
  const x = cpDropX;
  const stake = cpStake;
  const requestId = cpUuid();
  cpInflight++;
  if (cpState === 'READY') cpSetState('DROPPING');
  cpSound('slot');
  cpEmit('drop_pressed', { stake, x: Math.round(x * 10) / 10, auto: !!fromAuto });
  let res = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      res = await cpInvoke('drop', { stake, requestId, lease: cpServer.lease });
    } catch (err) {
      if (err.code === 'network' && attempt === 0) continue;   // same requestId: never a double debit
      cpInflight--;
      cpDropFailed(err);
      return false;
    }
  }
  cpInflight--;
  if (!cpSim || !res) return false;
  cpEmit('drop_authorized', { stake, duplicate: !!res.duplicate });
  cpSetBalance(res.balance);
  if (!res.duplicate) cpSession.staked += stake;
  // Only now — after the server took the stake and issued the coin — does a
  // physical coin exist.
  cpSim.dropCoin(res.coin, x);
  cpEmit('coin_spawned', { kind: res.coin.kind });
  cpMotor(true);
  if (res.coin.kind === 'gold') cpToast(CP_TEXT.gold);
  if (res.coin.kind === 'jackpot') { cpToast(CP_TEXT.jackpotIn); cpSound('bonus'); cpLed(1.4); }
  if (res.rain && res.rain.length) cpRain(res.rain);
  if (cpState === 'DROPPING' || cpState === 'READY') cpSetState('PLAYING');
  cpRenderUi();
  return true;
}

function cpDropFailed(err) {
  cpStopAuto();
  if (err.code === 'lease') {
    cpSetState('ERROR', CP_TEXT.lease);
    cpOverlay('lease', CP_TEXT.lease);
    return;
  }
  if (err.code === 'network') {
    cpSetState('CONNECTION_LOST');
    cpOverlay('lost', CP_TEXT.lost);
    cpEmit('connection_lost', {});
    return;
  }
  toast(err.message);
  if (cpState === 'DROPPING') cpSetState(cpSim && cpSim.motorOn ? 'PLAYING' : 'READY');
}

// A shower of bank-funded coins, released one by one across the rail.
function cpRain(list) {
  cpToast(CP_TEXT.rain);
  cpSound('bonus');
  cpLed(1.1);
  cpSetState('BONUS');
  cpEmit('bonus_triggered', { type: 'rain', coins: list.length });
  const D = cpSim.cfg.drop;
  list.forEach((c, i) => {
    setTimeout(() => {
      if (!cpSim) return;
      cpSim.dropCoin(c, D.minX + Math.random() * (D.maxX - D.minX));
      if (i === list.length - 1 && cpState === 'BONUS') cpSetState('PLAYING');
    }, 90 * i);
  });
}

function cpMotor(on) {
  if (!cpSim) return;
  if (on) cpLastMotorAt = performance.now();
  if (cpSim.motorOn !== on) {
    cpSim.motorOn = on;
    cpSound(on ? 'motorOn' : 'motorOff');
  }
}

function cpToggleAuto() {
  if (cpAuto.left > 0) { cpStopAuto(); return; }
  if (!cpPlayable()) return;
  cpAuto.total = cpAuto.left = Number(cpUi.autoSel.value) || 10;
  cpEmit('auto_drop_started', { drops: cpAuto.total });
  cpAutoTick();
}

async function cpAutoTick() {
  if (cpAuto.left <= 0) return;
  if (!cpPlayable() || activeTab !== 'coinpusher' || (me && Number(me.coins) < cpStake)) { cpStopAuto(); return; }
  const ok = await cpDropPressed(true);
  if (ok) cpAuto.left--;
  if (cpUi) cpUi.autoBtn.textContent = cpAuto.left > 0 ? `${CP_TEXT.autoStop} (${cpAuto.left})` : CP_TEXT.auto;
  if (cpAuto.left > 0) cpAuto.timer = setTimeout(cpAutoTick, cpTurbo ? CP_AUTO_TURBO_MS : CP_AUTO_MS);
  else cpStopAuto();
}

function cpStopAuto() {
  if (cpAuto.timer) clearTimeout(cpAuto.timer);
  if (cpAuto.left > 0) cpEmit('auto_drop_stopped', { left: cpAuto.left });
  cpAuto.left = 0; cpAuto.timer = 0;
  if (cpUi) { cpUi.autoBtn.textContent = CP_TEXT.auto; cpUi.autoBtn.classList.remove('is-on'); }
}

// Turbo never touches physics (the machine's return must not depend on a
// UI toggle): it only speeds up auto-drop and the win count-ups.
function cpToggleTurbo() {
  cpTurbo = !cpTurbo;
  cpSound('click');
  cpRenderUi();
}

// ── Collection ────────────────────────────────────────────────────────────
function cpOnCollect(coin, where) {
  cpPending.push({ id: coin.id, where });
  cpCollectedKind.set(coin.id, coin.kind);
  const t = coin.body.translation();
  cpEmit('coin_collected', { where, kind: coin.kind });
  if (where === 'prize') {
    // The value shown is the one the server issued with this coin.
    cpFloat(t.x, 0, cpSim.cfg.machine.bedFrontZ + 1, '+' + fmtCoins(coin.value), false);
    cpSound('chute', coin.value / Math.max(1, cpStake));
    cpFxBurst(t.x, -0.5, cpSim.cfg.machine.bedFrontZ + 1.5, coin.kind === 'gold' || coin.kind === 'jackpot' ? 18 : 6, 0xffd36b);
  } else {
    cpFloat(t.x, -1, t.z, '−', true);
    cpSound('gutter');
  }
  if (cpPending.length >= 20) cpFlush();
}

async function cpFlush() {
  if (cpFlushing || !cpPending.length || !cpServer) return;
  if (cpState === 'CONNECTION_LOST' || cpState === 'ERROR') return;
  cpFlushing = true;
  const batch = cpPending.slice(0, 100);
  try {
    const res = await cpInvoke('collect', { events: batch, lease: cpServer.lease });
    cpPending = cpPending.slice(batch.length);
    if (res.paid > 0) cpPresentWin(res.paid, batch, res);
    cpSetBalance(res.balance);
    if (cpServer) cpServer.bank = res.bank;
  } catch (err) {
    if (err.code === 'lease') { cpPending = []; cpDropFailed(err); }
    else if (err.code === 'network') cpDropFailed(err);       // keep the queue: collect is idempotent
    else { console.warn('coinpusher collect', err); cpPending = cpPending.slice(batch.length); }
  } finally {
    cpFlushing = false;
  }
}

function cpPresentWin(paid, batch, res) {
  cpSession.won += paid;
  cpSession.lastWin = paid;
  const ids = new Set(res.paidIds || []);
  const jackpot = batch.some(e => ids.has(e.id) && cpCollectedKind.get(e.id) === 'jackpot');
  for (const e of batch) cpCollectedKind.delete(e.id);
  const ratio = paid / Math.max(1, cpStake);
  const tier = jackpot ? 'jackpot' : ratio >= 20 ? 'large' : ratio >= 5 ? 'medium' : 'small';
  cpEmit(jackpot ? 'jackpot_triggered' : 'win', { amount: paid, tier });
  if (tier === 'jackpot') {
    cpBanner(CP_TEXT.jackpot, '+' + fmtCoins(paid) + ' 🪙', 3200);
    cpSound('jackpot'); cpLed(2.4); cpShakeCam(0.5); cpConfetti(); cpSetState('BIG_WIN');
  } else if (tier === 'large') {
    cpBanner(CP_TEXT.bigWin, '+' + fmtCoins(paid) + ' 🪙', 2200);
    cpSound('win', 3); cpLed(1.6); cpShakeCam(0.25); cpSetState('BIG_WIN');
  } else if (tier === 'medium') {
    cpSound('win', 2); cpLed(0.9);
  } else {
    cpSound('win', 1); cpLed(0.35);
  }
  if (tier === 'jackpot' || tier === 'large') {
    clearTimeout(cpWinHold);
    cpWinHold = setTimeout(() => { if (cpState === 'BIG_WIN') cpSetState(cpSim && cpSim.motorOn ? 'PLAYING' : 'READY'); }, tier === 'jackpot' ? 3200 : 2200);
  }
  cpCountUp(cpUi.lastWin, paid, '+');
  cpRenderUi();
  cpRealityCheck();
}

// Kind of each coin between its fall and the server's answer (for the
// jackpot presentation); entries are dropped once the batch is settled.
const cpCollectedKind = new Map();

function cpRealityCheck() {
  const now = Date.now();
  if (now - cpSession.lastCheck < CP_REALITY_CHECK_MS) return;
  cpSession.lastCheck = now;
  const mins = Math.round((now - cpSession.started) / 60000);
  const net = cpSession.won - cpSession.staked;
  toast(`Grasz już ${mins} min. Bilans sesji: ${net > 0 ? '+' : ''}${fmtCoins(net)} 🪙 (wrzucone ${fmtCoins(cpSession.staked)}).`);
}

async function cpSaveLayout(force) {
  if (!cpSim || !cpServer || !cpServer.lease) return;
  if (cpState === 'LOADING' || cpState === 'ERROR' || cpState === 'CONNECTION_LOST') return;
  const layout = cpSim.snapshotLayout();
  const sig = layout.coins.length + ':' + layout.coins.reduce((s, r) => s + r[1] + r[3], 0).toFixed(1);
  if (!force && sig === cpLayoutSig) return;
  cpLayoutSig = sig;
  try { await cpInvoke('save_layout', { layout, lease: cpServer.lease }); } catch (_) { /* cosmetic */ }
}

async function cpLoadFeed() {
  if (!cpUi) return;
  const [lead, recent] = await Promise.all([
    sb.from('coinpusher_week_totals').select('nick,won,staked,prize_coins,jackpots').order('won', { ascending: false }).limit(8),
    sb.from('coinpusher_recent').select('nick,bet,total_won,prize_coins,jackpot_coins,updated_at').limit(10),
  ]);
  if (!cpUi) return;
  const lRows = (lead.data || []).map((r, i) => el('div', { className: 'cp-row' },
    el('span', {}, (i + 1) + '. ' + r.nick + (r.jackpots ? ' 💎' : '')),
    el('span', {}, '+' + fmtCoins(r.won) + ' / ' + fmtCoins(r.staked))));
  cpUi.leaders.replaceChildren(el('h4', {}, '🏆 Ten tydzień · wygrane / wrzucone'),
    ...(lRows.length ? lRows : [el('div', { className: 'cp-note' }, 'Nikt jeszcze nie grał w tym tygodniu.')]));
  const fRows = (recent.data || []).map(r => el('div', { className: 'cp-row' },
    el('span', {}, r.nick + (r.jackpot_coins ? ' 💎' : '')),
    el('span', {}, fmtCoins(r.total_won) + ' z ' + fmtCoins(r.bet) + ' 🪙')));
  cpUi.feed.replaceChildren(el('h4', {}, '🪙 Ostatnie sesje'),
    ...(fRows.length ? fRows : [el('div', { className: 'cp-note' }, 'Brak sesji.')]));
}

// ── View: three.js ────────────────────────────────────────────────────────
function cpPickQuality() {
  const saved = cpStore('quality');
  if (saved && CP_QUALITY[saved]) return saved;
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 700;
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile) return cores >= 8 ? 'MEDIUM' : 'LOW';
  return cores >= 8 ? 'HIGH' : 'MEDIUM';
}

function cpInitView(quality) {
  const T = cpThree;
  cpQualityName = CP_QUALITY[quality] ? quality : cpPickQuality();
  const Q = CP_QUALITY[cpQualityName];
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  cpUi.stage.prepend(canvas);
  const renderer = new T.WebGLRenderer({ canvas, antialias: Q.antialias, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = Q.shadows;
  renderer.shadowMap.type = T.PCFSoftShadowMap;

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(36, 1, 1, 400);
  const pmrem = new T.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(cpEnvScene(T), 0.035).texture;
  scene.fog = new T.Fog(0x050507, 150, 280);   // past the farthest (portrait) camera

  cpView = { T, renderer, scene, camera, canvas, pmrem, Q, meshes: {}, looks: {}, tmp: {
    m: new T.Matrix4(), p: new T.Vector3(), q: new T.Quaternion(), q2: new T.Quaternion(), s: new T.Vector3(1, 1, 1), v: new T.Vector3(),
  }, leds: [], ledLevel: 0, camT: 0, perfSamples: [], adapted: false };

  cpBuildLights();
  cpBuildCabinet();
  cpBuildCoinMeshes();
  cpFx = cpBuildFx();

  cpView.ro = new ResizeObserver(cpResize);
  cpView.ro.observe(cpUi.stage);
  cpResize();
}

// A small light box rendered once into a PMREM: gives metal something warm
// and soft to reflect, like the lit cabinet of a real casino floor.
function cpEnvScene(T) {
  const env = new T.Scene();
  const room = new T.Mesh(new T.BoxGeometry(40, 20, 40), new T.MeshBasicMaterial({ color: 0x0c0a08, side: T.BackSide }));
  room.position.y = 5;
  env.add(room);
  const panel = (w, h, color, k, x, y, z, rx, ry) => {
    const m = new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(k), side: T.DoubleSide });
    const p = new T.Mesh(new T.PlaneGeometry(w, h), m);
    p.position.set(x, y, z); p.rotation.set(rx || 0, ry || 0, 0);
    env.add(p);
  };
  panel(22, 8, 0xfff0d8, 7, 0, 14.5, 0, Math.PI / 2, 0);        // warm softbox overhead
  panel(3, 14, 0xffc27a, 3.2, -19, 6, 0, 0, Math.PI / 2);       // amber side strips
  panel(3, 14, 0xffc27a, 3.2, 19, 6, 0, 0, -Math.PI / 2);
  panel(26, 4, 0xbfd4ff, 1.4, 0, 4, 19.5, 0, Math.PI);           // cool front fill
  panel(26, 3, 0xffd9a0, 1.8, 0, 2, -19.5, 0, 0);
  return env;
}

function cpBuildLights() {
  const { T, scene, Q } = cpView;
  scene.add(new T.HemisphereLight(0xffe8c8, 0x120c06, 0.35));
  const key = new T.SpotLight(0xfff1dc, 2600, 140, 0.62, 0.55, 2);
  key.position.set(4, 52, 26);
  key.target.position.set(0, 0, 0);
  key.castShadow = Q.shadows;
  if (Q.shadows) {
    key.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    key.shadow.bias = -0.00025;
    key.shadow.normalBias = 0.02;
    key.shadow.camera.near = 20; key.shadow.camera.far = 110;
  }
  scene.add(key, key.target);
  const rim = new T.DirectionalLight(0xffb866, 0.5);
  rim.position.set(-20, 18, -30);
  scene.add(rim);
  const chute = new T.PointLight(0xffc24d, 60, 26, 2);
  chute.position.set(0, -3, 14);
  scene.add(chute);
  cpView.chuteLight = chute;
}

// Procedural textures — no image files. A height field is drawn on a canvas
// and turned into a normal map, so a coin face has a real embossed relief.
function cpCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function cpHeightToNormal(src, strength) {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const out = cpCanvas(w, h);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const H = (x, y) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

const CP_LOOK_STYLE = {
  house:   { base: '#b8733f', hi: '#e7a877', label: '1',   metal: 1, rough: 0.42, sub: 'G6' },
  coin5:   { base: '#b9bec6', hi: '#eef1f5', label: '5',   metal: 1, rough: 0.3,  sub: 'G6' },
  coin10:  { base: '#c89a3e', hi: '#f3d587', label: '10',  metal: 1, rough: 0.3,  sub: 'G6' },
  coin25:  { base: '#aeb4bd', hi: '#f0d27a', label: '25',  metal: 1, rough: 0.28, sub: 'G6', core: '#d2a347' },
  coin50:  { base: '#9a5f33', hi: '#e8b37e', label: '50',  metal: 1, rough: 0.28, sub: 'G6', core: '#c98a3d' },
  // The one coin players throw today: a gold core in a silver ring.
  coin100: { base: '#c3c8cf', hi: '#f4f6f8', label: '100', metal: 1, rough: 0.24, sub: 'G6', core: '#e0b04a' },
  gold:    { base: '#e2a92c', hi: '#fff0a8', label: '1000', metal: 1, rough: 0.18, sub: '★ G6 ★', glow: 0x6b4a00 },
  jackpot: { base: '#5b3fbf', hi: '#b9a6ff', label: 'JP',  metal: 0.85, rough: 0.2, sub: 'JACKPOT', glow: 0x2a1470 },
};

function cpFaceTextures(look, size) {
  const T = cpThree;
  const st = CP_LOOK_STYLE[look];
  const hC = cpCanvas(size, size), h = hC.getContext('2d');
  const cC = cpCanvas(size, size), c = cC.getContext('2d');
  const R = size / 2;
  // Height: flat field, raised rim, a ring of beads, raised lettering.
  h.fillStyle = '#6c6c6c'; h.fillRect(0, 0, size, size);
  h.fillStyle = '#e6e6e6'; h.beginPath(); h.arc(R, R, R * 0.98, 0, Math.PI * 2); h.arc(R, R, R * 0.84, 0, Math.PI * 2, true); h.fill();
  h.fillStyle = '#5a5a5a'; h.beginPath(); h.arc(R, R, R * 0.84, 0, Math.PI * 2); h.fill();
  for (let i = 0; i < 36; i++) {
    const a = i / 36 * Math.PI * 2;
    h.fillStyle = '#b8b8b8'; h.beginPath(); h.arc(R + Math.cos(a) * R * 0.76, R + Math.sin(a) * R * 0.76, R * 0.022, 0, Math.PI * 2); h.fill();
  }
  const text = (ctx, color) => {
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const big = st.label.length > 2 ? 0.34 : st.label.length > 1 ? 0.52 : 0.62;
    ctx.font = `900 ${Math.round(size * big * 0.5)}px system-ui, sans-serif`;
    ctx.fillText(st.label, R, R * 0.92);
    ctx.font = `800 ${Math.round(size * (st.sub.length > 3 ? 0.075 : 0.1))}px system-ui, sans-serif`;
    ctx.fillText(st.sub, R, R * 1.48);
  };
  h.shadowColor = '#000'; h.shadowBlur = size * 0.012;
  text(h, '#f2f2f2');
  // Colour: the same shapes, lit a touch lighter where raised.
  const g = c.createRadialGradient(R * 0.7, R * 0.6, R * 0.1, R, R, R);
  g.addColorStop(0, st.hi); g.addColorStop(1, st.base);
  c.fillStyle = st.base; c.fillRect(0, 0, size, size);
  c.fillStyle = g; c.beginPath(); c.arc(R, R, R, 0, Math.PI * 2); c.fill();
  if (st.core) { c.fillStyle = st.core; c.beginPath(); c.arc(R, R, R * 0.62, 0, Math.PI * 2); c.fill(); }
  c.globalAlpha = 0.55; text(c, st.hi); c.globalAlpha = 1;
  // Roughness: mostly smooth with fine scratches and worn edges.
  const rC = cpCanvas(size, size), r = rC.getContext('2d');
  const base = Math.round(st.rough * 255);
  r.fillStyle = `rgb(${base},${base},${base})`; r.fillRect(0, 0, size, size);
  r.strokeStyle = `rgba(255,255,255,0.18)`; r.lineWidth = 1;
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * size, y = Math.random() * size, a = Math.random() * Math.PI, l = size * (0.05 + Math.random() * 0.25);
    r.beginPath(); r.moveTo(x, y); r.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); r.stroke();
  }
  r.strokeStyle = 'rgba(0,0,0,0.25)'; r.lineWidth = size * 0.03; r.beginPath(); r.arc(R, R, R * 0.93, 0, Math.PI * 2); r.stroke();
  const map = new T.CanvasTexture(cC); map.colorSpace = T.SRGBColorSpace;
  const normalMap = new T.CanvasTexture(cpHeightToNormal(hC, 3.2));
  const roughnessMap = new T.CanvasTexture(rC);
  for (const t of [map, normalMap, roughnessMap]) { t.anisotropy = 4; }
  return { map, normalMap, roughnessMap };
}

function cpEdgeNormal() {
  // Reeded edge: fine vertical ridges around the rim.
  const hC = cpCanvas(128, 16), h = hC.getContext('2d');
  for (let x = 0; x < 128; x++) { const v = 128 + 110 * Math.sin(x / 128 * Math.PI * 2 * 16); h.fillStyle = `rgb(${v},${v},${v})`; h.fillRect(x, 0, 1, 16); }
  const t = new cpThree.CanvasTexture(cpHeightToNormal(hC, 2));
  t.wrapS = t.wrapT = cpThree.RepeatWrapping; t.repeat.set(6, 1);
  return t;
}

function cpBuildCoinMeshes() {
  const { T, scene, Q } = cpView;
  const edge = cpEdgeNormal();
  const shapes = cpSim.cfg.shapes;
  const cap = (cpServer.maxInMachine || 320) + 40;
  for (const look of CP_LOOKS) {
    const shape = look === 'jackpot' ? shapes.jackpot : shapes.coin;
    const geo = new T.CylinderGeometry(shape.r, shape.r, shape.h, look === 'jackpot' ? 48 : 36, 1, false);
    const st = CP_LOOK_STYLE[look];
    const tex = cpFaceTextures(look, Q.tex);
    const face = new T.MeshStandardMaterial({ color: 0xffffff, metalness: st.metal, roughness: 1, ...tex, envMapIntensity: 1.15 });
    face.normalScale.set(1.1, 1.1);
    const side = new T.MeshStandardMaterial({ color: new T.Color(st.base).lerp(new T.Color(st.hi), 0.35), metalness: st.metal,
      roughness: st.rough + 0.08, normalMap: edge, envMapIntensity: 1.1 });
    if (st.glow) { face.emissive = new T.Color(st.glow); face.emissiveIntensity = 0.55; side.emissive = new T.Color(st.glow); side.emissiveIntensity = 0.4; }
    const mesh = new T.InstancedMesh(geo, [side, face, face], cap);
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    mesh.castShadow = Q.shadows; mesh.receiveShadow = Q.shadows;
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene.add(mesh);
    cpView.meshes[look] = mesh;
  }
}

function cpBrushed(w, h, tint, lines) {
  const c = cpCanvas(w, h), x = c.getContext('2d');
  x.fillStyle = tint; x.fillRect(0, 0, w, h);
  for (let i = 0; i < lines; i++) {
    const y = Math.random() * h;
    x.strokeStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
    x.beginPath(); x.moveTo(0, y); x.lineTo(w, y + (Math.random() - 0.5) * 2); x.stroke();
  }
  const t = new cpThree.CanvasTexture(c);
  t.wrapS = t.wrapT = cpThree.RepeatWrapping;
  return t;
}

function cpMarquee(text) {
  const c = cpCanvas(1024, 160), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 160);
  g.addColorStop(0, '#1b1208'); g.addColorStop(1, '#060403');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 160);
  for (let i = 0; i < 34; i++) {
    x.fillStyle = i % 2 ? '#ffcf6b' : '#fff3cf';
    x.beginPath(); x.arc(16 + i * 29.5, 12, 5, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.arc(16 + i * 29.5, 148, 5, 0, Math.PI * 2); x.fill();
  }
  x.font = '900 78px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = '#ffae2e'; x.shadowBlur = 22;
  const tg = x.createLinearGradient(0, 40, 0, 120); tg.addColorStop(0, '#fff6d6'); tg.addColorStop(1, '#f0a92f');
  x.fillStyle = tg; x.fillText(text, 512, 84);
  const t = new cpThree.CanvasTexture(c); t.colorSpace = cpThree.SRGBColorSpace;
  return t;
}

function cpBuildCabinet() {
  const { T, scene, Q } = cpView;
  const M = cpSim.cfg.machine, P = cpSim.cfg.pusher;
  const steel = new T.MeshStandardMaterial({ color: 0x3a3833, metalness: 0.9, roughness: 0.38, map: cpBrushed(256, 256, '#77726a', 260) });
  const darkSteel = new T.MeshStandardMaterial({ color: 0x1b1a18, metalness: 0.85, roughness: 0.45 });
  const lacquer = new T.MeshStandardMaterial({ color: 0x0b0a09, metalness: 0.3, roughness: 0.25 });
  const gold = new T.MeshStandardMaterial({ color: 0xd6a142, metalness: 1, roughness: 0.22 });
  const glass = new T.MeshStandardMaterial({ color: 0xbfd6ff, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.09, depthWrite: false });
  const hole = new T.MeshStandardMaterial({ color: 0x050404, roughness: 0.9, metalness: 0.2 });
  const box = (w, h, d, mat, x, y, z, shadow) => {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (shadow !== false) { m.castShadow = Q.shadows; m.receiveShadow = Q.shadows; }
    scene.add(m);
    return m;
  };
  // Collider-backed parts, drawn from the physics statics so the picture can
  // never disagree with what the coins actually hit.
  for (const s of cpSim.statics) {
    if (s.name === 'catch') continue;
    const mat = s.name === 'bed' ? steel : s.glass ? glass : s.name.startsWith('sep') ? gold : s.name === 'wiper' ? lacquer : darkSteel;
    box(s.hx * 2, s.hy * 2, s.hz * 2, mat, s.x, s.y, s.z, !s.glass);
  }
  // Wiper face: the lit marquee.
  const marquee = new T.Mesh(new T.PlaneGeometry(M.halfWidth * 2 - 0.4, 4.6),
    new T.MeshStandardMaterial({ map: cpMarquee('AUTOMAT MONET G6'), emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 0.0, roughness: 0.4 }));
  marquee.material.emissiveMap = marquee.material.map; marquee.material.emissiveIntensity = 0.9;
  marquee.position.set(0, P.height + 5.2, P.wiperZ + 0.02);
  scene.add(marquee);
  cpView.marquee = marquee;

  // The pusher block: chrome sides, a dark playfield top with a gold edge.
  const ps = cpSim.pusherShape;
  const pusher = new T.Group();
  const body = new T.Mesh(new T.BoxGeometry(ps.hx * 2, ps.hy * 2, ps.hz * 2),
    new T.MeshStandardMaterial({ color: 0xd7d9dc, metalness: 1, roughness: 0.14 }));
  body.castShadow = Q.shadows; body.receiveShadow = Q.shadows;
  const top = new T.Mesh(new T.PlaneGeometry(ps.hx * 2, ps.hz * 2),
    new T.MeshStandardMaterial({ color: 0x2a0f10, metalness: 0.2, roughness: 0.55, map: cpBrushed(128, 128, '#5a2226', 90) }));
  top.rotation.x = -Math.PI / 2; top.position.y = ps.hy + 0.005; top.receiveShadow = Q.shadows;
  const lip = new T.Mesh(new T.BoxGeometry(ps.hx * 2, 0.25, 0.25), gold);
  lip.position.set(0, ps.hy - 0.1, ps.hz - 0.1);
  pusher.add(body, top, lip);
  pusher.position.set(0, P.height / 2, ps.z0);
  scene.add(pusher);
  cpView.pusher = pusher;

  // Prize edge: a gold nosing and an LED strip that glows into the chute.
  box(M.halfWidth * 2, 0.5, 0.5, gold, 0, -0.25, M.bedFrontZ - 0.25);
  const ledMat = new T.MeshStandardMaterial({ color: 0x331f00, emissive: 0xffb43a, emissiveIntensity: 1.2 });
  const led = box(M.halfWidth * 2, 0.18, 0.18, ledMat, 0, -0.75, M.bedFrontZ + 0.05, false);
  cpView.leds.push(ledMat);
  // Gutter lanes: dark wells with a warning stripe.
  for (const s of [-1, 1]) {
    const wx = s * (M.halfWidth + M.gutterWidth / 2);
    box(M.gutterWidth, 0.1, M.bedFrontZ - M.gutterStartZ, hole, wx, -6, (M.bedFrontZ + M.gutterStartZ) / 2, false);
    const stripe = new T.MeshStandardMaterial({ color: 0x220000, emissive: 0xff3b2f, emissiveIntensity: 0.5 });
    box(0.12, 0.12, M.bedFrontZ - M.gutterStartZ, stripe, s * (M.halfWidth + 0.08), 0.02, (M.bedFrontZ + M.gutterStartZ) / 2, false);
    cpView.leds.push(stripe);
    // Cabinet pillars.
    box(2.2, 46, 3, lacquer, s * (M.halfWidth + M.gutterWidth + 2.1), 10, M.bedFrontZ + M.chuteDepth + 1);
    box(0.25, 46, 0.25, gold, s * (M.halfWidth + M.gutterWidth + 0.95), 10, M.bedFrontZ + M.chuteDepth + 2.55, false);
    const pillarLed = new T.MeshStandardMaterial({ color: 0x331f00, emissive: 0xffc15a, emissiveIntensity: 0.9 });
    box(0.3, 30, 0.3, pillarLed, s * (M.halfWidth + M.gutterWidth + 1.2), 12, M.bedFrontZ + M.chuteDepth - 0.2, false);
    cpView.leds.push(pillarLed);
  }
  // Prize chute mouth: a glowing slot below the edge.
  const mouthMat = new T.MeshStandardMaterial({ color: 0x100a02, emissive: 0xffa928, emissiveIntensity: 0.35 });
  box((M.halfWidth + M.gutterWidth) * 2, 0.1, M.chuteDepth - 0.3, mouthMat, 0, -9, M.bedFrontZ + M.chuteDepth / 2, false);
  cpView.leds.push(mouthMat);
  // Base and nameplate in front of the glass.
  box((M.halfWidth + M.gutterWidth + 3.4) * 2, 14, 6, lacquer, 0, -8, M.bedFrontZ + M.chuteDepth + 3.6);
  box((M.halfWidth + M.gutterWidth + 3.4) * 2, 0.3, 0.3, gold, 0, -1.1, M.bedFrontZ + M.chuteDepth + 6.65, false);
  // Roof canopy with the drop rail.
  box((M.halfWidth + M.gutterWidth + 3.4) * 2, 2, 12, lacquer, 0, cpSim.cfg.drop.y + 5, cpSim.cfg.drop.z - 1);
  const rail = box(M.halfWidth * 2, 0.35, 0.6, gold, 0, cpSim.cfg.drop.y + 3.2, cpSim.cfg.drop.z, false);
  rail.castShadow = false;
  // The coin carriage that rides the rail, with a ghost coin under it.
  const carriage = new T.Group();
  const cb = new T.Mesh(new T.BoxGeometry(3.4, 1.6, 2), gold);
  cb.position.y = cpSim.cfg.drop.y + 2.2;
  const slot = new T.Mesh(new T.BoxGeometry(2.8, 0.2, 0.5), hole);
  slot.position.y = cpSim.cfg.drop.y + 1.35;
  const ghostMat = new T.MeshStandardMaterial({ color: 0xffe39a, metalness: 1, roughness: 0.3, transparent: true, opacity: 0.55 });
  const ghost = new T.Mesh(new T.CylinderGeometry(1.3, 1.3, 0.3, 32), ghostMat);
  ghost.rotation.x = Math.PI / 2; ghost.position.y = cpSim.cfg.drop.y + 0.2;
  const beamMat = new T.MeshBasicMaterial({ color: 0xffd56b, transparent: true, opacity: 0.08, depthWrite: false });
  const beam = new T.Mesh(new T.CylinderGeometry(0.05, 0.9, cpSim.cfg.drop.y - P.height, 16, 1, true), beamMat);
  beam.position.y = (cpSim.cfg.drop.y + P.height) / 2;
  carriage.add(cb, slot, ghost, beam);
  carriage.position.z = cpSim.cfg.drop.z;
  scene.add(carriage);
  cpView.carriage = carriage; cpView.ghost = ghost; cpView.beam = beam;
  // Floor under everything for contact shadows.
  const floor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.ShadowMaterial({ opacity: 0.35 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -15; floor.receiveShadow = Q.shadows;
  scene.add(floor);
}

// ── Effects: sparks, confetti, floating numbers ───────────────────────────
function cpBuildFx() {
  const { T, scene, Q } = cpView;
  const mk = (n, size, additive) => {
    const geo = new T.BufferGeometry();
    const pos = new Float32Array(n * 3).fill(-999);
    const col = new Float32Array(n * 3);
    geo.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('color', new T.BufferAttribute(col, 3).setUsage(T.DynamicDrawUsage));
    const mat = new T.PointsMaterial({ size, vertexColors: true, transparent: true, depthWrite: false,
      blending: additive ? T.AdditiveBlending : T.NormalBlending, sizeAttenuation: true });
    const pts = new T.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    return { pts, pos, col, vel: new Float32Array(n * 3), life: new Float32Array(n), n, next: 0 };
  };
  return { sparks: mk(Q.sparks, 0.35, true), confetti: mk(Q.confetti, 0.6, false), lastSpark: 0 };
}

function cpEmitParticles(sys, x, y, z, count, color, speed, up) {
  if (!sys) return;
  const c = new cpThree.Color(color);
  for (let k = 0; k < count; k++) {
    const i = sys.next; sys.next = (sys.next + 1) % sys.n;
    sys.pos[i * 3] = x; sys.pos[i * 3 + 1] = y; sys.pos[i * 3 + 2] = z;
    const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
    sys.vel[i * 3] = Math.cos(a) * s; sys.vel[i * 3 + 1] = up * (0.5 + Math.random()); sys.vel[i * 3 + 2] = Math.sin(a) * s;
    sys.life[i] = 1;
    const j = 0.75 + Math.random() * 0.25;
    sys.col[i * 3] = c.r * j; sys.col[i * 3 + 1] = c.g * j; sys.col[i * 3 + 2] = c.b * j;
  }
}

function cpFxBurst(x, y, z, n, color) {
  if (!cpFx) return;
  cpEmitParticles(cpFx.sparks, x, y, z, n, color, 14, 18);
}

function cpConfetti() {
  if (!cpFx || cpReducedMotion) return;
  const palette = [0xffd36b, 0xff6b6b, 0x6bd1ff, 0xb9ff6b, 0xffffff];
  for (let i = 0; i < 6; i++) cpEmitParticles(cpFx.confetti, (Math.random() - 0.5) * 30, 22, (Math.random() - 0.5) * 20, 40, palette[i % 5], 10, 6);
}

function cpStepParticles(sys, dt, gravity, drag) {
  let live = false;
  for (let i = 0; i < sys.n; i++) {
    if (sys.life[i] <= 0) continue;
    live = true;
    sys.life[i] -= dt * (gravity < -30 ? 1.6 : 0.35);
    if (sys.life[i] <= 0) { sys.pos[i * 3 + 1] = -999; continue; }
    sys.vel[i * 3 + 1] += gravity * dt;
    sys.vel[i * 3] *= drag; sys.vel[i * 3 + 2] *= drag;
    sys.pos[i * 3] += sys.vel[i * 3] * dt; sys.pos[i * 3 + 1] += sys.vel[i * 3 + 1] * dt; sys.pos[i * 3 + 2] += sys.vel[i * 3 + 2] * dt;
  }
  if (live) { sys.pts.geometry.attributes.position.needsUpdate = true; sys.pts.geometry.attributes.color.needsUpdate = true; }
}

function cpProject(x, y, z) {
  const { T, camera, canvas } = cpView;
  const v = cpView.tmp.v.set(x, y, z).project(camera);
  const r = canvas.getBoundingClientRect();
  return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height };
}

function cpFloat(x, y, z, text, gutter) {
  if (!cpUi || !cpView) return;
  const node = el('div', { className: 'cp-float' + (gutter ? ' is-gutter' : '') }, text);
  cpUi.stage.append(node);
  const p = cpProject(x, y, z);
  const t0 = performance.now();
  const dur = cpReducedMotion ? 700 : 1100;
  const tick = () => {
    const k = (performance.now() - t0) / dur;
    if (k >= 1 || !node.isConnected) { node.remove(); return; }
    node.style.transform = `translate(${p.x - 14}px, ${p.y - 20 - k * (cpReducedMotion ? 0 : 46)}px)`;
    node.style.opacity = String(1 - k * k);
    requestAnimationFrame(tick);
  };
  tick();
  // Cap the number of live floaters.
  const all = cpUi.stage.querySelectorAll('.cp-float');
  if (all.length > 14) all[0].remove();
}

function cpBanner(title, sub, ms) {
  if (!cpUi) return;
  cpUi.banner.replaceChildren(document.createTextNode(title), el('small', {}, sub));
  cpUi.banner.classList.add('is-on');
  clearTimeout(cpTimers.banner);
  cpTimers.banner = setTimeout(() => cpUi && cpUi.banner.classList.remove('is-on'), ms);
}

function cpToast(msg) { toast(msg); }

function cpCountUp(node, value, prefix) {
  if (!node) return;
  const dur = cpTurbo ? 350 : 900;
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    node.textContent = (prefix || '') + fmtCoins(Math.round(value * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(tick);
  };
  tick();
}

function cpLed(level) { if (cpView) cpView.ledLevel = Math.max(cpView.ledLevel, level); }
function cpShakeCam(a) { if (!cpReducedMotion) cpShake = Math.max(cpShake, a); }

// ── Audio (synthesised, pooled, throttled) ────────────────────────────────
function cpAudioMuted() { return !!cpStore('muted'); }

function cpAudioUnlock() {
  if (cpAudio || cpAudioMuted()) { if (cpAudio && cpAudio.ctx.state === 'suspended' && !cpAudioMuted()) cpAudio.ctx.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const master = ctx.createGain();
  master.gain.value = Number(cpStore('volume') ?? 0.7) * 0.8;
  master.connect(ctx.destination);
  // One shared noise buffer; every voice is a short-lived node graph.
  const noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // Motor hum: always running, gain follows the pusher.
  const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 52;
  const humF = ctx.createBiquadFilter(); humF.type = 'lowpass'; humF.frequency.value = 170;
  const humG = ctx.createGain(); humG.gain.value = 0;
  hum.connect(humF).connect(humG).connect(master); hum.start();
  cpAudio = { ctx, master, noise, humG, hum, voices: 0, lastClink: 0, clinksThisFrame: 0 };
}

function cpVoice(dur) {
  if (!cpAudio || cpAudio.voices > 14) return null;
  cpAudio.voices++;
  setTimeout(() => { if (cpAudio) cpAudio.voices--; }, dur * 1000 + 50);
  return cpAudio.ctx;
}

function cpPan(ctx, x) {
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (p) p.pan.value = Math.max(-1, Math.min(1, x / 18));
  return p;
}

function cpClink(strength, x) {
  const ctx = cpVoice(0.35); if (!ctx) return;
  const t = ctx.currentTime;
  const out = ctx.createGain();
  const vol = Math.min(0.22, 0.02 + strength * 0.0016);
  out.gain.setValueAtTime(vol, t); out.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  const pan = cpPan(ctx, x);
  if (pan) { out.connect(pan); pan.connect(cpAudio.master); } else out.connect(cpAudio.master);
  const f0 = 2300 + Math.random() * 1800;
  for (const [ratio, g] of [[1, 1], [2.76, 0.5], [5.4, 0.25]]) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f0 * ratio;
    const og = ctx.createGain(); og.gain.value = g;
    o.connect(og).connect(out); o.start(t); o.stop(t + 0.3);
  }
}

function cpNoiseHit(t, dur, freq, q, vol, type) {
  const ctx = cpAudio.ctx;
  const src = ctx.createBufferSource(); src.buffer = cpAudio.noise;
  const f = ctx.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(cpAudio.master); src.start(t); src.stop(t + dur + 0.02);
}

function cpTone(t, freq, dur, vol, type) {
  const ctx = cpAudio.ctx;
  const o = ctx.createOscillator(); o.type = type || 'triangle'; o.frequency.value = freq;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(cpAudio.master); o.start(t); o.stop(t + dur + 0.05);
}

function cpSound(kind, arg) {
  if (!cpAudio || cpAudioMuted() || cpAudio.ctx.state !== 'running') return;
  if (!cpVoice(0.5)) return;
  const t = cpAudio.ctx.currentTime;
  switch (kind) {
    case 'click': cpTone(t, 1800, 0.04, 0.05, 'square'); break;
    case 'slot': cpNoiseHit(t, 0.18, 3200, 2, 0.08); cpNoiseHit(t + 0.08, 0.12, 5200, 4, 0.05); break;
    case 'chute': {
      const n = Math.min(5, 2 + Math.floor(arg || 1));
      for (let i = 0; i < n; i++) cpNoiseHit(t + i * 0.045, 0.09, 4200 + Math.random() * 2000, 6, 0.06);
      cpTone(t + 0.02, 1320, 0.25, 0.05); break;
    }
    case 'gutter': cpNoiseHit(t, 0.22, 380, 1.2, 0.07, 'lowpass'); break;
    case 'motorOn': cpNoiseHit(t, 0.12, 900, 3, 0.05); break;
    case 'motorOff': cpNoiseHit(t, 0.2, 500, 2, 0.06); break;
    case 'clack': cpNoiseHit(t, 0.07, 1400, 5, 0.035); break;
    case 'win': {
      const notes = [784, 988, 1175, 1568].slice(0, 1 + (arg || 1));
      notes.forEach((f, i) => cpTone(t + i * 0.08, f, 0.35, 0.07)); break;
    }
    case 'bonus': [659, 880, 1109, 1319].forEach((f, i) => cpTone(t + i * 0.06, f, 0.3, 0.06, 'square')); break;
    case 'jackpot': {
      [523, 659, 784, 1047, 1319, 1568, 2093].forEach((f, i) => cpTone(t + i * 0.09, f, 0.6, 0.08));
      cpTone(t + 0.7, 1047, 1.4, 0.07, 'sawtooth'); break;
    }
  }
}

function cpOnImpact(coin, dv) {
  if (!cpAudio || cpAudioMuted()) return;
  // Hundreds of coins touch every frame; only the hardest few are heard.
  const now = performance.now();
  if (now - cpAudio.lastClink < 28 || cpAudio.clinksThisFrame >= 2) return;
  cpAudio.lastClink = now;
  cpAudio.clinksThisFrame++;
  const t = coin.body.translation();
  cpClink(dv, t.x);
  if (dv > 140 && cpFx && now - cpFx.lastSpark > 60) { cpFx.lastSpark = now; cpFxBurst(t.x, t.y, t.z, 3, 0xfff1c0); }
}

function cpToggleSound() {
  const muted = !cpAudioMuted();
  cpStore('muted', muted);
  if (muted && cpAudio) cpAudio.ctx.suspend();
  if (!muted) { cpAudioUnlock(); if (cpAudio) cpAudio.ctx.resume(); }
  cpRenderUi();
}

// ── Camera, quality, fullscreen, help ─────────────────────────────────────
function cpCycleCamera() {
  const keys = Object.keys(CP_CAMERAS);
  cpCameraMode = keys[(keys.indexOf(cpCameraMode) + 1) % keys.length];
  cpSound('click');
  toast('Kamera: ' + cpCameraMode);
}

function cpCycleQuality() {
  const keys = Object.keys(CP_QUALITY);
  const next = keys[(keys.indexOf(cpQualityName) + 1) % keys.length];
  cpStore('quality', next);
  toast('Jakość: ' + next + ' — przeładowuję scenę…');
  cpRebuildView();
}

function cpRebuildView(quality) {
  if (!cpView) return;
  try { cpView.renderer.dispose(); cpView.ro && cpView.ro.disconnect(); } catch (_) {}
  cpView.canvas.remove();
  cpView = null;
  cpInitView(quality);
  cpView.adapted = true;
  cpRenderUi();
}

// Full-page mode: the stage becomes a fixed layer over the whole window. Page
// scrolling is locked while it is up, and released whenever the tab is left.
function cpSetPageMode(on) {
  cpPageMode = !!on;
  cpApplyPageMode(cpPageMode);
  cpSound('click');
}

function cpApplyPageMode(on) {
  if (!cpUi) return;
  cpUi.stage.classList.toggle('is-page', !!on);
  document.documentElement.classList.toggle('cp-page-lock', !!on);
  cpUi.page.textContent = on ? '✕' : '⤢';
  cpUi.page.title = on ? 'Wyjdź z trybu pełnej strony (Esc)' : 'Graj na całej stronie';
  cpUi.page.setAttribute('aria-label', cpUi.page.title);
  requestAnimationFrame(cpResize);
}

function cpOnPageKey(ev) {
  if (ev.key !== 'Escape' || activeTab !== 'coinpusher' || !cpPageMode || document.fullscreenElement) return;
  if (cpUi && cpUi.helpBox) return;             // Esc closes nothing else here
  cpSetPageMode(false);
}

function cpToggleFullscreen() {
  const st = cpUi.stage;
  if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); return; }
  if (st.requestFullscreen) st.requestFullscreen().catch(() => st.classList.toggle('is-full'));
  else st.classList.toggle('is-full');
}

function cpToggleHelp() {
  if (cpUi.helpBox) { cpUi.helpBox.remove(); cpUi.helpBox = null; return; }
  const vol = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(cpStore('volume') ?? 0.7),
    'aria-label': 'Głośność', oninput: e => { cpStore('volume', Number(e.target.value)); if (cpAudio) cpAudio.master.gain.value = Number(e.target.value) * 0.8; } });
  const rm = el('input', { type: 'checkbox', checked: cpReducedMotion,
    onchange: e => { cpReducedMotion = e.target.checked; cpStore('reducedMotion', cpReducedMotion); } });
  const box = el('div', { className: 'cp-help', role: 'dialog', 'aria-label': 'Pomoc' },
    el('div', {}, CP_TEXT.help),
    el('label', {}, '🔊 Głośność', vol),
    el('label', {}, rm, 'Ogranicz ruch (bez drgań kamery i konfetti)'),
    el('div', { className: 'cp-note' }, 'Skróty: ←/→ zrzut, spacja wrzut, ↑/↓ stawka.'));
  cpUi.stage.append(box);
  cpUi.helpBox = box;
  if (cpDebugAllowed()) cpToggleDebug();
}

function cpResize() {
  if (!cpView || !cpUi) return;
  const r = cpUi.stage.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return;
  const Q = cpView.Q;
  cpView.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio));
  cpView.renderer.setSize(r.width, r.height, false);
  cpView.camera.aspect = r.width / r.height;
  cpView.camera.updateProjectionMatrix();
}

// Portrait screens get a camera pulled back far enough that the full width of
// the machine fits, rather than a shrunk desktop view.
function cpUpdateCamera(dt) {
  const { camera } = cpView;
  const c = CP_CAMERAS[cpCameraMode];
  const aspect = camera.aspect || 1;
  const fit = aspect < 1.2 ? Math.min(2.5, 1.25 / aspect) : 1;
  if (!cpView.camPlaced) {
    // First frame: start where the shot is, not flying in from the origin.
    cpView.camPlaced = true;
    camera.position.set(c.pos[0], c.pos[1] * fit, c.pos[2] * fit);
  }
  cpView.camT += dt;
  let sway = 0;
  if (!cpReducedMotion) sway = cpCameraMode === 'CINEMATIC' ? Math.sin(cpView.camT * 0.18) * 9 : Math.sin(cpView.camT * 0.25) * 0.6;
  const tx = c.pos[0] + sway, ty = c.pos[1] * fit, tz = c.pos[2] * fit;
  const k = 1 - Math.pow(0.001, dt);
  camera.position.x += (tx - camera.position.x) * k;
  camera.position.y += (ty - camera.position.y) * k;
  camera.position.z += (tz - camera.position.z) * k;
  if (camera.fov !== c.fov) { camera.fov += (c.fov - camera.fov) * k; camera.updateProjectionMatrix(); }
  let sx = 0, sy = 0;
  if (cpShake > 0.001) { sx = (Math.random() - 0.5) * cpShake; sy = (Math.random() - 0.5) * cpShake; cpShake *= Math.pow(0.02, dt); }
  // Portrait: aim a little lower so the prize edge clears the touch controls.
  const lift = aspect < 1 ? -2.5 * Math.min(1, (1 - aspect) * 2) : 0;
  camera.lookAt(c.look[0] + sx, c.look[1] + lift + sy, c.look[2]);
}

// ── Frame loop: fixed-step physics, interpolated rendering ────────────────
function cpFrame(now) {
  cpRaf = requestAnimationFrame(cpFrame);
  if (!cpSim || !cpView || activeTab !== 'coinpusher') return;
  if (document.hidden) { cpLastFrame = now; return; }
  const PH = cpSim.cfg.physics;
  let dt = (now - cpLastFrame) / 1000;
  cpLastFrame = now;
  if (dt > 0.25) dt = 0.25;
  cpAcc += dt;
  if (cpAudio) cpAudio.clinksThisFrame = 0;

  // Motor: park after a minute without a coin (the server stops accepting
  // prizes soon after — see MOTOR_IDLE_S in coinpusher-action).
  const idleMs = ((cpServer && cpServer.motorIdleS) || 60) * 1000;
  if (cpSim.motorOn && performance.now() - cpLastMotorAt > idleMs && cpAuto.left <= 0) {
    cpMotor(false);
    if (cpState === 'PLAYING') cpSetState('READY');
  }

  const t0 = performance.now();
  let steps = 0;
  while (cpAcc >= PH.dt && steps < PH.maxStepsPerFrame) {
    cpPusherPrev = cpSim.pusherOffset;
    const phaseBefore = cpCore.cpPusherPhase(cpSim.cfg.pusher, cpSim.time);
    cpSim.step();
    const phaseAfter = cpCore.cpPusherPhase(cpSim.cfg.pusher, cpSim.time);
    if (phaseBefore !== phaseAfter && (phaseAfter === 'pause-front' || phaseAfter === 'pause-back') && cpSim.motorOn) cpSound('clack');
    cpAcc -= PH.dt;
    steps++;
  }
  // A device that can't keep up runs the machine in slow motion instead of
  // taking bigger (less accurate) steps.
  if (cpAcc > PH.dt * PH.maxStepsPerFrame) cpAcc = PH.dt;
  const physMs = performance.now() - t0;
  const alpha = cpAcc / PH.dt;

  cpDropX += (cpDropTarget - cpDropX) * Math.min(1, dt * 14);
  cpSyncScene(alpha, dt);
  cpUpdateCamera(dt);
  cpView.renderer.render(cpView.scene, cpView.camera);

  if (cpAudio) {
    const moving = cpSim.motorOn ? 0.03 + Math.abs(cpSim.pusherOffset - cpPusherPrev) * 0.4 : 0;
    cpAudio.humG.gain.setTargetAtTime(cpAudioMuted() ? 0 : Math.min(0.06, moving), cpAudio.ctx.currentTime, 0.08);
  }
  cpAdaptQuality(dt);
  if (cpDebug) cpDebugUpdate(dt, physMs, steps);
}

function cpSyncScene(alpha, dt) {
  const { meshes, tmp, pusher } = cpView;
  const counts = {};
  for (const look of CP_LOOKS) counts[look] = 0;
  for (const coin of cpSim.coins.values()) {
    const mesh = meshes[coin.look] || meshes.coin10;
    const b = coin.body;
    const t = b.translation(), q = b.rotation();
    if (b.isSleeping() || !coin.prev) {
      tmp.p.set(t.x, t.y, t.z); tmp.q.set(q.x, q.y, q.z, q.w);
    } else {
      const p = coin.prev;
      tmp.p.set(p.x + (t.x - p.x) * alpha, p.y + (t.y - p.y) * alpha, p.z + (t.z - p.z) * alpha);
      tmp.q2.set(p.q.x, p.q.y, p.q.z, p.q.w);
      tmp.q.set(q.x, q.y, q.z, q.w);
      tmp.q2.slerp(tmp.q, alpha); tmp.q.copy(tmp.q2);
    }
    tmp.m.compose(tmp.p, tmp.q, tmp.s);
    const i = counts[coin.look]++;
    if (i < mesh.instanceMatrix.count) mesh.setMatrixAt(i, tmp.m);
  }
  for (const look of CP_LOOKS) {
    const m = meshes[look];
    m.count = Math.min(counts[look], m.instanceMatrix.count);
    m.instanceMatrix.needsUpdate = true;
  }
  const off = cpPusherPrev + (cpSim.pusherOffset - cpPusherPrev) * alpha;
  pusher.position.z = cpSim.pusherShape.z0 + off;
  cpView.carriage.position.x = cpDropX;
  const ready = cpPlayable() && performance.now() - cpLastDropAt > CP_CLIENT_COOLDOWN_MS;
  cpView.ghost.visible = ready;
  cpView.beam.visible = ready;
  // LEDs: a slow idle breathing plus whatever a win pushed in.
  cpView.ledLevel *= Math.pow(0.35, dt);
  const breathe = 0.85 + 0.15 * Math.sin(performance.now() / 900);
  const level = breathe + cpView.ledLevel * (0.6 + 0.4 * Math.sin(performance.now() / 70));
  for (const m of cpView.leds) m.emissiveIntensity = (m.userData.base ?? (m.userData.base = m.emissiveIntensity)) * level;
  cpView.chuteLight.intensity = 60 * level;
  if (cpView.marquee) cpView.marquee.material.emissiveIntensity = 0.75 + cpView.ledLevel * 0.5;
  if (cpFx) {
    cpStepParticles(cpFx.sparks, dt, -60, 0.96);
    cpStepParticles(cpFx.confetti, dt, -9, 0.99);
  }
}

// Adaptive graphics: if the first seconds run slow, step quality down once.
// Only when the player hasn't picked a quality themselves. Physics is never
// touched — only pixels, shadows and particle counts.
function cpAdaptQuality(dt) {
  const v = cpView;
  if (v.adapted || cpStore('quality')) return;
  v.perfSamples.push(dt);
  if (v.perfSamples.length < 180) return;
  v.adapted = true;
  const avg = v.perfSamples.reduce((a, b) => a + b, 0) / v.perfSamples.length;
  const keys = Object.keys(CP_QUALITY);
  const i = keys.indexOf(cpQualityName);
  if (avg > 1 / 38 && i > 0) cpRebuildView(keys[i - 1]);
}

// ── Developer debug overlay + tuning panel (admins or ?cpdebug) ───────────
function cpDebugAllowed() {
  return (typeof isAdmin === 'function' && isAdmin()) || /[?&]cpdebug\b/.test(location.search);
}

function cpToggleDebug() {
  if (!cpDebugAllowed() || !cpUi) return;
  if (cpDebug) { cpDebug.box.remove(); cpDebug.helpers.forEach(h => cpView && cpView.scene.remove(h)); cpDebug = null; return; }
  const out = el('pre', { style: { margin: 0 } }, '');
  const box = el('div', { className: 'cp-debug' }, el('b', {}, 'DEBUG'), out);
  const helpers = [];
  const toggles = { volumes: false, colliders: false };
  const chk = (key, label, fn) => el('label', {}, el('input', { type: 'checkbox', onchange: e => { toggles[key] = e.target.checked; fn(e.target.checked); } }), label);
  box.append(
    chk('volumes', 'strefy wygranej / rynien', on => cpDebugVolumes(on)),
    chk('colliders', 'kolidery (siatka)', on => cpDebugColliders(on)));
  // Tuning panel: live-edit the physics config; APPLY rebuilds the world
  // from a snapshot of the current pile. Local only — it never moves coins.
  const cfg = cpSim.cfg;
  const knobs = [
    ['physics', 'gravity', -2000, -300, 1], ['physics', 'coinFriction', 0, 1, 0.01], ['physics', 'bedFriction', 0, 1, 0.01],
    ['physics', 'coinRestitution', 0, 0.6, 0.01], ['physics', 'linearDamping', 0, 2, 0.01], ['physics', 'angularDamping', 0, 3, 0.05],
    ['physics', 'density', 1, 20, 0.1], ['physics', 'solverIterations', 1, 16, 1],
    ['pusher', 'travel', 2, 14, 0.5], ['pusher', 'forwardTime', 0.5, 4, 0.05], ['pusher', 'returnTime', 0.5, 4, 0.05],
    ['pusher', 'pauseFront', 0, 2, 0.05], ['pusher', 'pauseBack', 0, 2, 0.05],
  ];
  const edits = cpStore('tuning') || {};
  for (const [grp, key, min, max, step] of knobs) {
    const val = (edits[grp] && edits[grp][key] !== undefined) ? edits[grp][key] : cfg[grp][key];
    const lab = el('span', {}, String(val));
    const inp = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val),
      oninput: e => { (edits[grp] = edits[grp] || {})[key] = Number(e.target.value); lab.textContent = e.target.value; } });
    box.append(el('label', {}, key, inp, lab));
  }
  box.append(
    el('button', { className: 'cp-btn', onclick: () => { cpStore('tuning', edits); cpDebugApply(edits); } }, 'SAVE + APPLY'),
    el('button', { className: 'cp-btn', onclick: () => { cpStore('tuning', null); cpDebugApply({}); toast('Przywrócono domyślne'); } }, 'RESET'));
  cpUi.stage.append(box);
  cpDebug = { box, out, helpers, toggles, fps: 0, frames: 0, acc: 0, phys: 0 };
}

function cpDebugApply(over) {
  if (!cpSim) return;
  const layout = cpSim.snapshotLayout();
  const coins = Array.from(cpSim.coins.values(), c => ({ id: c.id, kind: c.kind, value: c.value }));
  const motor = cpSim.motorOn;
  cpSim.dispose();
  cpSim = cpCore.cpCreateSim(cpRapier, { config: over });
  cpSim.onCollect = cpOnCollect; cpSim.onImpact = cpOnImpact;
  cpSim.restore(layout, coins, 3);
  cpSim.settle(1);
  cpSim.motorOn = motor;
  cpPusherPrev = cpSim.pusherOffset;
}

function cpDebugVolumes(on) {
  if (!cpView) return;
  const T = cpThree, M = cpSim.cfg.machine;
  cpDebug.helpers.filter(h => h.userData.kind === 'vol').forEach(h => cpView.scene.remove(h));
  cpDebug.helpers = cpDebug.helpers.filter(h => h.userData.kind !== 'vol');
  if (!on) return;
  const add = (w, h, d, x, y, z, color) => {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }));
    m.position.set(x, y, z); m.userData.kind = 'vol'; cpView.scene.add(m); cpDebug.helpers.push(m);
  };
  const top = -M.collectDepth, bottom = -30;
  add((M.halfWidth + M.gutterWidth) * 2, top - bottom, M.chuteDepth, 0, (top + bottom) / 2, M.separatorZ + M.chuteDepth / 2, 0x33ff66);
  for (const s of [-1, 1]) add(M.gutterWidth, top - bottom, M.bedFrontZ - M.gutterStartZ, s * (M.halfWidth + M.gutterWidth / 2), (top + bottom) / 2, (M.bedFrontZ + M.gutterStartZ) / 2, 0xff3344);
}

function cpDebugColliders(on) {
  if (!cpView) return;
  const T = cpThree;
  cpDebug.helpers.filter(h => h.userData.kind === 'col').forEach(h => cpView.scene.remove(h));
  cpDebug.helpers = cpDebug.helpers.filter(h => h.userData.kind !== 'col');
  if (!on) return;
  for (const s of cpSim.statics) {
    if (s.capsule) continue;
    const m = new T.Mesh(new T.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2), new T.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true }));
    m.position.set(s.x, s.y, s.z); m.userData.kind = 'col'; cpView.scene.add(m); cpDebug.helpers.push(m);
  }
}

function cpDebugUpdate(dt, physMs, steps) {
  const d = cpDebug;
  d.frames++; d.acc += dt; d.phys = d.phys * 0.9 + physMs * 0.1;
  if (d.acc < 0.5) return;
  d.fps = d.frames / d.acc; d.frames = 0; d.acc = 0;
  const s = cpSim;
  d.out.textContent = [
    `render ${d.fps.toFixed(0)} fps · physics ${(1 / s.cfg.physics.dt).toFixed(0)} Hz (${steps}/frame)`,
    `step ${d.phys.toFixed(2)} ms · quality ${cpQualityName}`,
    `coins ${s.coins.size} · awake ${s.stats.awake || 0} · bodies ${s.world.bodies.len()}`,
    `pusher ${cpCore.cpPusherPhase(s.cfg.pusher, s.time)} ${s.pusherOffset.toFixed(2)} cm · motor ${s.motorOn ? 'on' : 'off'}`,
    `exits prize ${s.stats.prize} · gutter ${s.stats.gutter} · lost ${s.stats.lost} · clamped ${s.stats.clamped || 0}`,
    `pending ${cpPending.length} · inflight ${cpInflight} · bank ${cpServer ? cpServer.bank : '—'} · state ${cpState}`,
  ].join('\n');
}

window.addEventListener('resize', () => { if (activeTab === 'coinpusher') cpResize(); });
