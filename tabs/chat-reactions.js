// ════════════════════════════════════════════════════════════════════════════
//  Czat G6 — reactions on messages + animated „Naklejki" (lazy module)
// ════════════════════════════════════════════════════════════════════════════
//  Not a tab: initChat() fetches this through ensureTabModule('chatfx') once the
//  chat is already usable. Same scope rules as every tabs/*.js file — this file
//  owns its top-level names, and its function declarations overwrite the no-op
//  chatFx* stubs index.html keeps, so the chat keeps working as plain text if
//  this file never arrives.
//
//  • A reaction is a chat_reactions row, toggled through chat_toggle_reaction()
//    (supabase/chat-reactions.sql). Removing one flips `active` — see that file
//    for why it is never a DELETE.
//  • A sticker message is an ordinary chat_send() whose body is ':st:<code>:'.
//
//  The stickers are our own art: inline SVG + CSS keyframes, no image files.
//  They are Clash-flavoured on purpose (a laughing barbarian, an angry king, a
//  goblin with a coin bag), but every shape here is drawn in this file.
//
//  ⚠️ CHAT_FX_EMOJI + CHAT_FX_STICKERS codes mirror chat_react_codes() in SQL,
//  and CHAT_FX_MAX_PER_MSG mirrors chat_react_max_per_message(). Add a code in
//  both places or the server rejects it with invalid_reaction.
// ════════════════════════════════════════════════════════════════════════════

const CHAT_FX_MAX_PER_MSG = 3;
const CHAT_FX_MIN_GAP_MS = 320;   // server throttle is 300ms per user
const CHAT_FX_STICKER_RE = /^:st:([a-z_]+):$/;

const CHAT_FX_EMOJI = [
  { code: 'laugh',  e: '😂', label: 'Haha' },
  { code: 'fire',   e: '🔥', label: 'Ogień' },
  { code: 'skull',  e: '💀', label: 'Nie żyję' },
  { code: 'clown',  e: '🤡', label: 'Klaun' },
  { code: 'salute', e: '🫡', label: 'Szacun' },
  { code: 'monkey', e: '🙈', label: 'Nie patrzę' },
  { code: 'money',  e: '💸', label: 'Hajs leci' },
  { code: 'goat',   e: '🐐', label: 'GOAT' },
];

// Shared outline colour so the set reads as one family.
const CFX_INK = '#3a2412';

function cfxStar(cx, cy, r1, r2, n) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
  }
  return pts.join(' ');
}

// `a` = animated part. The keyframe name is the second class; --d on the root
// is the default duration, an inline style overrides delay/duration per part.
const CHAT_FX_STICKERS = [
  {
    code: 'wojownik_smiech', label: 'Wojownik się śmieje', d: '0.7s',
    svg: `
      <g class="a cfx-laugh">
        <circle cx="50" cy="54" r="30" fill="#f1c08a" stroke="${CFX_INK}" stroke-width="3"/>
        <path d="M20 48 Q20 16 50 14 Q80 16 80 48 Q72 30 50 30 Q28 30 20 48Z" fill="#f4b632" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M32 46 L46 42" stroke="#c98a12" stroke-width="5" stroke-linecap="round"/>
        <path d="M68 46 L54 42" stroke="#c98a12" stroke-width="5" stroke-linecap="round"/>
        <path d="M33 52 q6 -7 12 0" stroke="${CFX_INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
        <path d="M55 52 q6 -7 12 0" stroke="${CFX_INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
        <path d="M34 66 Q50 96 66 66 Z" fill="#8b1e1e" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M39 68 H61" stroke="#fff" stroke-width="4"/>
        <ellipse cx="50" cy="82" rx="7" ry="4" fill="#e0556b"/>
        <path d="M24 66 Q37 54 50 62 Q63 54 76 66 Q63 63 50 67 Q37 63 24 66Z" fill="#f4b632" stroke="${CFX_INK}" stroke-width="2.5" stroke-linejoin="round"/>
      </g>
      <path class="a cfx-tear" d="M26 54 q-5 8 0 11 q5 -3 0 -11z" fill="#5ec8ff" stroke="#1d6fa3" stroke-width="1.5"/>
      <path class="a cfx-tear" style="animation-delay:-.35s" d="M74 54 q-5 8 0 11 q5 -3 0 -11z" fill="#5ec8ff" stroke="#1d6fa3" stroke-width="1.5"/>`,
  },
  {
    code: 'krol_zly', label: 'Król się wkurzył', d: '0.6s',
    svg: `
      <g class="a cfx-shake">
        <path d="M28 64 Q30 96 50 97 Q70 96 72 64Z" fill="#7a4a24" stroke="${CFX_INK}" stroke-width="3"/>
        <circle cx="50" cy="56" r="27" fill="#ef7f64" stroke="${CFX_INK}" stroke-width="3"/>
        <path d="M28 64 Q30 88 50 88 Q70 88 72 64 Q62 76 50 76 Q38 76 28 64Z" fill="#8a5530" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M30 34 L33 12 L42 25 L50 6 L58 25 L67 12 L70 34 Z" fill="#ffcc33" stroke="#8a5a00" stroke-width="3" stroke-linejoin="round"/>
        <circle cx="50" cy="22" r="3.5" fill="#e53935"/>
        <path d="M31 42 L46 49" stroke="${CFX_INK}" stroke-width="5" stroke-linecap="round"/>
        <path d="M69 42 L54 49" stroke="${CFX_INK}" stroke-width="5" stroke-linecap="round"/>
        <circle cx="40" cy="55" r="3.2" fill="${CFX_INK}"/>
        <circle cx="60" cy="55" r="3.2" fill="${CFX_INK}"/>
        <rect x="37" y="63" width="26" height="10" rx="2" fill="#fff" stroke="${CFX_INK}" stroke-width="2.5"/>
        <path d="M37 68 H63 M44 63 V73 M50 63 V73 M56 63 V73" stroke="${CFX_INK}" stroke-width="1.5"/>
      </g>
      <g class="a cfx-steam"><circle cx="14" cy="46" r="6" fill="#fff" stroke="#9aa3ad" stroke-width="2"/><circle cx="9" cy="34" r="4" fill="#fff" stroke="#9aa3ad" stroke-width="2"/></g>
      <g class="a cfx-steam" style="animation-delay:-.3s"><circle cx="86" cy="46" r="6" fill="#fff" stroke="#9aa3ad" stroke-width="2"/><circle cx="91" cy="34" r="4" fill="#fff" stroke="#9aa3ad" stroke-width="2"/></g>`,
  },
  {
    code: 'goblin_kasa', label: 'Goblin ucieka z kasą', d: '0.8s',
    svg: `
      <g class="a cfx-run">
        <path d="M68 50 Q56 90 79 92 Q102 90 90 50Z" fill="#b07a3c" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M68 50 Q79 44 90 50" stroke="${CFX_INK}" stroke-width="4" fill="none"/>
        <text x="79" y="80" font-size="20" font-weight="900" text-anchor="middle" fill="#ffd23f" stroke="${CFX_INK}" stroke-width="1.2" font-family="Arial, sans-serif">$</text>
        <path d="M22 50 L2 36 L26 42Z" fill="#7ccf4a" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M60 50 L76 34 L58 42Z" fill="#7ccf4a" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <circle cx="41" cy="54" r="22" fill="#7ccf4a" stroke="${CFX_INK}" stroke-width="3"/>
        <circle cx="33" cy="48" r="5.5" fill="#fff" stroke="${CFX_INK}" stroke-width="2"/>
        <circle cx="50" cy="48" r="5.5" fill="#fff" stroke="${CFX_INK}" stroke-width="2"/>
        <circle cx="35" cy="48" r="2.4" fill="${CFX_INK}"/>
        <circle cx="52" cy="48" r="2.4" fill="${CFX_INK}"/>
        <path d="M41 51 q12 5 1 11" fill="#5fae36" stroke="${CFX_INK}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M28 63 Q41 78 55 63Z" fill="#3a1010" stroke="${CFX_INK}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M32 64 l3 5 l3 -5 M45 64 l3 5 l3 -5" fill="#fff"/>
      </g>
      <g class="a cfx-hop"><circle cx="72" cy="30" r="6" fill="#ffcf33" stroke="#a86b00" stroke-width="2.5"/></g>
      <g class="a cfx-hop" style="animation-delay:-.4s"><circle cx="88" cy="24" r="5" fill="#ffcf33" stroke="#a86b00" stroke-width="2.5"/></g>`,
  },
  {
    code: 'zloto_deszcz', label: 'Deszcz złota', d: '1.4s',
    svg: `
      ${[[18, 0, 34], [42, -0.5, 18], [66, -0.9, 40], [86, -0.25, 22], [30, -1.1, 58], [58, -0.7, 62]].map(([x, dl, y]) => `
        <g class="a cfx-fall" style="animation-delay:${dl}s">
          <circle cx="${x}" cy="${y}" r="9" fill="#ffcf33" stroke="#a86b00" stroke-width="3"/>
          <circle cx="${x}" cy="${y}" r="4" fill="none" stroke="#a86b00" stroke-width="2"/>
        </g>`).join('')}
      <ellipse cx="30" cy="90" rx="16" ry="6" fill="#ffcf33" stroke="#a86b00" stroke-width="3"/>
      <ellipse cx="70" cy="90" rx="16" ry="6" fill="#ffcf33" stroke="#a86b00" stroke-width="3"/>
      <ellipse cx="50" cy="84" rx="16" ry="6" fill="#ffd95a" stroke="#a86b00" stroke-width="3"/>
      <polygon class="a cfx-twinkle" style="animation-duration:.9s" points="${cfxStar(50, 70, 7, 2.5, 4)}" fill="#fff"/>`,
  },
  {
    code: 'smok_ogien', label: 'Smok kicha ogniem', d: '1.3s',
    svg: `
      <g class="a cfx-fire" style="transform-origin:0% 50%">
        <path d="M70 52 Q86 30 98 46 Q90 50 100 56 Q90 62 98 72 Q84 76 70 62Z" fill="#ff8f1a" stroke="#b33c00" stroke-width="2"/>
        <path d="M72 55 Q86 45 92 55 Q85 58 90 64 Q80 66 72 60Z" fill="#ffe14d"/>
      </g>
      <g class="a cfx-sneeze" style="transform-origin:20% 60%">
        <path d="M22 34 L12 10 L34 28Z" fill="#f4d03f" stroke="${CFX_INK}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M38 28 L40 4 L50 28Z" fill="#f4d03f" stroke="${CFX_INK}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M6 62 Q6 30 38 28 Q60 28 64 44 L74 50 Q78 64 62 66 L30 74 Q8 76 6 62Z" fill="#8e44ad" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <circle cx="42" cy="42" r="7" fill="#fff" stroke="${CFX_INK}" stroke-width="2"/>
        <circle cx="45" cy="43" r="3" fill="${CFX_INK}"/>
        <path d="M34 34 L50 36" stroke="${CFX_INK}" stroke-width="3.5" stroke-linecap="round"/>
        <circle cx="68" cy="52" r="2.2" fill="${CFX_INK}"/>
        <path d="M40 62 L62 58" stroke="${CFX_INK}" stroke-width="2.5" stroke-linecap="round"/>
      </g>`,
  },
  {
    code: 'lucznik_foch', label: 'Łuczniczka strzela focha', d: '2s',
    svg: `
      <path class="a cfx-flick" style="transform-origin:10% 20%" d="M74 34 Q100 44 92 84 Q84 66 70 58Z" fill="#ff5fa2" stroke="#8a1f4f" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="50" cy="56" r="27" fill="#f7cfa6" stroke="${CFX_INK}" stroke-width="3"/>
      <ellipse cx="40" cy="55" rx="7.5" ry="6.5" fill="#fff" stroke="${CFX_INK}" stroke-width="2"/>
      <ellipse cx="61" cy="55" rx="7.5" ry="6.5" fill="#fff" stroke="${CFX_INK}" stroke-width="2"/>
      <circle class="a cfx-roll" cx="40" cy="58" r="3" fill="#2f7d4f"/>
      <circle class="a cfx-roll" cx="61" cy="58" r="3" fill="#2f7d4f"/>
      <path d="M32 55 Q40 45 48 55Z" fill="#f7cfa6" stroke="${CFX_INK}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M53 55 Q61 45 69 55Z" fill="#f7cfa6" stroke="${CFX_INK}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M43 72 q7 -2 14 1" stroke="${CFX_INK}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path class="a cfx-flick" style="transform-origin:50% 90%" d="M22 54 Q18 16 52 14 Q86 16 80 48 Q70 30 52 30 Q34 32 30 64 Q22 62 22 54Z" fill="#ff5fa2" stroke="#8a1f4f" stroke-width="3" stroke-linejoin="round"/>
      <text class="a cfx-puff" x="82" y="96" font-size="13" font-weight="800" text-anchor="middle" fill="#8a1f4f" font-family="Arial, sans-serif">pff</text>`,
  },
  {
    code: 'swinka_wjazd', label: 'Wjazd na świni', d: '0.45s',
    svg: `
      <g class="a cfx-dust" style="animation-duration:.9s"><circle cx="84" cy="84" r="7" fill="#d9c7a8"/></g>
      <g class="a cfx-dust" style="animation-duration:.9s;animation-delay:-.45s"><circle cx="92" cy="76" r="5" fill="#d9c7a8"/></g>
      <g class="a cfx-gallop">
        <path d="M44 86 v10 M56 86 v10 M70 84 v10 M80 82 v10" stroke="${CFX_INK}" stroke-width="5" stroke-linecap="round"/>
        <ellipse cx="62" cy="68" rx="28" ry="19" fill="#f7a1b5" stroke="${CFX_INK}" stroke-width="3"/>
        <path d="M88 64 q10 -4 6 6" stroke="${CFX_INK}" stroke-width="2.5" fill="none"/>
        <circle cx="30" cy="62" r="17" fill="#f7a1b5" stroke="${CFX_INK}" stroke-width="3"/>
        <path d="M32 46 L42 36 L42 52Z" fill="#e8819a" stroke="${CFX_INK}" stroke-width="2.5" stroke-linejoin="round"/>
        <ellipse cx="16" cy="66" rx="8" ry="7" fill="#e8819a" stroke="${CFX_INK}" stroke-width="2.5"/>
        <circle cx="13" cy="66" r="1.8" fill="${CFX_INK}"/><circle cx="19" cy="66" r="1.8" fill="${CFX_INK}"/>
        <path d="M22 54 L32 58" stroke="${CFX_INK}" stroke-width="3" stroke-linecap="round"/>
        <circle cx="28" cy="58" r="2.4" fill="${CFX_INK}"/>
        <g class="a cfx-hammer" style="transform-origin:0% 100%;animation-duration:.45s">
          <path d="M58 50 L70 18" stroke="#7a4a24" stroke-width="5" stroke-linecap="round"/>
          <rect x="60" y="6" width="22" height="13" rx="3" fill="#9aa3ad" stroke="${CFX_INK}" stroke-width="2.5" transform="rotate(20 71 12)"/>
        </g>
      </g>`,
  },
  {
    code: 'budowniczy_zzz', label: 'Budowniczy śpi', d: '2.4s',
    svg: `
      <g class="a cfx-breathe">
        <circle cx="44" cy="62" r="26" fill="#f1c08a" stroke="${CFX_INK}" stroke-width="3"/>
        <path d="M18 56 Q20 26 44 26 Q68 26 70 56Z" fill="#ffd21f" stroke="${CFX_INK}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M44 26 V52" stroke="#d9a400" stroke-width="4"/>
        <rect x="12" y="52" width="64" height="9" rx="4" fill="#ffc400" stroke="${CFX_INK}" stroke-width="3"/>
        <path d="M31 68 q5 4 10 0 M49 68 q5 4 10 0" stroke="${CFX_INK}" stroke-width="3" fill="none" stroke-linecap="round"/>
        <path d="M30 76 Q44 70 58 76 Q44 80 30 76Z" fill="#8d8d8d" stroke="${CFX_INK}" stroke-width="2"/>
        <ellipse cx="44" cy="82" rx="3.5" ry="3" fill="#6b2a2a"/>
      </g>
      <text class="a cfx-zzz" x="74" y="44" font-size="15" font-weight="900" fill="#3f6fd8" font-family="Arial, sans-serif">Z</text>
      <text class="a cfx-zzz" style="animation-delay:-.8s" x="84" y="30" font-size="12" font-weight="900" fill="#3f6fd8" font-family="Arial, sans-serif">z</text>
      <text class="a cfx-zzz" style="animation-delay:-1.6s" x="90" y="18" font-size="10" font-weight="900" fill="#3f6fd8" font-family="Arial, sans-serif">z</text>`,
  },
  {
    code: 'bum_bomba', label: 'BUM!', d: '1.6s',
    svg: `
      <g class="a cfx-bombbody">
        <circle cx="46" cy="60" r="26" fill="#2d3440" stroke="#111" stroke-width="3"/>
        <ellipse cx="36" cy="50" rx="7" ry="4.5" fill="#6b7686" transform="rotate(-35 36 50)"/>
        <rect x="56" y="30" width="12" height="10" rx="2" fill="#555e6b" stroke="#111" stroke-width="2.5" transform="rotate(35 62 35)"/>
        <path d="M66 32 Q74 18 82 18" stroke="#7a4a24" stroke-width="3" fill="none"/>
        <polygon class="a cfx-spark" style="animation-duration:.25s" points="${cfxStar(83, 17, 8, 3, 5)}" fill="#ffb300"/>
      </g>
      <g class="a cfx-boom">
        <polygon points="${cfxStar(50, 55, 46, 26, 12)}" fill="#ff7a1a" stroke="#a12a00" stroke-width="3" stroke-linejoin="round"/>
        <polygon points="${cfxStar(50, 55, 30, 18, 10)}" fill="#ffe14d"/>
        <text x="50" y="64" font-size="22" font-weight="900" text-anchor="middle" fill="#c62828" font-family="Arial Black, Arial, sans-serif">BUM!</text>
      </g>`,
  },
  {
    code: 'puchar_taniec', label: 'Puchar tańczy', d: '0.9s',
    svg: `
      <polygon class="a cfx-twinkle" points="${cfxStar(14, 24, 8, 3, 4)}" fill="#ffd23f"/>
      <polygon class="a cfx-twinkle" style="animation-delay:-.45s" points="${cfxStar(88, 34, 7, 2.5, 4)}" fill="#ffd23f"/>
      <g class="a cfx-dance" style="transform-origin:50% 100%">
        <path d="M30 30 Q12 30 16 46 Q20 56 32 52" stroke="#a86b00" stroke-width="5" fill="none"/>
        <path d="M70 30 Q88 30 84 46 Q80 56 68 52" stroke="#a86b00" stroke-width="5" fill="none"/>
        <path d="M28 22 H72 Q72 62 50 66 Q28 62 28 22Z" fill="#ffcf33" stroke="#a86b00" stroke-width="3" stroke-linejoin="round"/>
        <rect x="44" y="64" width="12" height="13" fill="#ffcf33" stroke="#a86b00" stroke-width="3"/>
        <rect x="32" y="76" width="36" height="12" rx="3" fill="#8a5a2b" stroke="${CFX_INK}" stroke-width="3"/>
        <circle cx="42" cy="38" r="3" fill="${CFX_INK}"/><circle cx="58" cy="38" r="3" fill="${CFX_INK}"/>
        <path d="M40 46 Q50 58 60 46" stroke="${CFX_INK}" stroke-width="3" fill="#8b1e1e" stroke-linejoin="round"/>
        <ellipse cx="36" cy="46" rx="4" ry="2.5" fill="#ff9f7a" opacity=".8"/><ellipse cx="64" cy="46" rx="4" ry="2.5" fill="#ff9f7a" opacity=".8"/>
      </g>`,
  },
  {
    code: 'plan_placz', label: 'Plan legł w gruzach', d: '1s',
    svg: `
      <rect x="4" y="80" width="28" height="14" rx="2" fill="#b5835a" stroke="${CFX_INK}" stroke-width="2.5"/>
      <rect x="68" y="80" width="28" height="14" rx="2" fill="#b5835a" stroke="${CFX_INK}" stroke-width="2.5"/>
      <rect class="a cfx-brick" x="36" y="80" width="28" height="14" rx="2" fill="#c99467" stroke="${CFX_INK}" stroke-width="2.5"/>
      <g class="a cfx-sob" style="animation-duration:.3s">
        <circle cx="50" cy="42" r="28" fill="#ffd35c" stroke="${CFX_INK}" stroke-width="3"/>
        <path d="M30 30 L42 26 M70 30 L58 26" stroke="${CFX_INK}" stroke-width="3.5" stroke-linecap="round"/>
        <path d="M32 40 q6 5 12 0 M56 40 q6 5 12 0" stroke="${CFX_INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
        <path d="M36 60 Q43 52 50 58 Q57 52 64 60" stroke="${CFX_INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      </g>
      <rect class="a cfx-stream" style="transform-origin:50% 0%" x="34" y="44" width="7" height="36" rx="3.5" fill="#5ec8ff"/>
      <rect class="a cfx-stream" style="transform-origin:50% 0%;animation-delay:-.5s" x="59" y="44" width="7" height="36" rx="3.5" fill="#5ec8ff"/>`,
  },
  {
    code: 'gg_wp', label: 'GG WP', d: '0.7s',
    svg: `
      <g class="a cfx-clapl">
        <rect x="4" y="52" width="22" height="34" rx="10" fill="#f7c68c" stroke="${CFX_INK}" stroke-width="3" transform="rotate(-18 15 69)"/>
        <path d="M24 58 q8 -4 8 4" stroke="${CFX_INK}" stroke-width="3" fill="#f7c68c"/>
      </g>
      <g class="a cfx-clapr">
        <rect x="74" y="52" width="22" height="34" rx="10" fill="#f7c68c" stroke="${CFX_INK}" stroke-width="3" transform="rotate(18 85 69)"/>
        <path d="M76 58 q-8 -4 -8 4" stroke="${CFX_INK}" stroke-width="3" fill="#f7c68c"/>
      </g>
      <g class="a cfx-pop">
        <text x="50" y="48" font-size="38" font-weight="900" text-anchor="middle" fill="#ffcf33" stroke="#7a3e00" stroke-width="3" paint-order="stroke" font-family="Arial Black, Arial, sans-serif">GG</text>
        <text x="50" y="68" font-size="15" font-weight="900" text-anchor="middle" fill="#fff" stroke="#3f6fd8" stroke-width="3" paint-order="stroke" font-family="Arial Black, Arial, sans-serif">WP</text>
      </g>
      <polygon class="a cfx-twinkle" points="${cfxStar(50, 86, 6, 2, 4)}" fill="#ffd23f"/>`,
  },
];

const CHAT_FX_BY_CODE = new Map([
  ...CHAT_FX_EMOJI.map(x => [x.code, { ...x, kind: 'emoji' }]),
  ...CHAT_FX_STICKERS.map(x => [x.code, { ...x, kind: 'sticker' }]),
]);
const CHAT_FX_ORDER = new Map([...CHAT_FX_BY_CODE.keys()].map((k, i) => [k, i]));

// message_id → Map(code → Set(user_id)), active reactions only.
let chatFxMap = new Map();
let chatFxQueue = Promise.resolve();
let chatFxLastCall = 0;
let chatFxPop = null;
let chatFxWarned = false;
const chatFxTemplates = new Map();

// ── CSS (injected once; keeps index.html under its payload budget) ──────────

function chatFxInjectCss() {
  if (document.getElementById('cfx-style')) return;
  const css = `
  .cfx-st { display: inline-block; width: var(--s, 22px); height: var(--s, 22px); line-height: 0; vertical-align: middle; flex: none; }
  .cfx-st svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .cfx-st .a {
    transform-box: fill-box; transform-origin: center;
    animation-duration: var(--d, 1s); animation-timing-function: ease-in-out;
    animation-iteration-count: var(--it, infinite); animation-play-state: var(--ps, running);
  }
  .cfx-st.is-sm { --s: 20px; --ps: paused; }
  .cfx-st.is-md { --s: 52px; --ps: paused; }
  .cfx-st.is-big { --s: 96px; --it: 3; }
  .cfx-pill:hover .cfx-st, .cfx-grid-btn:hover .cfx-st, .cfx-grid-btn:focus-visible .cfx-st { --ps: running; }
  .cfx-sticker-msg:hover .cfx-st { --it: infinite; }
  @media (prefers-reduced-motion: reduce) { .cfx-st .a { animation: none !important; } }

  .cfx-laugh { animation-name: cfx-laugh; } .cfx-tear { animation-name: cfx-tear; }
  .cfx-shake { animation-name: cfx-shake; } .cfx-steam { animation-name: cfx-steam; }
  .cfx-run { animation-name: cfx-run; } .cfx-hop { animation-name: cfx-hop; }
  .cfx-fall { animation-name: cfx-fall; } .cfx-twinkle { animation-name: cfx-twinkle; }
  .cfx-fire { animation-name: cfx-fire; } .cfx-sneeze { animation-name: cfx-sneeze; }
  .cfx-roll { animation-name: cfx-roll; } .cfx-flick { animation-name: cfx-flick; } .cfx-puff { animation-name: cfx-puff; }
  .cfx-gallop { animation-name: cfx-gallop; } .cfx-dust { animation-name: cfx-dust; } .cfx-hammer { animation-name: cfx-hammer; }
  .cfx-breathe { animation-name: cfx-breathe; } .cfx-zzz { animation-name: cfx-zzz; }
  .cfx-bombbody { animation-name: cfx-bombbody; } .cfx-boom { animation-name: cfx-boom; } .cfx-spark { animation-name: cfx-spark; }
  .cfx-dance { animation-name: cfx-dance; }
  .cfx-brick { animation-name: cfx-brick; } .cfx-sob { animation-name: cfx-sob; } .cfx-stream { animation-name: cfx-stream; }
  .cfx-clapl { animation-name: cfx-clapl; } .cfx-clapr { animation-name: cfx-clapr; } .cfx-pop { animation-name: cfx-pop; }

  @keyframes cfx-laugh { 0%,50%,100% { transform: translateY(0) rotate(0); } 25% { transform: translateY(-4px) rotate(-5deg); } 75% { transform: translateY(-4px) rotate(5deg); } }
  @keyframes cfx-tear { 0% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(20px); opacity: 0; } }
  @keyframes cfx-shake { 0%,100% { transform: translateX(0); } 20%,60% { transform: translateX(-3px) rotate(-2deg); } 40%,80% { transform: translateX(3px) rotate(2deg); } }
  @keyframes cfx-steam { 0% { transform: translateY(4px) scale(.5); opacity: 0; } 30% { opacity: 1; } 100% { transform: translateY(-20px) scale(1.3); opacity: 0; } }
  @keyframes cfx-run { 0%,100% { transform: translate(-7px,0); } 25%,75% { transform: translate(0,-4px); } 50% { transform: translate(7px,0); } }
  @keyframes cfx-hop { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
  @keyframes cfx-fall { 0% { transform: translateY(-30px) scaleX(1); opacity: 0; } 15% { opacity: 1; } 50% { transform: translateY(0) scaleX(.25); } 85% { opacity: 1; } 100% { transform: translateY(26px) scaleX(1); opacity: 0; } }
  @keyframes cfx-twinkle { 0%,100% { transform: scale(0) rotate(0); opacity: 0; } 50% { transform: scale(1) rotate(45deg); opacity: 1; } }
  @keyframes cfx-fire { 0%,40% { transform: scaleX(0); opacity: 0; } 50% { transform: scaleX(1.1); opacity: 1; } 60% { transform: scale(.9,1.15); } 72% { transform: scaleX(1.15); opacity: 1; } 90% { transform: scaleX(.4); opacity: .5; } 100% { transform: scaleX(0); opacity: 0; } }
  @keyframes cfx-sneeze { 0%,30% { transform: rotate(0); } 42% { transform: rotate(-10deg) translateY(-2px); } 52% { transform: rotate(5deg) translateX(-4px); } 75%,100% { transform: rotate(0); } }
  @keyframes cfx-roll { 0%,15% { transform: translateY(0); } 35%,70% { transform: translateY(-7px); } 90%,100% { transform: translateY(0); } }
  @keyframes cfx-flick { 0%,30% { transform: rotate(0); } 42% { transform: rotate(-9deg); } 56% { transform: rotate(4deg); } 70%,100% { transform: rotate(0); } }
  @keyframes cfx-puff { 0%,35% { opacity: 0; transform: translateY(4px); } 50%,80% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; } }
  @keyframes cfx-gallop { 0%,100% { transform: translate(0,0) rotate(0); } 25% { transform: translate(-2px,-5px) rotate(-3deg); } 50% { transform: translate(0,0); } 75% { transform: translate(2px,-2px) rotate(2deg); } }
  @keyframes cfx-dust { 0% { transform: translateX(-6px) scale(.4); opacity: .9; } 100% { transform: translateX(14px) scale(1.5); opacity: 0; } }
  @keyframes cfx-hammer { 0%,100% { transform: rotate(0); } 50% { transform: rotate(-35deg); } }
  @keyframes cfx-breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04) translateY(1px); } }
  @keyframes cfx-zzz { 0% { transform: translate(0,0) scale(.6); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(6px,-14px) scale(1.2); opacity: 0; } }
  @keyframes cfx-bombbody { 0%,58% { transform: scale(1); opacity: 1; } 64% { transform: scale(1.15); } 70%,92% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
  @keyframes cfx-boom { 0%,64% { transform: scale(0); opacity: 0; } 72% { transform: scale(1.15); opacity: 1; } 88% { transform: scale(1); opacity: 1; } 96%,100% { transform: scale(1.3); opacity: 0; } }
  @keyframes cfx-spark { 0%,100% { transform: scale(.6); opacity: .6; } 50% { transform: scale(1.3); opacity: 1; } }
  @keyframes cfx-dance { 0%,50%,100% { transform: rotate(0) translateY(0); } 25% { transform: rotate(-12deg) translateY(-5px); } 75% { transform: rotate(12deg) translateY(-5px); } }
  @keyframes cfx-brick { 0%,35% { transform: translateY(0) rotate(0); opacity: 1; } 80% { transform: translateY(8px) rotate(22deg); opacity: 1; } 100% { transform: translateY(12px) rotate(28deg); opacity: 0; } }
  @keyframes cfx-sob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(2px); } }
  @keyframes cfx-stream { 0%,100% { transform: scaleY(.25); opacity: .7; } 50% { transform: scaleY(1); opacity: 1; } }
  @keyframes cfx-clapl { 0%,100% { transform: translateX(0) rotate(0); } 50% { transform: translateX(12px) rotate(14deg); } }
  @keyframes cfx-clapr { 0%,100% { transform: translateX(0) rotate(0); } 50% { transform: translateX(-12px) rotate(-14deg); } }
  @keyframes cfx-pop { 0%,100% { transform: scale(1) rotate(0); } 30% { transform: scale(1.2) rotate(-6deg); } 60% { transform: scale(.95) rotate(4deg); } }

  /* Messages */
  .chat-msg { position: relative; }
  .cfx-sticker-msg { line-height: 0; padding: 2px 0; }
  .cfx-reacts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .cfx-reacts:empty { display: none; }
  .chat-msg.mine .cfx-reacts { justify-content: flex-end; }
  .cfx-pill {
    display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 7px 0 5px;
    border: 1px solid var(--c-line); border-radius: 999px; background: var(--c-solid);
    font-family: inherit; font-size: 11px; font-weight: 600; line-height: 1; color: var(--c-muted); cursor: pointer;
    transition: background .12s ease, border-color .12s ease, transform .12s ease;
  }
  .cfx-pill:hover { background: var(--c-hover); }
  .cfx-pill:active { transform: scale(.92); }
  .cfx-pill.is-mine { border-color: var(--c-accent); background: var(--c-accent-soft); color: var(--c-accent); }
  .cfx-pill.is-more { padding: 0 8px; font-size: 13px; }
  .cfx-emo { font-size: 14px; line-height: 1; }
  .cfx-add {
    position: absolute; top: 14px; right: -28px; width: 24px; height: 24px; border-radius: 50%;
    border: 1px solid var(--c-line); background: var(--c-solid); color: var(--c-muted);
    font-size: 13px; line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .12s ease, color .12s ease;
  }
  .chat-msg.mine .cfx-add { right: auto; left: -28px; }
  .chat-msg:hover .cfx-add, .cfx-add:focus-visible { opacity: 1; }
  .cfx-add:hover { color: var(--c-accent); border-color: var(--c-accent); }
  @media (hover: none) { .cfx-add { display: none; } }
  .chat-msg.cfx-pressing .chat-msg-bubble, .chat-msg.cfx-pressing .cfx-sticker-msg { transform: scale(.97); transition: transform .2s ease; }

  .cfx-send-btn {
    flex: none; width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--c-line);
    background: var(--c-solid); cursor: pointer; font-size: 18px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center; transition: background .12s ease;
  }
  .cfx-send-btn:hover, .cfx-send-btn.is-open { background: var(--c-hover); border-color: var(--c-accent); }

  /* Picker */
  #cfx-pop {
    position: fixed; z-index: 60; width: 272px; max-width: calc(100vw - 16px); box-sizing: border-box;
    background: var(--c-solid); color: var(--c-ink); border: 1px solid var(--c-line); border-radius: 14px;
    box-shadow: 0 12px 32px rgba(15,23,42,.18); padding: 10px;
  }
  .cfx-pop-label { font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--c-faint); margin: 2px 2px 6px; }
  .cfx-emoji-row { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; margin-bottom: 8px; }
  .cfx-emoji-btn {
    border: none; background: none; border-radius: 8px; height: 30px; font-size: 19px; line-height: 1; cursor: pointer; padding: 0;
    transition: background .1s ease, transform .1s ease;
  }
  .cfx-emoji-btn:hover { background: var(--c-hover); transform: scale(1.18); }
  .cfx-emoji-btn.is-mine { background: var(--c-accent-soft); }
  .cfx-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; max-height: 240px; overflow-y: auto; }
  .cfx-grid-btn {
    border: 1px solid transparent; background: none; border-radius: 10px; padding: 4px 2px 3px; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 2px; font-family: inherit;
    transition: background .1s ease;
  }
  .cfx-grid-btn:hover { background: var(--c-hover); }
  .cfx-grid-btn.is-mine { background: var(--c-accent-soft); border-color: var(--c-accent); }
  .cfx-grid-name { font-size: 9px; line-height: 1.15; color: var(--c-muted); text-align: center; min-height: 20px; }
  .cfx-pop-hint { font-size: 10.5px; color: var(--c-faint); margin: 8px 2px 0; }
  `;
  document.head.appendChild(el('style', { id: 'cfx-style' }, css));
}

// ── Sticker nodes ────────────────────────────────────────────────────────────

function chatFxStickerEl(code, size) {
  const def = CHAT_FX_BY_CODE.get(code);
  if (!def || def.kind !== 'sticker') return null;
  let tpl = chatFxTemplates.get(code);
  if (!tpl) {
    // Static, author-controlled markup (no user data) — safe to parse.
    tpl = document.createElement('template');
    tpl.innerHTML = `<span class="cfx-st" role="img" style="--d:${def.d}"><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${def.svg}</svg></span>`;
    chatFxTemplates.set(code, tpl);
  }
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.classList.add('is-' + size);
  node.setAttribute('aria-label', def.label);
  return node;
}

function chatFxIconEl(code, size) {
  const def = CHAT_FX_BY_CODE.get(code);
  if (!def) return null;
  if (def.kind === 'emoji') return el('span', { className: 'cfx-emo' }, def.e);
  return chatFxStickerEl(code, size);
}

function chatFxStickerCode(body) {
  const m = CHAT_FX_STICKER_RE.exec(String(body || ''));
  if (!m) return null;
  const def = CHAT_FX_BY_CODE.get(m[1]);
  return def && def.kind === 'sticker' ? m[1] : null;
}

// ── State ────────────────────────────────────────────────────────────────────

function chatFxApply(mid, uid, code, active) {
  let byCode = chatFxMap.get(mid);
  if (!byCode) { if (!active) return; byCode = new Map(); chatFxMap.set(mid, byCode); }
  let users = byCode.get(code);
  if (!users) { if (!active) return; users = new Set(); byCode.set(code, users); }
  if (active) users.add(uid); else users.delete(uid);
  if (!users.size) byCode.delete(code);
  if (!byCode.size) chatFxMap.delete(mid);
}

function chatFxHas(mid, code, uid) {
  return !!chatFxMap.get(mid)?.get(code)?.has(uid);
}

function chatFxMineCount(mid) {
  const byCode = chatFxMap.get(mid);
  if (!byCode || !me) return 0;
  let n = 0;
  byCode.forEach(users => { if (users.has(me.id)) n++; });
  return n;
}

async function chatFxLoadFor(ids) {
  const clean = [...new Set((ids || []).filter(id => id != null && !Number.isNaN(Number(id))))];
  for (let i = 0; i < clean.length; i += 100) {
    const chunk = clean.slice(i, i + 100);
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('chat_reactions')
        .select('message_id,user_id,code')
        .in('message_id', chunk).eq('active', true)
        .order('message_id').range(from, from + 999);
      if (error) {
        if (!chatFxWarned) { console.warn('chat_reactions', error); chatFxWarned = true; }
        return;
      }
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    chunk.forEach(id => chatFxMap.delete(id));
    rows.forEach(r => { if (CHAT_FX_BY_CODE.has(r.code)) chatFxApply(r.message_id, r.user_id, r.code, true); });
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function chatFxReactsRow(mid) {
  const row = el('div', { className: 'cfx-reacts', 'data-rmid': mid });
  const byCode = chatFxMap.get(mid);
  if (!byCode || !byCode.size) return row;
  [...byCode.entries()]
    .sort((a, b) => CHAT_FX_ORDER.get(a[0]) - CHAT_FX_ORDER.get(b[0]))
    .forEach(([code, users]) => {
      const def = CHAT_FX_BY_CODE.get(code);
      const mine = !!me && users.has(me.id);
      const nicks = [...users].map(id => (id === me?.id ? 'Ty' : chatPeerNick(id))).join(', ');
      const pill = el('button', {
        className: 'cfx-pill' + (mine ? ' is-mine' : ''), type: 'button',
        title: def.label + ' — ' + nicks,
      }, chatFxIconEl(code, 'sm'), String(users.size));
      pill.addEventListener('click', e => { e.stopPropagation(); chatFxToggle(mid, code); });
      row.appendChild(pill);
    });
  // On touch there is no hover button, so a row that already has reactions
  // carries its own „+" — long-press still works for a message with none.
  const more = el('button', { className: 'cfx-pill is-more', type: 'button', title: 'Dodaj reakcję' }, '+');
  more.addEventListener('click', e => { e.stopPropagation(); chatFxOpenPicker(more, { mode: 'react', mid }); });
  row.appendChild(more);
  return row;
}

function chatFxRefresh(mid) {
  document.querySelectorAll(`.cfx-reacts[data-rmid="${mid}"]`).forEach(old => {
    const box = old.closest('.chat-messages');
    const atBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    old.replaceWith(chatFxReactsRow(mid));
    if (box && atBottom) box.scrollTop = box.scrollHeight;
  });
  if (chatFxPop && chatFxPop.mode === 'react' && chatFxPop.mid === mid) chatFxRenderPicker();
}

function chatFxDecorate(node, m) {
  if (!m || m.id == null || !me) return;
  const code = chatFxStickerCode(m.body);
  if (code) {
    const bubble = node.querySelector('.chat-msg-bubble');
    if (bubble) {
      bubble.replaceWith(el('div', { className: 'cfx-sticker-msg', title: CHAT_FX_BY_CODE.get(code).label }, chatFxStickerEl(code, 'big')));
      node.classList.add('is-sticker');
    }
  }
  const time = node.querySelector('.chat-msg-time');
  node.insertBefore(chatFxReactsRow(m.id), time);

  const add = el('button', { className: 'cfx-add', type: 'button', title: 'Dodaj reakcję', 'aria-label': 'Dodaj reakcję' }, '☺');
  add.addEventListener('click', e => { e.stopPropagation(); chatFxOpenPicker(add, { mode: 'react', mid: m.id }); });
  node.appendChild(add);
  chatFxWireLongPress(node, m.id);
}

function chatFxWireLongPress(node, mid) {
  let timer = null, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; node.classList.remove('cfx-pressing'); };
  node.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || e.target.closest('.cfx-pill, .cfx-add')) return;
    sx = e.clientX; sy = e.clientY;
    node.classList.add('cfx-pressing');
    timer = setTimeout(() => {
      timer = null; node.classList.remove('cfx-pressing');
      try { navigator.vibrate?.(15); } catch (err) {}
      chatFxOpenPicker(node.querySelector('.cfx-sticker-msg, .chat-msg-bubble') || node, { mode: 'react', mid });
    }, 450);
  });
  node.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', e => { if (node.classList.contains('cfx-pressing') || timer === null && e.pointerType === 'touch') e.preventDefault(); });
}

// ── Toggling ─────────────────────────────────────────────────────────────────

function chatFxToggle(mid, code) {
  if (!me) return;
  const had = chatFxHas(mid, code, me.id);
  if (!had && chatFxMineCount(mid) >= CHAT_FX_MAX_PER_MSG) {
    showToast('Maks. ' + CHAT_FX_MAX_PER_MSG + ' reakcje na jedną wiadomość.');
    return;
  }
  chatFxApply(mid, me.id, code, !had);   // optimistic
  chatFxRefresh(mid);

  // Serialized, and spaced past the server's per-user throttle, so a burst of
  // clicks lands as a sequence instead of a row of too_fast errors.
  chatFxQueue = chatFxQueue.then(async () => {
    const wait = CHAT_FX_MIN_GAP_MS - (Date.now() - chatFxLastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    chatFxLastCall = Date.now();
    try {
      const { data, error } = await sb.rpc('chat_toggle_reaction', { p_message_id: mid, p_code: code });
      if (error) throw error;
      if (data && me) chatFxApply(mid, me.id, code, !!data.active);
    } catch (e) {
      if (me) chatFxApply(mid, me.id, code, had);
      const msg = String(e?.message || e);
      showToast(msg.includes('too_many_reactions') ? 'Maks. ' + CHAT_FX_MAX_PER_MSG + ' reakcje na jedną wiadomość.'
        : msg.includes('too_fast') ? '⏳ Zwolnij trochę.'
        : '❌ Nie udało się dodać reakcji.');
    }
    chatFxRefresh(mid);
  });
}

function chatFxOnRealtime(row) {
  if (!row || row.message_id == null || !CHAT_FX_BY_CODE.has(row.code)) return;
  chatFxApply(row.message_id, row.user_id, row.code, !!row.active);
  chatFxRefresh(row.message_id);
}

// ── Picker ───────────────────────────────────────────────────────────────────

function chatFxOpenPicker(anchor, opts) {
  const same = chatFxPop && chatFxPop.anchor === anchor;
  chatFxClosePicker();
  if (same) return;   // second click on the same trigger closes it

  const node = el('div', { id: 'cfx-pop', role: 'dialog', 'aria-label': opts.mode === 'send' ? 'Naklejki' : 'Reakcje' });
  document.body.appendChild(node);
  chatFxPop = { ...opts, anchor, node };
  if (anchor.classList.contains('cfx-send-btn')) anchor.classList.add('is-open');
  chatFxRenderPicker();
  chatFxPlacePicker();

  const onDown = e => { if (!node.contains(e.target) && !anchor.contains(e.target)) chatFxClosePicker(); };
  const onKey = e => { if (e.key === 'Escape') chatFxClosePicker(); };
  const onScroll = e => { if (!node.contains(e.target)) chatFxClosePicker(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', chatFxClosePicker);
  document.addEventListener('scroll', onScroll, true);
  chatFxPop.cleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', chatFxClosePicker);
    document.removeEventListener('scroll', onScroll, true);
  };
}

function chatFxClosePicker() {
  if (!chatFxPop) return;
  chatFxPop.cleanup?.();
  chatFxPop.node.remove();
  chatFxPop.anchor.classList?.remove('is-open');
  chatFxPop = null;
}

function chatFxPlacePicker() {
  const { node, anchor } = chatFxPop;
  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth, h = node.offsetHeight, m = 8;
  let top = r.top - h - 6;
  if (top < m) top = Math.min(r.bottom + 6, window.innerHeight - h - m);
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(m, Math.min(left, window.innerWidth - w - m));
  node.style.top = Math.max(m, top) + 'px';
  node.style.left = left + 'px';
}

function chatFxRenderPicker() {
  const pop = chatFxPop;
  if (!pop) return;
  const react = pop.mode === 'react';
  const mine = code => react && me && chatFxHas(pop.mid, code, me.id);
  pop.node.replaceChildren();

  pop.node.appendChild(el('div', { className: 'cfx-pop-label' }, react ? 'Reakcje' : 'Emoji'));
  const emojiRow = el('div', { className: 'cfx-emoji-row' });
  CHAT_FX_EMOJI.forEach(x => {
    const b = el('button', { className: 'cfx-emoji-btn' + (mine(x.code) ? ' is-mine' : ''), type: 'button', title: x.label }, x.e);
    b.addEventListener('click', () => {
      if (react) { chatFxToggle(pop.mid, x.code); chatFxClosePicker(); return; }
      const input = document.getElementById('chat-input');
      if (input) { input.value += x.e; input.focus(); }
      chatFxClosePicker();
    });
    emojiRow.appendChild(b);
  });
  pop.node.appendChild(emojiRow);

  pop.node.appendChild(el('div', { className: 'cfx-pop-label' }, react ? 'Naklejki' : 'Wyślij naklejkę'));
  const grid = el('div', { className: 'cfx-grid' });
  CHAT_FX_STICKERS.forEach(x => {
    const b = el('button', { className: 'cfx-grid-btn' + (mine(x.code) ? ' is-mine' : ''), type: 'button', title: x.label },
      chatFxStickerEl(x.code, 'md'), el('span', { className: 'cfx-grid-name' }, x.label));
    b.addEventListener('click', () => {
      chatFxClosePicker();
      if (react) chatFxToggle(pop.mid, x.code);
      else chatSendBody(':st:' + x.code + ':', false);
    });
    grid.appendChild(b);
  });
  pop.node.appendChild(grid);
  if (react) pop.node.appendChild(el('div', { className: 'cfx-pop-hint' }, 'Do ' + CHAT_FX_MAX_PER_MSG + ' reakcji na wiadomość. Kliknij ponownie, by cofnąć.'));
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function chatFxInjectSendBtn() {
  if (document.getElementById('cfx-send-btn')) return;
  const send = document.getElementById('chat-send-btn');
  if (!send) return;
  const btn = el('button', { id: 'cfx-send-btn', className: 'cfx-send-btn', type: 'button', title: 'Emoji i naklejki', 'aria-label': 'Emoji i naklejki' }, '😜');
  btn.addEventListener('click', e => { e.stopPropagation(); chatFxOpenPicker(btn, { mode: 'send' }); });
  send.parentNode.insertBefore(btn, send);
}

async function chatFxAttach() {
  chatFxInjectCss();
  chatFxInjectSendBtn();
  if (!chatReady) return;
  const ids = [...chatRoomMsgs, ...Object.values(chatThreads).flat()].filter(m => !m.system).map(m => m.id);
  await chatFxLoadFor(ids);
  if (!chatReady) return;
  chatRenderRoom();
  if (chatView === 'thread') chatRenderThread();
}

function chatFxPreview(m) {
  const code = chatFxStickerCode(m?.body);
  return code ? '🎭 ' + CHAT_FX_BY_CODE.get(code).label : String(m?.body || '');
}

function chatFxReset() {
  chatFxClosePicker();
  chatFxMap = new Map();
}
