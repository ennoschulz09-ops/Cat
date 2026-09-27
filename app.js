(function () {
'use strict';

/* =====================================================================
   SMART LAB – Solana Memecoin Terminal
   Module (in dieser Datei): Utils · Logger · Settings · Storage · HTTP/Data Layer ·
   Normalization · Analysis/Risk/Signal/Decision Engines · Execution · Positions ·
   Portfolio · Analytics · Backtest · Self-Optimization · Tests · UI
   Grundsätze: NO FAKE DATA · NO FAKE TRADES · NO DUPLICATE ORDERS · FAIL CLOSED
   ===================================================================== */

/* ============================== KONSTANTEN ============================== */
const APP_VERSION = '2.1.0';
const STRATEGY_VERSION = '1.0.0';
const DATA_ENGINE_VERSION = '1.0.0';
const STORAGE_KEY_V2 = 'smartlab.v2';
const STORAGE_VERSION = 3;
/* Storage logisch getrennt: Settings · Runtime · Positionen/Orders · Trades · Logs · Statistiken */
const STORAGE_KEYS = Object.freeze({ settings: 'smartlab.v3.settings', runtime: 'smartlab.v3.runtime', positions: 'smartlab.v3.positions', trades: 'smartlab.v3.trades', logs: 'smartlab.v3.logs', stats: 'smartlab.v3.stats' });
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LAMPORTS_PER_SOL = 1000000000n;
const BASE_FEE_LAMPORTS = 5000;
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const NON_MEME = new Set([WSOL, USDC, USDT]);
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DEX_API = 'https://api.dexscreener.com';
const GT_API = 'https://api.geckoterminal.com/api/v2';
const RUG_API = 'https://api.rugcheck.xyz/v1';
const GT_HEADERS = { Accept: 'application/json;version=20230302' };
const PYRAMID_MIN_PNL_PCT = 10;     // Buy #2 nur bei Gewinn (kein Averaging Down / Martingale)
const MIN_ORDER_USD = 5;

/* Unveränderliche Sicherheitsgrenzen – weder Auto-Tuning noch Import dürfen sie aufheben. */
const HARD_LIMITS = Object.freeze({
  MAX_BUYS_PER_COIN: 2,
  MIN_SELL_COOLDOWN_MIN: 15,
  MIN_LOSS_COOLDOWN_MIN: 10,
  MAX_LOSS_STREAK_LIMIT: 3,
  MIN_GLOBAL_PAUSE_MIN: 5,
  MIN_TRADES_FOR_TUNING: 20,
  MAX_EXPOSURE_PCT: 50,
  MAX_POSITION_PCT: 20
});
/* Parameter, die Self-Optimization verändern darf – nur innerhalb dieser Grenzen. */
const TUNING_BOUNDS = Object.freeze({ minScore: [55, 90], stopLossPct: [8, 25], trailPct: [8, 20] });

/* ============================== UTILS ============================== */
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = v => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const nonNeg = v => { const n = num(v); return n == null || n < 0 ? null : n; };
const int = v => { const n = num(v); return n == null || n < 0 ? null : Math.round(n); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const m2 = v => Math.round(v * 100) / 100;
const m6 = v => Math.round(v * 1e6) / 1e6;
const arr = v => (Array.isArray(v) ? v : []);
const str = (v, max = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isMint = s => typeof s === 'string' && B58.test(s);
const tokenIdOf = mint => 'solana:' + mint;
const mintOfId = id => (typeof id === 'string' && id.startsWith('solana:') ? id.slice(7) : null);
const shortAddr = a => (a && a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');
const sum = a => a.reduce((x, y) => x + y, 0);
const avg = a => (a.length ? sum(a) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const parseJSON = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
const deepClone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
const dayKeyOf = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

const esc = s => String(s).replace(/[&<>"'`]/g, c => '&#' + c.charCodeAt(0) + ';');
/* Sicheres Templating: alle Interpolationen werden escaped, außer explizit per raw() markiert. */
const RAW = Symbol('raw');
const raw = s => ({ [RAW]: String(s) });
function hv(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(hv).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += hv(vals[i]) + strings[i + 1];
  return raw(out);
}
/* URL-Validierung: nur https, keine Credentials. */
function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 600) return null;
  try {
    const x = new URL(u.trim());
    if (x.protocol !== 'https:' || x.username || x.password) return null;
    return x.href;
  } catch (e) { return null; }
}
function maskUrl(u) {
  try {
    const x = new URL(u);
    const path = x.pathname.split('/').map(p => (p.length >= 16 ? '***' : p)).join('/');
    return x.protocol + '//' + x.host + path + (x.search ? '?***' : '');
  } catch (e) { return '(ungültige URL)'; }
}
const LINKS = {
  dexscreener: (pair, mint) => 'https://dexscreener.com/solana/' + encodeURIComponent(isMint(pair) ? pair : mint),
  rugcheck: mint => 'https://rugcheck.xyz/tokens/' + encodeURIComponent(mint),
  solscanToken: mint => 'https://solscan.io/token/' + encodeURIComponent(mint),
  solscanAccount: a => 'https://solscan.io/account/' + encodeURIComponent(a),
  solscanTx: sig => 'https://solscan.io/tx/' + encodeURIComponent(sig),
  birdeye: mint => 'https://birdeye.so/token/' + encodeURIComponent(mint) + '?chain=solana',
  gecko: pair => 'https://www.geckoterminal.com/solana/pools/' + encodeURIComponent(pair),
  axiom: pair => 'https://axiom.trade/meme/' + encodeURIComponent(pair),
  xsearch: mint => 'https://x.com/search?q=' + encodeURIComponent(mint)
};

/* ---- Formatierung (Decimal Precision für sehr kleine Preise) ---- */
const SUBS = '₀₁₂₃₄₅₆₇₈₉';
function fmtPrice(p) {
  if (!isNum(p)) return '—';
  if (p === 0) return '$0';
  const a = Math.abs(p), s = p < 0 ? '-$' : '$';
  if (a >= 1000) return s + a.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return s + a.toFixed(4);
  if (a >= 0.001) return s + a.toPrecision(4);
  let e = Math.floor(Math.log10(a));
  let mant = (a / Math.pow(10, e)).toFixed(3);
  if (mant.startsWith('10')) { e += 1; mant = (a / Math.pow(10, e)).toFixed(3); }
  const zeros = -e - 1;
  const digits = mant.replace('.', '').replace(/0+$/, '') || '0';
  return s + '0.0' + String(zeros).split('').map(d => SUBS[+d]).join('') + digits;
}
function fmtUsd(n, d = 2) {
  if (!isNum(n)) return '—';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return s + '$' + (a / 1e3).toFixed(1) + 'K';
  return s + '$' + a.toFixed(d);
}
const fmtSigned = (n, f = fmtUsd) => (!isNum(n) ? '—' : (n > 0 ? '+' : '') + f(n));
function fmtPct(v, d = 1) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d) + '%' : '—'; }
function fmtNum(v, d = 0) { return isNum(v) ? v.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—'; }
function fmtAge(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  if (ms < MIN) return Math.round(ms / SEC) + 's';
  if (ms < HOUR) return Math.round(ms / MIN) + 'm';
  if (ms < DAY) return (ms / HOUR).toFixed(1) + 'h';
  return (ms / DAY).toFixed(1) + 'd';
}
const fmtTime = ts => (isNum(ts) && ts > 0 ? new Date(ts).toLocaleTimeString('de-DE', { hour12: false }) : '—');
const fmtDateTime = ts => (isNum(ts) && ts > 0 ? new Date(ts).toLocaleString('de-DE', { hour12: false }) : '—');
const isoTime = ts => (isNum(ts) ? new Date(ts).toISOString() : '');

/* ---- SOL / Lamports (exakt über BigInt) ---- */
function lamportsToSol(l) {
  const b = BigInt(l); const neg = b < 0n; const a = neg ? -b : b;
  return (neg ? '-' : '') + (a / LAMPORTS_PER_SOL).toString() + '.' + (a % LAMPORTS_PER_SOL).toString().padStart(9, '0');
}
function solToLamports(s) {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d{0,9}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * LAMPORTS_PER_SOL + BigInt((m[2] || '').padEnd(9, '0'));
}
/* Token-Rohbetrag + Decimals -> Zahl (für Anzeigen/Prozente) */
function rawToUi(amountStr, decimals) {
  if (typeof amountStr !== 'string' || !/^\d+$/.test(amountStr) || !isNum(decimals)) return null;
  const b = BigInt(amountStr), d = 10n ** BigInt(decimals);
  return Number(b / d) + Number(b % d) / Number(d);
}

/* ---- Technische Indikatoren (reine Funktionen, nur auf vorhandenen Daten) ---- */
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = sum(values.slice(0, period)) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
const ema = (values, period) => { const s = emaSeries(values, period); return s.length ? s[s.length - 1] : null; };
function sma(values, period) { if (values.length < period) return null; return sum(values.slice(-period)) / period; }
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= period; l /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let a = sum(trs.slice(0, period)) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}
function roc(values, n) { if (values.length <= n) return null; const a = values[values.length - 1 - n]; return a > 0 ? (values[values.length - 1] / a - 1) * 100 : null; }
function vwap(candles) { let pv = 0, v = 0; for (const c of candles) { pv += ((c.h + c.l + c.c) / 3) * c.v; v += c.v; } return v > 0 ? pv / v : null; }
function stdev(a) { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1)); }
function pearson(a, b) {
  const n = Math.min(a.length, b.length); if (n < 8) return null;
  const x = a.slice(-n), y = b.slice(-n), mx = avg(x), my = avg(y);
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return sx > 0 && sy > 0 ? sxy / Math.sqrt(sx * sy) : null;
}
function logReturns(p) { const r = []; for (let i = 1; i < p.length; i++) if (p[i - 1] > 0 && p[i] > 0) r.push(Math.log(p[i] / p[i - 1])); return r; }

/* ============================== LOGGER ============================== */
const LOG_LEVELS = ['DEBUG', 'INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL', 'TRADE', 'RISK', 'SECURITY'];
const SECRET_KEY_RX = /secret|private|seed|password|passphrase|api[-_]?key|authorization|mnemonic/i;
function sanitizeMeta(meta, depth = 0) {
  if (meta == null || depth > 3) return meta == null ? undefined : '[…]';
  if (typeof meta === 'string') return meta.length > 500 ? meta.slice(0, 500) + '…' : meta;
  if (typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) return meta.slice(0, 20).map(x => sanitizeMeta(x, depth + 1));
  const o = {};
  for (const k of Object.keys(meta).slice(0, 30)) o[k] = SECRET_KEY_RX.test(k) ? '***' : sanitizeMeta(meta[k], depth + 1);
  return o;
}
function createLogger(env, max = 1500) {
  const entries = []; let seq = 0; const subs = new Set();
  function log(level, category, message, meta) {
    const e = { id: ++seq, ts: env.now(), level, category, message: String(message), meta: sanitizeMeta(meta) };
    entries.push(e);
    if (entries.length > max) entries.splice(0, entries.length - max);
    subs.forEach(fn => { try { fn(e); } catch (x) { /* Listener-Fehler dürfen Logging nicht brechen */ } });
    return e;
  }
  const api = { entries, log, on: fn => { subs.add(fn); return () => subs.delete(fn); } };
  api.debug = (c, m, x) => log('DEBUG', c, m, x);
  api.info = (c, m, x) => log('INFO', c, m, x);
  api.success = (c, m, x) => log('SUCCESS', c, m, x);
  api.warn = (c, m, x) => log('WARNING', c, m, x);
  api.error = (c, m, x) => log('ERROR', c, m, x);
  api.crit = (c, m, x) => log('CRITICAL', c, m, x);
  api.trade = (m, x) => log('TRADE', 'TRADE', m, x);
  api.risk = (m, x) => log('RISK', 'RISK', m, x);
  api.sec = (m, x) => log('SECURITY', 'SECURITY', m, x);
  return api;
}

/* ============================== SETTINGS ============================== */
const SETTINGS_SCHEMA = [
  // Scanner
  { k: 'scanIntervalMs', s: 'Scanner', l: 'Scan-Intervall', t: 'int', def: 1000, min: 1000, max: 60000, u: 'ms' },
  { k: 'discoveryIntervalSec', s: 'Scanner', l: 'Discovery-Intervall (neue Tokens)', t: 'int', def: 20, min: 10, max: 600, u: 's' },
  { k: 'maxTokens', s: 'Scanner', l: 'Max. Tokens im Scanner', t: 'int', def: 150, min: 20, max: 400 },
  { k: 'chunksPerTick', s: 'Scanner', l: 'Batch-Requests pro Scan (je 30 Tokens)', t: 'int', def: 2, min: 1, max: 6 },
  { k: 'staleAfterSec', s: 'Scanner', l: 'Marktdaten gelten als STALE nach', t: 'int', def: 20, min: 5, max: 300, u: 's' },
  { k: 'securityTtlMin', s: 'Scanner', l: 'Security-Daten gültig für', t: 'int', def: 30, min: 5, max: 240, u: 'min' },
  { k: 'rpcUrls', s: 'Scanner', l: 'Solana RPC-URLs (Komma-getrennt, nur https). Für stabilen Betrieb einen eigenen Key-Provider (Helius/QuickNode/Triton/Ankr) als ersten Eintrag setzen – öffentliche Endpoints sind hart ratenlimitiert (403/Timeouts sind normal, kein Bug).', t: 'text', def: 'https://api.mainnet-beta.solana.com, https://solana-rpc.publicnode.com, https://rpc.ankr.com/solana' },
  { k: 'keepScannerOnEstop', s: 'Scanner', l: 'Scanner bei Emergency Stop weiterlaufen lassen', t: 'bool', def: true },
  // Filter
  { k: 'minLiq', s: 'Filter', l: 'Min. Liquidität', t: 'num', def: 10000, min: 0, max: 1e9, u: '$' },
  { k: 'minVol1h', s: 'Filter', l: 'Min. Volumen 1h', t: 'num', def: 20000, min: 0, max: 1e10, u: '$' },
  { k: 'minMcap', s: 'Filter', l: 'Min. Market Cap', t: 'num', def: 50000, min: 0, max: 1e11, u: '$' },
  { k: 'maxMcap', s: 'Filter', l: 'Max. Market Cap', t: 'num', def: 5000000, min: 1000, max: 1e12, u: '$' },
  { k: 'minBuyRatio', s: 'Filter', l: 'Min. Käuferanteil 1h (0–1)', t: 'num', def: 0.55, min: 0, max: 1, step: 0.01 },
  { k: 'minScore', s: 'Filter', l: 'Min. Final Score', t: 'int', def: 65, min: 40, max: 100 },
  { k: 'minPairAgeMin', s: 'Filter', l: 'Min. Pair-Alter für Auto-Buys', t: 'int', def: 10, min: 0, max: 10080, u: 'min' },
  // Risiko
  { k: 'simCapitalUsd', s: 'Risiko', l: 'Startkapital Simulation/Paper', t: 'num', def: 1000, min: 10, max: 1e7, u: '$' },
  { k: 'maxExposurePct', s: 'Risiko', l: 'Max. Portfolio-Exposure', t: 'num', def: 30, min: 1, max: HARD_LIMITS.MAX_EXPOSURE_PCT, u: '%' },
  { k: 'maxPositionPct', s: 'Risiko', l: 'Max. Positionsgröße', t: 'num', def: 5, min: 0.1, max: HARD_LIMITS.MAX_POSITION_PCT, u: '%' },
  { k: 'maxOpenPositions', s: 'Risiko', l: 'Max. offene Positionen', t: 'int', def: 3, min: 1, max: 10 },
  { k: 'dailyLossLimitPct', s: 'Risiko', l: 'Tagesverlust-Limit (Auto-Trading aus)', t: 'num', def: 10, min: 1, max: 50, u: '%' },
  { k: 'maxRiskScore', s: 'Risiko', l: 'Max. Risk Score für Käufe', t: 'int', def: 60, min: 10, max: 85 },
  { k: 'minConfidence', s: 'Risiko', l: 'Min. Data Confidence', t: 'int', def: 60, min: 40, max: 100 },
  { k: 'minSystemHealth', s: 'Risiko', l: 'Min. System Health für Trading', t: 'int', def: 60, min: 30, max: 100 },
  { k: 'requireVerifiedSecurity', s: 'Risiko', l: 'Nur VERIFIED Security (RPC + RugCheck)', t: 'bool', def: false },
  { k: 'maxBuysPerCoin', s: 'Risiko', l: 'Max. Käufe pro Coin', t: 'int', def: 2, min: 1, max: HARD_LIMITS.MAX_BUYS_PER_COIN, hard: true },
  { k: 'sellCooldownMin', s: 'Risiko', l: 'Coin-Cooldown nach Verkauf', t: 'int', def: 15, min: HARD_LIMITS.MIN_SELL_COOLDOWN_MIN, max: 1440, u: 'min', hard: true },
  { k: 'lossCooldownMin', s: 'Risiko', l: 'Loss-Cooldown (global) nach Verlust', t: 'int', def: 10, min: HARD_LIMITS.MIN_LOSS_COOLDOWN_MIN, max: 1440, u: 'min', hard: true },
  { k: 'lossStreakLimit', s: 'Risiko', l: 'Verlustserie bis globale Pause', t: 'int', def: 3, min: 1, max: HARD_LIMITS.MAX_LOSS_STREAK_LIMIT, hard: true },
  { k: 'globalPauseMin', s: 'Risiko', l: 'Globale Pause nach Verlustserie', t: 'int', def: 5, min: HARD_LIMITS.MIN_GLOBAL_PAUSE_MIN, max: 1440, u: 'min', hard: true },
  { k: 'maxTradesPerHour', s: 'Risiko', l: 'Overtrading-Limit (Käufe/Stunde)', t: 'int', def: 6, min: 1, max: 30 },
  { k: 'correlationLimit', s: 'Risiko', l: 'Korrelations-Grenze (Konzentration)', t: 'num', def: 0.85, min: 0.5, max: 1, step: 0.01 },
  { k: 'consensusMinWeight', s: 'Risiko', l: 'Min. Strategie-Konsens (Summe Gewichte)', t: 'num', def: 1.5, min: 0.5, max: 5, step: 0.1 },
  // Ausführung
  { k: 'maxSlippagePct', s: 'Ausführung', l: 'Max. Slippage / Price Impact', t: 'num', def: 3, min: 0.1, max: 25, u: '%' },
  { k: 'dexFeePct', s: 'Ausführung', l: 'DEX-Gebühr (Schätzung)', t: 'num', def: 0.25, min: 0, max: 5, step: 0.01, u: '%' },
  { k: 'priorityFeeLamports', s: 'Ausführung', l: 'Priority Fee', t: 'int', def: 100000, min: 0, max: 100000000, u: 'lamports' },
  { k: 'snapshotMaxAgeSec', s: 'Ausführung', l: 'Max. Datenalter beim Pre-Trade-Check', t: 'int', def: 5, min: 2, max: 30, u: 's' },
  { k: 'maxActiveOrders', s: 'Ausführung', l: 'Max. gleichzeitige Orders', t: 'int', def: 1, min: 1, max: 3 },
  // Exits
  { k: 'stopLossPct', s: 'Exits', l: 'Stop Loss', t: 'num', def: 15, min: 2, max: 50, u: '%' },
  { k: 'useAtrStop', s: 'Exits', l: 'ATR-Stop verwenden (wenn OHLCV vorhanden)', t: 'bool', def: true },
  { k: 'atrMult', s: 'Exits', l: 'ATR-Multiplikator', t: 'num', def: 2.5, min: 1, max: 6, step: 0.1 },
  { k: 'tp1Pct', s: 'Exits', l: 'Take Profit 1', t: 'num', def: 30, min: 2, max: 500, u: '%' },
  { k: 'tp1Frac', s: 'Exits', l: 'TP1 Verkaufsanteil (0–1)', t: 'num', def: 0.33, min: 0.05, max: 1, step: 0.01 },
  { k: 'tp2Pct', s: 'Exits', l: 'Take Profit 2', t: 'num', def: 60, min: 3, max: 1000, u: '%' },
  { k: 'tp2Frac', s: 'Exits', l: 'TP2 Verkaufsanteil (0–1)', t: 'num', def: 0.33, min: 0.05, max: 1, step: 0.01 },
  { k: 'tp3Pct', s: 'Exits', l: 'Take Profit 3 (Rest)', t: 'num', def: 120, min: 4, max: 5000, u: '%' },
  { k: 'breakEvenAfterTp1', s: 'Exits', l: 'Break-even-Stop nach TP1', t: 'bool', def: true },
  { k: 'trailActivatePct', s: 'Exits', l: 'Trailing aktiv ab Gewinn', t: 'num', def: 25, min: 1, max: 500, u: '%' },
  { k: 'trailPct', s: 'Exits', l: 'Trailing-Abstand', t: 'num', def: 12, min: 2, max: 50, u: '%' },
  { k: 'timeExitMin', s: 'Exits', l: 'Time Exit nach', t: 'int', def: 45, min: 5, max: 1440, u: 'min' },
  { k: 'timeExitMinPnlPct', s: 'Exits', l: 'Time Exit wenn PnL unter', t: 'num', def: 5, min: -50, max: 100, u: '%' },
  { k: 'timeExitAuto', s: 'Exits', l: 'Time Exit automatisch ausführen', t: 'bool', def: true },
  { k: 'exitOnRiskCritical', s: 'Exits', l: 'Exit bei kritischem Risiko', t: 'bool', def: true },
  { k: 'liqCollapsePct', s: 'Exits', l: 'Exit bei Liquiditätsabfluss ab', t: 'num', def: 40, min: 10, max: 90, u: '%' },
  { k: 'momentumReversalExit', s: 'Exits', l: 'Exit bei Momentum-Umkehr', t: 'bool', def: true },
  { k: 'estopPositionRule', s: 'Exits', l: 'Emergency Stop: offene Positionen', t: 'select', def: 'hold', opts: [['hold', 'halten & weiter überwachen'], ['close', 'alle Sim/Paper-Positionen schließen']] },
  // Alerts
  { k: 'sound', s: 'Alerts', l: 'Ton', t: 'bool', def: true },
  { k: 'vibrate', s: 'Alerts', l: 'Vibration', t: 'bool', def: true },
  { k: 'notify', s: 'Alerts', l: 'Browser-Benachrichtigungen', t: 'bool', def: true },
  { k: 'alertNewTokens', s: 'Alerts', l: 'Alarm bei neuen Tokens (gefiltert)', t: 'bool', def: false },
  { k: 'alertScore', s: 'Alerts', l: 'Alarm ab Final Score', t: 'int', def: 75, min: 40, max: 100 },
  { k: 'alertX2', s: 'Alerts', l: 'Alarm bei x2 seit Fund', t: 'bool', def: true },
  { k: 'alertCooldownMin', s: 'Alerts', l: 'Alarm-Cooldown je Token & Typ', t: 'int', def: 10, min: 1, max: 1440, u: 'min' },
  // System & Feature Flags
  { k: 'debugMode', s: 'System', l: 'Debug-Modus (verbose Logs, Decision Trace)', t: 'bool', def: false },
  { k: 'rawApiLog', s: 'System', l: 'Rohdaten der letzten API-Antworten speichern', t: 'bool', def: false },
  { k: 'ffCrossCheck', s: 'System', l: 'Feature: GeckoTerminal Cross-Check & Fallback', t: 'bool', def: true },
  { k: 'ffRugcheck', s: 'System', l: 'Feature: RugCheck-Sicherheitsdaten', t: 'bool', def: true },
  { k: 'ffHolderAnalysis', s: 'System', l: 'Feature: Holder-Analyse via RPC', t: 'bool', def: true },
  { k: 'ffShadowMode', s: 'System', l: 'Feature: Shadow Mode (deaktivierte Strategien mitrechnen)', t: 'bool', def: true },
  { k: 'ffAutoTuning', s: 'System', l: 'Feature: Safe Auto-Tuning (nur Simulation)', t: 'bool', def: false },
  { k: 'minTradesForTuning', s: 'System', l: 'Min. abgeschlossene Trades für Optimierung', t: 'int', def: 20, min: HARD_LIMITS.MIN_TRADES_FOR_TUNING, max: 1000, hard: true },
  { k: 'resetBuyCountOnSession', s: 'System', l: 'Buy-Zähler bei neuer Session zurücksetzen (nur ohne offene Position)', t: 'bool', def: true }
];
const SETTINGS_INDEX = Object.fromEntries(SETTINGS_SCHEMA.map(d => [d.k, d]));
const defaultSettings = () => Object.fromEntries(SETTINGS_SCHEMA.map(d => [d.k, d.def]));

const PROFILES = {
  Konservativ: { minLiq: 30000, minVol1h: 50000, minMcap: 100000, maxMcap: 10000000, minBuyRatio: 0.6, minScore: 75, maxRiskScore: 45, minConfidence: 70, maxPositionPct: 2, maxExposurePct: 15 },
  Ausgewogen: { minLiq: 10000, minVol1h: 20000, minMcap: 50000, maxMcap: 5000000, minBuyRatio: 0.55, minScore: 65, maxRiskScore: 60, minConfidence: 60, maxPositionPct: 5, maxExposurePct: 30 },
  Aggressiv: { minLiq: 5000, minVol1h: 10000, minMcap: 20000, maxMcap: 5000000, minBuyRatio: 0.5, minScore: 60, maxRiskScore: 70, minConfidence: 55, maxPositionPct: 5, maxExposurePct: 40 }
};

function coerceSetting(d, v) {
  if (d.t === 'bool') return typeof v === 'boolean' ? v : v === 'true' || v === 1 || v === '1' ? true : v === 'false' || v === 0 || v === '0' ? false : undefined;
  if (d.t === 'select') return d.opts.some(o => o[0] === v) ? v : undefined;
  if (d.t === 'text') {
    if (typeof v !== 'string') return undefined;
    if (d.k === 'rpcUrls') {
      const list = v.split(',').map(s => s.trim()).filter(Boolean);
      if (!list.length || list.length > 4 || list.some(u => !safeUrl(u))) return undefined;
      return list.join(', ');
    }
    return v.slice(0, 500);
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  let x = clamp(n, d.min, d.max);
  if (d.t === 'int') x = Math.round(x);
  return x;
}
/* Validierung inkl. logischer Checks. Liefert immer ein vollständiges, gültiges Settings-Objekt. */
function validateSettings(input, base) {
  const out = { ...(base || defaultSettings()) };
  const errors = [];
  if (input && typeof input === 'object') {
    for (const key of Object.keys(input)) {
      const d = SETTINGS_INDEX[key];
      if (!d) continue;
      const raw0 = input[key];
      const v = coerceSetting(d, raw0);
      if (v === undefined) { errors.push({ key, msg: `${d.l}: ungültiger Wert „${String(raw0).slice(0, 40)}“` }); continue; }
      if (d.t !== 'bool' && d.t !== 'select' && d.t !== 'text' && Number(raw0) !== v) errors.push({ key, msg: `${d.l}: auf zulässigen Bereich ${d.min}–${d.max} begrenzt (${v})`, soft: true });
      out[key] = v;
    }
  }
  const revert = (keys, msg) => { keys.forEach(k => { out[k] = (base || defaultSettings())[k]; }); errors.push({ key: keys[0], msg }); };
  if (out.minMcap > out.maxMcap) revert(['minMcap', 'maxMcap'], 'Min. Market Cap muss ≤ Max. Market Cap sein');
  if (!(out.tp1Pct < out.tp2Pct && out.tp2Pct < out.tp3Pct)) revert(['tp1Pct', 'tp2Pct', 'tp3Pct'], 'Take Profits müssen aufsteigend sein (TP1 < TP2 < TP3)');
  if (out.tp1Frac + out.tp2Frac > 1) revert(['tp1Frac', 'tp2Frac'], 'TP1- + TP2-Anteil darf 100 % nicht überschreiten');
  if (out.maxPositionPct > out.maxExposurePct) revert(['maxPositionPct'], 'Max. Positionsgröße darf Max. Exposure nicht überschreiten');
  // harte Grenzen (redundant zur Schema-Grenze, bewusst doppelt abgesichert)
  out.maxBuysPerCoin = Math.min(out.maxBuysPerCoin, HARD_LIMITS.MAX_BUYS_PER_COIN);
  out.sellCooldownMin = Math.max(out.sellCooldownMin, HARD_LIMITS.MIN_SELL_COOLDOWN_MIN);
  out.lossCooldownMin = Math.max(out.lossCooldownMin, HARD_LIMITS.MIN_LOSS_COOLDOWN_MIN);
  out.lossStreakLimit = Math.min(out.lossStreakLimit, HARD_LIMITS.MAX_LOSS_STREAK_LIMIT);
  out.globalPauseMin = Math.max(out.globalPauseMin, HARD_LIMITS.MIN_GLOBAL_PAUSE_MIN);
  out.minTradesForTuning = Math.max(out.minTradesForTuning, HARD_LIMITS.MIN_TRADES_FOR_TUNING);
  return { settings: out, errors };
}

/* ---- Strategien (Multi-Strategy, separat aktivierbar) ---- */
const STRATEGY_DEFS = [
  { id: 'momentum', name: 'Momentum', desc: 'Kurzfristiges Momentum (5m/1h) mit Käuferdominanz' },
  { id: 'breakout', name: 'Breakout', desc: 'Ausbruch über das lokale Hoch mit Volumenbestätigung' },
  { id: 'volume', name: 'Volume Expansion', desc: 'Volumen-Run-Rate deutlich über Stundenschnitt, Preis bestätigt' },
  { id: 'liquidity', name: 'Liquidity Growth', desc: 'Wachsende Pool-Liquidität bei stabilem Preis' },
  { id: 'pullback', name: 'Pullback', desc: 'Rücksetzer im Aufwärtstrend (EMA/RSI)' },
  { id: 'meanrev', name: 'Mean Reversion', desc: 'Überverkauft unter EMA mit zurückkehrenden Käufern' },
  { id: 'trend', name: 'Trend Following', desc: 'Trendfortsetzung 1h/6h/24h + EMA-Ausrichtung' }
];
function defaultStrategies() {
  const base = { weight: 1, minScore: 65, riskLimit: 60, minLiquidity: 15000, minConfidence: 60, cooldownMin: 15, positionSizePct: 2 };
  return {
    momentum: { ...base, enabled: true },
    breakout: { ...base, enabled: true },
    volume: { ...base, enabled: true, weight: 0.8 },
    liquidity: { ...base, enabled: true, weight: 0.6 },
    pullback: { ...base, enabled: false, weight: 0.8 },
    meanrev: { ...base, enabled: false, weight: 0.6, riskLimit: 50 },
    trend: { ...base, enabled: true }
  };
}
const STRATEGY_FIELDS = { weight: [0, 3], minScore: [40, 100], riskLimit: [10, 85], minLiquidity: [0, 1e9], minConfidence: [40, 100], cooldownMin: [0, 1440], positionSizePct: [0.1, HARD_LIMITS.MAX_POSITION_PCT] };
function validateStrategies(input, base) {
  const out = deepClone(base || defaultStrategies()); const errors = [];
  if (!input || typeof input !== 'object') return { strategies: out, errors };
  for (const def of STRATEGY_DEFS) {
    const src = input[def.id]; if (!src || typeof src !== 'object') continue;
    if (typeof src.enabled === 'boolean') out[def.id].enabled = src.enabled;
    for (const [f, [lo, hi]] of Object.entries(STRATEGY_FIELDS)) {
      if (!(f in src)) continue;
      const n = Number(src[f]);
      if (!Number.isFinite(n)) { errors.push({ key: def.id + '.' + f, msg: `${def.name}: ${f} ungültig` }); continue; }
      out[def.id][f] = clamp(n, lo, hi);
    }
  }
  return { strategies: out, errors };
}

/* ============================== STORAGE (versioniert + Migration) ============================== */
function createLocalBackend() {
  return {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    remove(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignorieren */ } }
  };
}
function createMemoryBackend() {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); return true; }, remove: k => { m.delete(k); }, _map: m };
}
/* Migration der alten v1-Schlüssel (c, w, fd, h) in das v2-Format. */
function migrateV1(backend) {
  const c = parseJSON(backend.get('c')), w = parseJSON(backend.get('w')), fd = parseJSON(backend.get('fd')), h = parseJSON(backend.get('h'));
  if (!c && !w && !fd && !h) return null;
  const settingsIn = {};
  if (c && typeof c === 'object') {
    if (isNum(+c.liq)) settingsIn.minLiq = +c.liq;
    if (isNum(+c.vol)) settingsIn.minVol1h = +c.vol;
    if (isNum(+c.mmin)) settingsIn.minMcap = +c.mmin;
    if (isNum(+c.mmax)) settingsIn.maxMcap = +c.mmax;
    if (isNum(+c.ratio)) settingsIn.minBuyRatio = +c.ratio;
    if (isNum(+c.score)) settingsIn.minScore = +c.score;
    if (c.sound != null) settingsIn.sound = !!+c.sound;
  }
  const watchlist = {};
  for (const a of arr(w)) if (isMint(a)) watchlist[tokenIdOf(a)] = { note: '', priority: 2, alerts: true, priceAbove: null, priceBelow: null, scoreAbove: null, addedAt: Date.now(), symbol: '' };
  const seen = {};
  if (h && typeof h === 'object') for (const [a, v] of Object.entries(h)) if (isMint(a) && v && isNum(v.mc) && isNum(v.t)) seen[tokenIdOf(a)] = { mc: v.mc, t: v.t, sym: '' };
  const feed = arr(fd).filter(f => f && isMint(f.addr)).slice(0, 60).map((f, i) => ({ id: 'v1_' + i, ts: Date.now(), type: 'LEGACY', level: 'INFO', tag: String(f.tag || 'Alarm').slice(0, 40), tokenId: tokenIdOf(f.addr), mint: f.addr, sym: str(f.sym, 24), mc: num(f.mc), detail: 'Übernommen aus Version 1 (Zeit: ' + str(f.t, 8) + ')' }));
  return { v: 2, settingsIn, watchlist, seen, feed, migratedFrom: 1 };
}
function createStorage(backend, log) {
  let lastOk = true, lastSaveAt = 0, lastError = '';
  const lastWritten = {};
  /* Lädt v3 (getrennte Schlüssel), sonst v2 (ein Schlüssel), sonst v1-Migration. */
  function load() {
    const parts = {}, corrupted = [];
    for (const [k, key] of Object.entries(STORAGE_KEYS)) {
      const raw0 = backend.get(key); if (raw0 == null) continue;
      const d = parseJSON(raw0);
      if (!d || typeof d !== 'object' || d.v !== STORAGE_VERSION) { corrupted.push(k); continue; }
      parts[k] = d; lastWritten[k] = raw0;
    }
    if (Object.keys(parts).length || corrupted.length) {
      if (corrupted.length) log && log.error('STORAGE', 'Beschädigte Speicherbereiche: ' + corrupted.join(', ') + ' – Abgleich erforderlich');
      const data = Object.assign({ v: STORAGE_VERSION }, parts.stats, parts.logs, parts.trades, parts.positions, parts.runtime, parts.settings);
      data.seqs = { runtime: parts.runtime ? parts.runtime.tradeSeq : null, positions: parts.positions ? parts.positions.tradeSeq : null, trades: parts.trades ? parts.trades.tradeSeq : null };
      return { data, corrupted };
    }
    const raw2 = backend.get(STORAGE_KEY_V2);
    if (raw2 != null) {
      const d = parseJSON(raw2);
      if (!d) { log && log.error('STORAGE', 'Gespeicherter v2-Zustand ist beschädigt (JSON) – Start mit sicheren Defaults'); return { data: null, corrupted: ['v2'] }; }
      log && log.info('STORAGE', 'Zustand aus Version 2 übernommen (wird getrennt gespeichert)');
      return { data: d, migrated: 2 };
    }
    const m = migrateV1(backend);
    if (m) { log && log.info('STORAGE', 'Daten aus Version 1 migriert (Einstellungen, Watchlist, Alarme)'); return { data: m, migrated: 1 }; }
    return { data: null };
  }
  /* Schreibt nur geänderte Bereiche. Reihenfolge: Settings → Positionen → Trades → Runtime → Logs → Stats. */
  function save(sections) {
    let ok = true;
    for (const k of ['settings', 'positions', 'trades', 'runtime', 'logs', 'stats']) {
      if (!sections[k]) continue;
      let str0;
      try { str0 = JSON.stringify({ v: STORAGE_VERSION, ...sections[k] }); } catch (e) { ok = false; lastError = 'Serialisierung fehlgeschlagen (' + k + ')'; continue; }
      if (lastWritten[k] === str0) continue;
      let w = backend.set(STORAGE_KEYS[k], str0);
      if (!w && (k === 'logs' || k === 'stats' || k === 'trades')) {
        const slim = k === 'logs' ? { ...sections.logs, logs: [], auditLog: arr(sections.logs.auditLog).slice(0, 80), feed: arr(sections.logs.feed).slice(0, 30), configLog: arr(sections.logs.configLog).slice(0, 30) }
          : k === 'stats' ? { ...sections.stats, hist: {} } : { ...sections.trades, journal: arr(sections.trades.journal).slice(0, 150) };
        str0 = JSON.stringify({ v: STORAGE_VERSION, ...slim });
        w = backend.set(STORAGE_KEYS[k], str0);
        if (w) log && log.warn('STORAGE', `Speicher knapp – ${k} rotiert`);
      }
      if (w) lastWritten[k] = str0; else { ok = false; lastError = 'localStorage nicht verfügbar oder voll'; }
    }
    if (ok && backend.get(STORAGE_KEY_V2) != null) backend.remove(STORAGE_KEY_V2);
    lastOk = ok; if (ok) lastSaveAt = Date.now();
    return ok;
  }
  function clear() { for (const key of Object.values(STORAGE_KEYS)) backend.remove(key); backend.remove(STORAGE_KEY_V2); for (const k of Object.keys(lastWritten)) delete lastWritten[k]; }
  return { load, save, status: () => ({ ok: lastOk, lastSaveAt, lastError }), clear, backend };
}

/* ============================== HTTP / DATA LAYER ==============================
   Pro Quelle: Rate Limiter (Sliding Window), Backoff (1s,2s,4s… mit Jitter nur technisch),
   Request-IDs, AbortController + Timeout, Deduplizierung laufender Requests, Cache, Health. */
const SOURCE_STATUS_CONF = { ONLINE: 100, DEGRADED: 60, STALE: 30, OFFLINE: 0, UNKNOWN: 20 };
function httpError(code, message, extra) { const e = new Error(message); e.code = code; Object.assign(e, extra || {}); return e; }
function createHttp(env, log) {
  const sources = {};
  const inflight = new Map();
  const cache = new Map();
  const controllers = new Set();
  let seq = 0;
  const statusListeners = new Set();

  function define(name, cfg) {
    if (sources[name]) { Object.assign(sources[name].cfg, cfg); return sources[name]; }
    sources[name] = {
      name, cfg: { label: name, limitPerMin: 60, timeoutMs: 8000, staleMs: 60000, ...cfg },
      reqTimes: [], results: [], latency: null, lastLatency: null, lastSuccess: 0, lastFailure: 0, lastError: '', lastStatus: null,
      consecutiveFail: 0, backoffUntil: 0, backoffStep: 0, total: 0, errors: 0, rateLimited: 0, schemaErrors: 0,
      remaining: null, resetAt: null, lastRaw: null, prevStatus: 'UNKNOWN'
    };
    return sources[name];
  }
  function remaining(name) {
    const s = sources[name]; if (!s) return 0;
    const t = env.now(); while (s.reqTimes.length && t - s.reqTimes[0] > MIN) s.reqTimes.shift();
    return Math.max(0, s.cfg.limitPerMin - s.reqTimes.length);
  }
  function status(name) {
    const s = sources[name]; if (!s) return 'UNKNOWN';
    if (s.total === 0) return 'UNKNOWN';
    if (!env.online()) return 'OFFLINE';
    if (s.consecutiveFail >= 3) return 'OFFLINE';
    const recent = s.results.slice(-20); const errRate = recent.length ? recent.filter(r => !r.ok).length / recent.length : 0;
    if (s.lastSuccess && env.now() - s.lastSuccess > s.cfg.staleMs) return s.consecutiveFail > 0 ? 'OFFLINE' : 'STALE';
    if (!s.lastSuccess) return s.consecutiveFail > 0 ? 'DEGRADED' : 'UNKNOWN';
    if (s.consecutiveFail > 0 || errRate >= 0.3 || (s.latency || 0) > 3500) return 'DEGRADED';
    return 'ONLINE';
  }
  function checkTransition(s) {
    const st = status(s.name);
    if (st !== s.prevStatus) { const prev = s.prevStatus; s.prevStatus = st; statusListeners.forEach(fn => { try { fn(s.name, prev, st); } catch (e) { /* ignorieren */ } }); }
  }
  function pushResult(s, ok, ms) { s.results.push({ ts: env.now(), ok, ms }); if (s.results.length > 60) s.results.shift(); }
  function onSuccess(s, ms) {
    s.total++; s.consecutiveFail = 0; s.backoffStep = 0; s.backoffUntil = 0; s.lastSuccess = env.now(); s.lastLatency = ms;
    s.latency = s.latency == null ? ms : s.latency * 0.7 + ms * 0.3; pushResult(s, true, ms); checkTransition(s);
  }
  function onFail(s, msg, ms, opts = {}) {
    s.total++; s.errors++; s.consecutiveFail++; s.lastFailure = env.now(); s.lastError = msg; pushResult(s, false, ms || 0);
    s.backoffStep = Math.min(s.backoffStep + 1, 7);
    let wait = Math.min(1000 * Math.pow(2, s.backoffStep - 1), 60000);
    if (opts.retryAfterMs) wait = Math.max(wait, opts.retryAfterMs);
    if (opts.rateLimited) { s.rateLimited++; wait = Math.max(wait, 10000); }
    // Jitter nur zur technischen Streuung von Retries – niemals für Handelsentscheidungen.
    wait = Math.round(wait * (0.9 + env.random() * 0.2));
    s.backoffUntil = env.now() + wait;
    checkTransition(s);
  }
  async function request(name, url, opts = {}) {
    const s = sources[name] || define(name, {});
    const method = opts.method || 'GET';
    const key = method + ' ' + url + (opts.body ? ' ' + opts.body : '');
    if (opts.cacheMs && !opts.noCache) {
      const c = cache.get(key);
      if (c && env.now() - c.ts < opts.cacheMs) return { data: c.data, cached: true, fetchedAt: c.ts, requestId: c.rid, ms: 0 };
    }
    if (inflight.has(key)) return inflight.get(key);
    if (!env.online()) throw httpError('OFFLINE', 'Keine Netzwerkverbindung (Offline)');
    if (env.now() < s.backoffUntil) throw httpError('BACKOFF', `${s.cfg.label}: Backoff aktiv (noch ${Math.ceil((s.backoffUntil - env.now()) / 1000)}s)`);
    if (remaining(name) <= 0) { s.rateLimited++; throw httpError('RATE_LIMIT_LOCAL', `${s.cfg.label}: lokales Rate-Limit erreicht (${s.cfg.limitPerMin}/min)`); }
    s.reqTimes.push(env.now());
    const rid = ++seq; const startedAt = env.now();
    const p = (async () => {
      const ctrl = new AbortController(); controllers.add(ctrl);
      let timedOut = false;
      const timer = env.setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs || s.cfg.timeoutMs);
      const onExtAbort = () => ctrl.abort();
      if (opts.signal) { if (opts.signal.aborted) ctrl.abort(); else opts.signal.addEventListener('abort', onExtAbort, { once: true }); }
      let res;
      try {
        res = await env.fetch(url, { method, headers: opts.headers, body: opts.body, signal: ctrl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      } catch (e) {
        const ms = env.now() - startedAt;
        let err;
        if (timedOut) err = httpError('TIMEOUT', `${s.cfg.label}: Timeout nach ${Math.round((opts.timeoutMs || s.cfg.timeoutMs) / 1000)}s`);
        else if (ctrl.signal.aborted) err = httpError('ABORTED', `${s.cfg.label}: Request abgebrochen`);
        else err = httpError('NETWORK', `${s.cfg.label}: Netzwerk-/CORS-Fehler (${str(e && e.message, 80) || 'fetch failed'})`);
        if (err.code !== 'ABORTED') onFail(s, err.message, ms);
        throw err;
      } finally {
        env.clearTimeout(timer); controllers.delete(ctrl);
        if (opts.signal) opts.signal.removeEventListener('abort', onExtAbort);
      }
      const ms = env.now() - startedAt;
      try {
        const rem = res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : null;
        const reset = res.headers && res.headers.get ? res.headers.get('x-ratelimit-reset') : null;
        if (rem != null && isNum(+rem)) s.remaining = +rem;
        if (reset != null && isNum(+reset)) s.resetAt = +reset > 1e12 ? +reset : +reset > 1e9 ? +reset * 1000 : env.now() + +reset * 1000;
      } catch (e) { /* Header nicht lesbar (CORS) */ }
      s.lastStatus = res.status;
      if (res.status === 429) {
        let ra = null; try { ra = res.headers && res.headers.get ? num(res.headers.get('retry-after')) : null; } catch (e) { /* */ }
        const err = httpError('HTTP_429', `${s.cfg.label}: Rate Limit (HTTP 429)`);
        onFail(s, err.message, ms, { rateLimited: true, retryAfterMs: ra ? ra * 1000 : 0 }); throw err;
      }
      if (!res.ok) {
        const err = httpError('HTTP_' + res.status, `${s.cfg.label}: HTTP ${res.status}${res.status >= 500 ? ' (Serverfehler)' : ''}`);
        onFail(s, err.message, ms); throw err;
      }
      let text;
      try { text = await res.text(); } catch (e) { const err = httpError('READ', `${s.cfg.label}: Antwort nicht lesbar`); onFail(s, err.message, ms); throw err; }
      let data;
      try { data = JSON.parse(text); } catch (e) { s.schemaErrors++; const err = httpError('BAD_JSON', `${s.cfg.label}: ungültiges JSON`); onFail(s, err.message, ms); throw err; }
      if (opts.validate) {
        const v = opts.validate(data);
        if (v) { s.schemaErrors++; const err = httpError('SCHEMA', `${s.cfg.label}: ${v}`); onFail(s, err.message, ms); throw err; }
      }
      onSuccess(s, ms);
      if (opts.keepRaw) s.lastRaw = { ts: env.now(), url: opts.maskInLog ? maskUrl(url) : url, sample: text.slice(0, 4000) };
      if (opts.cacheMs) { cache.set(key, { ts: startedAt, data, rid }); if (cache.size > 300) cache.delete(cache.keys().next().value); }
      return { data, cached: false, fetchedAt: startedAt, requestId: rid, ms };
    })();
    inflight.set(key, p);
    p.then(() => inflight.delete(key), () => inflight.delete(key));
    return p;
  }
  function abortAll() { controllers.forEach(c => { try { c.abort(); } catch (e) { /* */ } }); controllers.clear(); }
  function snapshot(name) {
    const s = sources[name]; if (!s) return null;
    const recent = s.results.slice(-30);
    return {
      name, label: s.cfg.label, status: status(name), latency: s.latency, lastLatency: s.lastLatency, lastSuccess: s.lastSuccess, lastFailure: s.lastFailure,
      lastError: s.lastError, errorRate: recent.length ? recent.filter(r => !r.ok).length / recent.length : null, total: s.total, errors: s.errors,
      rateLimited: s.rateLimited, limitPerMin: s.cfg.limitPerMin, used: s.cfg.limitPerMin - remaining(name), backoffUntil: s.backoffUntil,
      resetAt: s.resetAt, remainingHdr: s.remaining, dataAge: s.lastSuccess ? env.now() - s.lastSuccess : null, lastStatus: s.lastStatus,
      confidence: SOURCE_STATUS_CONF[status(name)], lastRaw: s.lastRaw, kind: s.cfg.kind || 'api', schemaErrors: s.schemaErrors
    };
  }
  return {
    define, request, remaining, status, snapshot, abortAll, sources,
    names: () => Object.keys(sources),
    onStatus: fn => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    tick: () => Object.values(sources).forEach(checkTransition),
    clearCache: () => cache.clear(),
    inflightCount: () => inflight.size,
    _recordSuccess: (name, ms = 100) => onSuccess(sources[name] || define(name, {}), ms)
  };
}

/* ============================== NORMALIZATION LAYER ==============================
   Alle Quellen -> einheitlicher MarketSnapshot. Fehlende Werte = null (nie erfunden). */
function normTxn(t) { return t && typeof t === 'object' ? { b: int(t.buys), s: int(t.sells) } : null; }
function normLinks(list, typeKey) {
  const out = [];
  for (const l of arr(list)) {
    if (!l || typeof l !== 'object') continue;
    const u = safeUrl(l.url); if (!u) continue;
    const type = str(l[typeKey] || l.type || '', 20).toLowerCase() || 'website';
    out.push({ type, label: str(l.label, 30) || type, url: u });
  }
  return out;
}
function normDexPair(p, fetchedAt) {
  if (!p || typeof p !== 'object' || p.chainId !== 'solana') return null;
  const bt = p.baseToken && typeof p.baseToken === 'object' ? p.baseToken : {};
  const mint = bt.address;
  if (!isMint(mint)) return null;
  const vol = p.volume || {}, ch = p.priceChange || {}, lq = p.liquidity || {}, tx = p.txns || {}, info = p.info || {};
  const price = nonNeg(p.priceUsd);
  const priceRaw = typeof p.priceUsd === 'string' && /^\d+(\.\d+)?([eE]-?\d+)?$/.test(p.priceUsd) ? p.priceUsd : null;
  return {
    source: 'dexscreener', id: tokenIdOf(mint), mint,
    symbol: str(bt.symbol, 24) || '?', name: str(bt.name, 64),
    pairAddress: isMint(p.pairAddress) ? p.pairAddress : null, dexId: str(p.dexId, 24) || null, url: safeUrl(p.url),
    quoteSymbol: str((p.quoteToken || {}).symbol, 12) || null,
    priceUsd: price && price > 0 ? price : null, priceRaw: price && price > 0 ? priceRaw : null, priceNative: nonNeg(p.priceNative),
    marketCap: nonNeg(p.marketCap), fdv: nonNeg(p.fdv), liquidityUsd: nonNeg(lq.usd),
    vol: { m5: nonNeg(vol.m5), h1: nonNeg(vol.h1), h6: nonNeg(vol.h6), h24: nonNeg(vol.h24) },
    chg: { m5: num(ch.m5), h1: num(ch.h1), h6: num(ch.h6), h24: num(ch.h24) },
    txns: { m5: normTxn(tx.m5), h1: normTxn(tx.h1), h6: normTxn(tx.h6), h24: normTxn(tx.h24) },
    pairCreatedAt: nonNeg(p.pairCreatedAt), boostsActive: int((p.boosts || {}).active) || 0,
    links: [...normLinks(info.websites, 'label').map(l => ({ ...l, type: 'website' })), ...normLinks(info.socials, 'type')],
    fetchedAt
  };
}
function normGtPool(item, fetchedAt) {
  if (!item || typeof item !== 'object' || !item.attributes) return null;
  const a = item.attributes, rel = item.relationships || {};
  const baseId = ((rel.base_token || {}).data || {}).id;
  const mint = typeof baseId === 'string' && baseId.startsWith('solana_') ? baseId.slice(7) : null;
  if (!isMint(mint) || NON_MEME.has(mint)) return null;
  const name = str(a.name, 80);
  const v = a.volume_usd || {}, c = a.price_change_percentage || {}, tx = a.transactions || {};
  const price = nonNeg(a.base_token_price_usd);
  const created = typeof a.pool_created_at === 'string' ? Date.parse(a.pool_created_at) : NaN;
  return {
    source: 'geckoterminal', id: tokenIdOf(mint), mint, symbol: (name.split('/')[0] || '').trim().slice(0, 24) || '?', name,
    pairAddress: isMint(a.address) ? a.address : null, dexId: str(((rel.dex || {}).data || {}).id, 24) || null, url: null, quoteSymbol: null,
    priceUsd: price && price > 0 ? price : null, priceRaw: null, priceNative: null,
    marketCap: nonNeg(a.market_cap_usd), fdv: nonNeg(a.fdv_usd), liquidityUsd: nonNeg(a.reserve_in_usd),
    vol: { m5: nonNeg(v.m5), m15: nonNeg(v.m15), h1: nonNeg(v.h1), h6: nonNeg(v.h6), h24: nonNeg(v.h24) },
    chg: { m5: num(c.m5), m15: num(c.m15), h1: num(c.h1), h6: num(c.h6), h24: num(c.h24) },
    txns: { m5: normTxn(tx.m5), m15: normTxn(tx.m15), h1: normTxn(tx.h1), h24: normTxn(tx.h24) },
    pairCreatedAt: Number.isFinite(created) ? created : null, boostsActive: 0, links: [], fetchedAt
  };
}
function normOhlcv(data) {
  const list = arr(((data || {}).data || {}).attributes ? data.data.attributes.ohlcv_list : null);
  const seen = new Set(); const out = [];
  for (const r of list) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [t, o, h, l, c, v] = r.map(Number);
    if (![t, o, h, l, c, v].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0 || h < l) continue;
    const ts = t < 1e12 ? t * 1000 : t;
    if (seen.has(ts)) continue; seen.add(ts);
    out.push({ t: ts, o, h, l, c, v });
  }
  return out.sort((a, b) => a.t - b.t);
}
function normMintAccount(result) {
  if (!result || typeof result !== 'object' || !('value' in result)) return null;
  const v = result.value;
  if (v === null) return { exists: false };
  const parsed = v && v.data && v.data.parsed;
  if (!parsed || parsed.type !== 'mint' || !parsed.info) return null;
  const i = parsed.info;
  const auth = x => (x === null ? null : typeof x === 'string' && isMint(x) ? x : undefined);
  return {
    exists: true,
    program: v.owner === TOKEN_2022_PROGRAM ? 'token-2022' : v.owner === TOKEN_PROGRAM ? 'spl-token' : 'unbekannt',
    mintAuthority: 'mintAuthority' in i ? auth(i.mintAuthority) : undefined,
    freezeAuthority: 'freezeAuthority' in i ? auth(i.freezeAuthority) : undefined,
    decimals: int(i.decimals),
    supply: typeof i.supply === 'string' && /^\d+$/.test(i.supply) ? i.supply : null,
    extensions: arr(i.extensions).map(e => ({ ext: str(e && e.extension, 40), state: e && e.state && typeof e.state === 'object' ? e.state : null })).filter(e => e.ext)
  };
}
function normLargest(result, supplyStr) {
  const list = arr(result && result.value);
  if (!list.length || typeof supplyStr !== 'string' || !/^\d+$/.test(supplyStr)) return null;
  const supply = BigInt(supplyStr); if (supply <= 0n) return null;
  const amounts = list.map(x => (x && typeof x.amount === 'string' && /^\d+$/.test(x.amount) ? BigInt(x.amount) : null)).filter(x => x != null);
  if (!amounts.length) return null;
  const pct = b => Number((b * 1000000n) / supply) / 10000;
  const top10 = amounts.slice(0, 10).reduce((a, b) => a + b, 0n);
  return { top1Pct: pct(amounts[0]), top10Pct: pct(top10), accounts: list.slice(0, 10).map((x, i) => ({ address: isMint(x.address) ? x.address : null, pct: amounts[i] != null ? pct(amounts[i]) : null })), note: 'inkl. Pool-/LP-Konten' };
}
function normRug(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const risks = arr(d.risks).map(r => ({ name: str(r && r.name, 80), level: str(r && r.level, 12).toLowerCase(), value: str(r && r.value, 40), desc: str(r && r.description, 200), score: num(r && r.score) })).filter(r => r.name);
  const tok = d.token && typeof d.token === 'object' ? d.token : null;
  const auth = (o, k) => (o && k in o ? (o[k] === null ? null : isMint(o[k]) ? o[k] : undefined) : undefined);
  return {
    score: num(d.score), scoreNorm: num(d.score_normalised), risks, lpLockedPct: num(d.lpLockedPct),
    rugged: typeof d.rugged === 'boolean' ? d.rugged : null,
    mintAuthority: tok ? auth(tok, 'mintAuthority') : auth(d, 'mintAuthority'),
    freezeAuthority: tok ? auth(tok, 'freezeAuthority') : auth(d, 'freezeAuthority'),
    topHolders: arr(d.topHolders).slice(0, 10).map(h => ({ address: isMint(h && h.address) ? h.address : null, pct: num(h && h.pct), insider: !!(h && h.insider) })),
    totalHolders: int(d.totalHolders), creator: isMint(d.creator) ? d.creator : null, tokenProgram: str(d.tokenProgram, 60) || null
  };
}
/* Security Engine: kombiniert On-Chain-Mint-Daten (RPC), Holder-Konzentration und RugCheck. Keine Sicherheitsgarantie. */
const CRITICAL_RISK_RX = /freeze authority|mint authority|permanent delegate|transfer fee|honeypot|rugged|non.?transferable/i;
function buildSecurity(mintInfo, holders, rug, now) {
  const flags = []; const f = (code, level, msg) => flags.push({ code, level, msg });
  const src = { rpc: !!(mintInfo && mintInfo.exists), rug: !!rug, holders: !!holders };
  let mintA = 'UNKNOWN', freezeA = 'UNKNOWN';
  const fromVal = v => (v === null ? 'REVOKED' : typeof v === 'string' ? 'ACTIVE' : 'UNKNOWN');
  if (src.rpc) { mintA = fromVal(mintInfo.mintAuthority); freezeA = fromVal(mintInfo.freezeAuthority); }
  if (rug) { if (mintA === 'UNKNOWN') mintA = fromVal(rug.mintAuthority); if (freezeA === 'UNKNOWN') freezeA = fromVal(rug.freezeAuthority); }
  if (mintInfo && mintInfo.exists === false) f('MINT_NOT_FOUND', 'CRITICAL', 'Mint-Account on-chain nicht gefunden');
  if (mintA === 'ACTIVE') f('MINT_AUTHORITY', 'CRITICAL', 'Mint Authority aktiv – Supply kann erhöht werden');
  if (freezeA === 'ACTIVE') f('FREEZE_AUTHORITY', 'CRITICAL', 'Freeze Authority aktiv – Konten können eingefroren werden');
  for (const e of (mintInfo && mintInfo.extensions) || []) {
    const n = e.ext.toLowerCase();
    if (n.includes('permanentdelegate')) f('PERMANENT_DELEGATE', 'CRITICAL', 'Token-2022: Permanent Delegate (Token können entzogen werden)');
    else if (n.includes('nontransferable')) f('NON_TRANSFERABLE', 'CRITICAL', 'Token-2022: nicht übertragbar');
    else if (n.includes('transferhook')) f('TRANSFER_HOOK', 'HIGH', 'Token-2022: Transfer Hook (Verkauf kann eingeschränkt sein)');
    else if (n.includes('transferfee')) f('TRANSFER_FEE', 'HIGH', 'Token-2022: Transfer-Gebühr');
    else if (n.includes('defaultaccountstate')) f('DEFAULT_FROZEN', 'HIGH', 'Token-2022: Default Account State');
  }
  if (rug) {
    if (rug.rugged === true) f('RUGGED', 'CRITICAL', 'RugCheck: als „rugged“ markiert');
    for (const r of rug.risks) {
      if (r.level === 'danger') f('RUG_' + r.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30), CRITICAL_RISK_RX.test(r.name) ? 'CRITICAL' : 'HIGH', 'RugCheck: ' + r.name + (r.value ? ' (' + r.value + ')' : ''));
      else if (r.level === 'warn') f('RUG_WARN', 'WARN', 'RugCheck: ' + r.name + (r.value ? ' (' + r.value + ')' : ''));
    }
    if (isNum(rug.lpLockedPct) && rug.lpLockedPct < 50) f('LP_UNLOCKED', 'WARN', `LP nur ${rug.lpLockedPct.toFixed(0)}% gesperrt/verbrannt`);
  }
  let top10 = holders ? holders.top10Pct : null, top1 = holders ? holders.top1Pct : null, holderSrc = holders ? 'RPC (inkl. Pool-Konten)' : null;
  if (top10 == null && rug && rug.topHolders.length) { const p = rug.topHolders.map(h => h.pct).filter(isNum); if (p.length) { top10 = sum(p.slice(0, 10)); top1 = p[0]; holderSrc = 'RugCheck'; } }
  if (isNum(top10) && top10 > 60) f('HOLDER_CONCENTRATION', 'HIGH', `Top-10-Holder halten ${top10.toFixed(1)}% (${holderSrc})`);
  else if (isNum(top10) && top10 > 40) f('HOLDER_CONCENTRATION', 'WARN', `Top-10-Holder halten ${top10.toFixed(1)}% (${holderSrc})`);
  const critical = flags.some(x => x.level === 'CRITICAL');
  const authoritiesKnown = mintA !== 'UNKNOWN' && freezeA !== 'UNKNOWN';
  let status;
  if (critical) status = 'CRITICAL';
  else if (src.rpc && src.rug && authoritiesKnown) status = 'VERIFIED';
  else if ((src.rpc || src.rug) && authoritiesKnown) status = 'PARTIAL';
  else status = 'UNKNOWN';
  return {
    status, mintAuthority: mintA, freezeAuthority: freezeA, program: mintInfo && mintInfo.program || (rug && rug.tokenProgram) || null,
    decimals: mintInfo && mintInfo.decimals, supply: mintInfo && mintInfo.supply,
    flags, top10Pct: top10, top1Pct: top1, holderSrc, holderAccounts: holders ? holders.accounts : null,
    rugScoreNorm: rug ? rug.scoreNorm : null, rugRisks: rug ? rug.risks : [], lpLockedPct: rug ? rug.lpLockedPct : null,
    totalHolders: rug ? rug.totalHolders : null, creator: rug ? rug.creator : null, sources: src, checkedAt: now
  };
}

/* ============================== BLOCKER SYSTEM ==============================
   Priorität (Safety Priority): EMERGENCY → SYSTEM → DATA → SECURITY → PORTFOLIO → LIMITS → COOLDOWN → EXECUTION → STRATEGY → SIGNAL */
const BLOCKER_DEFS = {
  EMERGENCY_STOP: [0, 'EMERGENCY', 'Emergency Stop aktiv'],
  LIVE_UNAVAILABLE: [1, 'SYSTEM', 'Live-Ausführung nicht verfügbar'],
  MODE_READ_ONLY: [1, 'SYSTEM', 'READ-ONLY-Modus'],
  SAFE_MODE: [1, 'SYSTEM', 'Safe Mode aktiv'],
  AUTO_TRADING_OFF: [1, 'SYSTEM', 'Auto-Trading aus'],
  PAPER_MANUAL: [1, 'SYSTEM', 'PAPER: nur manuelle Trades'],
  BOT_NOT_RUNNING: [1, 'SYSTEM', 'Bot läuft nicht'],
  RECOVERING: [1, 'SYSTEM', 'System im Recovery'],
  SYSTEM_UNHEALTHY: [1, 'SYSTEM', 'System Health zu niedrig'],
  OFFLINE: [1, 'SYSTEM', 'Offline'],
  RECONCILIATION_REQUIRED: [1, 'SYSTEM', 'Abgleich erforderlich (Reconciliation)'],
  SECURITY_SOURCES_DOWN: [1, 'SYSTEM', 'Alle Security-Quellen offline'],
  PRICE_MISSING: [2, 'DATA', 'Preis fehlt'],
  DATA_STALE: [2, 'DATA', 'Daten veraltet'],
  DATA_FALLBACK: [2, 'DATA', 'Nur Fallback-Daten'],
  DATA_CONFLICT: [2, 'DATA', 'Datenkonflikt'],
  CONFIDENCE_LOW: [2, 'DATA', 'Data Confidence zu niedrig'],
  FEE_UNKNOWN: [2, 'DATA', 'Gebühren unbekannt (SOL-Preis fehlt)'],
  SECURITY_CRITICAL: [3, 'SECURITY', 'Kritisches Sicherheitsrisiko'],
  SECURITY_UNKNOWN: [3, 'SECURITY', 'Sicherheitsstatus unbekannt'],
  SECURITY_UNVERIFIED: [3, 'SECURITY', 'Security nicht voll verifiziert'],
  SECURITY_STALE: [3, 'SECURITY', 'Security-Daten veraltet'],
  RISK_TOO_HIGH: [3, 'SECURITY', 'Risiko zu hoch'],
  PUMP_DETECTED: [3, 'SECURITY', 'Pump/Manipulation erkannt'],
  LOW_LIQUIDITY: [3, 'SECURITY', 'Liquidität zu niedrig'],
  THIN_LIQUIDITY: [3, 'SECURITY', 'Liquidität im Verhältnis zur MCap zu dünn'],
  LIQUIDITY_SHOCK: [3, 'SECURITY', 'Liquiditätsabfluss'],
  DAILY_LOSS_LIMIT: [4, 'PORTFOLIO', 'Tagesverlust-Limit erreicht'],
  EXPOSURE_LIMIT: [4, 'PORTFOLIO', 'Max. Exposure erreicht'],
  CONCENTRATION: [4, 'PORTFOLIO', 'Konzentrationsrisiko'],
  MAX_POSITIONS: [5, 'LIMITS', 'Max. offene Positionen'],
  BUY_LIMIT_REACHED: [5, 'LIMITS', 'Buy-Limit pro Coin erreicht'],
  NO_AVERAGING_DOWN: [5, 'LIMITS', 'Kein Nachkauf im Verlust'],
  COOLDOWN_ACTIVE: [6, 'COOLDOWN', 'Coin-Cooldown aktiv'],
  LOSS_COOLDOWN: [6, 'COOLDOWN', 'Loss-Cooldown aktiv'],
  GLOBAL_PAUSE: [6, 'COOLDOWN', 'Globale Pause (Verlustserie)'],
  OVERTRADING: [6, 'COOLDOWN', 'Overtrading-Schutz'],
  STRATEGY_COOLDOWN: [6, 'COOLDOWN', 'Strategie-Cooldown'],
  TRADE_LOCKED: [7, 'EXECUTION', 'Token/Order gesperrt (laufende Aktion)'],
  DUPLICATE_ORDER: [7, 'EXECUTION', 'Doppelte Order verhindert'],
  MAX_ACTIVE_ORDERS: [7, 'EXECUTION', 'Max. gleichzeitige Orders'],
  SLIPPAGE_TOO_HIGH: [7, 'EXECUTION', 'Slippage/Price Impact zu hoch'],
  SIZE_ZERO: [7, 'EXECUTION', 'Positionsgröße 0'],
  INSUFFICIENT_CASH: [7, 'EXECUTION', 'Nicht genug (virtuelles) Kapital'],
  MCAP_RANGE: [8, 'STRATEGY', 'Market Cap außerhalb Bereich'],
  LOW_VOLUME: [8, 'STRATEGY', 'Volumen zu niedrig'],
  BUYER_RATIO: [8, 'STRATEGY', 'Käuferanteil zu niedrig'],
  PAIR_TOO_NEW: [8, 'STRATEGY', 'Pair zu neu / Alter unbekannt'],
  SCORE_TOO_LOW: [8, 'STRATEGY', 'Score zu niedrig'],
  NO_CONSENSUS: [8, 'STRATEGY', 'Kein Strategie-Konsens'],
  NO_SIGNAL: [9, 'SIGNAL', 'Kein Kaufsignal']
};
function mkBlocker(code, msg, extra) {
  const d = BLOCKER_DEFS[code] || [9, 'OTHER', code];
  return { code, prio: d[0], cat: d[1], msg: msg || d[2], ...(extra || {}) };
}
function sortBlockers(list) {
  const seen = new Set(); const out = [];
  for (const b of [...list].sort((a, b) => a.prio - b.prio)) { if (seen.has(b.code)) continue; seen.add(b.code); out.push(b); }
  return out;
}

/* ============================== ANALYSE-ENGINES ============================== */
function effectiveSnap(tok, now, S) {
  const staleMs = S.staleAfterSec * SEC;
  const p = tok.snap, a = tok.alt;
  const pAge = p ? now - p.fetchedAt : Infinity, aAge = a ? now - a.fetchedAt : Infinity;
  if (p && isNum(p.priceUsd) && pAge <= staleMs) return { snap: p, label: p.cached ? 'CACHED' : 'LIVE', age: pAge, fallback: false };
  if (a && isNum(a.priceUsd) && aAge <= staleMs) return { snap: a, label: 'FALLBACK', age: aAge, fallback: true };
  if (p) return { snap: p, label: pAge <= staleMs ? 'LIVE' : 'STALE', age: pAge, fallback: false };
  if (a) return { snap: a, label: 'STALE', age: aAge, fallback: true };
  return { snap: null, label: 'UNKNOWN', age: null, fallback: false };
}
function histAgo(hist, now, agoMs, tolMs) {
  const target = now - agoMs; let best = null, bd = Infinity;
  for (let i = hist.length - 1; i >= 0; i--) {
    const d = Math.abs(hist[i].t - target);
    if (d < bd) { bd = d; best = hist[i]; }
    if (hist[i].t < target - tolMs) break;
  }
  return best && bd <= tolMs ? best : null;
}
function ageClass(ms) { if (!isNum(ms)) return 'UNKNOWN'; if (ms < HOUR) return 'NEW'; if (ms < DAY) return 'EARLY'; if (ms < 7 * DAY) return 'ESTABLISHED'; return 'MATURE'; }
const W_RISK = { liquidity: 0.15, holder: 0.1, creator: 0.05, contract: 0.2, marketStructure: 0.12, volumeAnomaly: 0.08, sellPressure: 0.1, dataReliability: 0.1, execution: 0.1 };
const W_SCORE = { market: 0.08, momentum: 0.16, liquidity: 0.14, volume: 0.12, holders: 0.06, security: 0.14, trend: 0.12, data: 0.1, execution: 0.08 };
const RISK_NAMES = { liquidity: 'Liquidity Risk', holder: 'Holder Risk', creator: 'Creator Risk', contract: 'Contract Risk', marketStructure: 'Market Structure Risk', volumeAnomaly: 'Volume Anomaly Risk', sellPressure: 'Sell Pressure Risk', dataReliability: 'Data Reliability Risk', execution: 'Execution Risk' };
const COMP_NAMES = { market: 'MARKET', momentum: 'MOMENTUM', liquidity: 'LIQUIDITY', volume: 'VOLUME', trend: 'TREND', security: 'SECURITY', holders: 'HOLDERS', data: 'DATA QUALITY', execution: 'EXECUTION' };
/* Kontext-Signale beschreiben den Markt, sind aber allein kein Kaufsignal. */
const CONTEXT_SIGNALS = new Set(['VOLATILITY_EXPANSION', 'VOLATILITY_COMPRESSION', 'WHALE_ACTIVITY']);
const SIGNAL_NAMES = { MOMENTUM: 'Momentum', BREAKOUT: 'Breakout', VOLUME_EXPANSION: 'Volume Expansion', LIQUIDITY_GROWTH: 'Liquidity Growth', BUYER_DOMINANCE: 'Buyer Dominance', TREND_CONTINUATION: 'Trend Continuation', RECOVERY: 'Recovery', MEAN_REVERSION: 'Mean Reversion', VOLATILITY_EXPANSION: 'Volatility Expansion', VOLATILITY_COMPRESSION: 'Volatility Compression', WHALE_ACTIVITY: 'Whale Activity', NEW_PAIR_MOMENTUM: 'New Pair Momentum', PULLBACK: 'Pullback' };

/* Vollanalyse eines Tokens. Rein funktional: nutzt nur übergebene, reale Daten. Kein Math.random. */
function analyzeToken(tok, ctx) {
  const { now, S } = ctx;
  const es = effectiveSnap(tok, now, S);
  const s = es.snap;
  const A = { ts: now, label: es.label, dataAge: es.age, fallback: es.fallback, stale: es.label === 'STALE' || es.label === 'UNKNOWN', unknowns: [], tags: [], flags: [] };
  const price = s && isNum(s.priceUsd) ? s.priceUsd : null;
  const liq = s ? s.liquidityUsd : null;
  const mc = s ? (s.marketCap != null ? s.marketCap : s.fdv) : null;
  const v = s ? s.vol : {}, ch = s ? s.chg : {};
  const t5 = s && s.txns ? s.txns.m5 : null, t1 = s && s.txns ? s.txns.h1 : null;
  const hist = tok.hist || [];
  const prices = hist.map(x => x.p);
  const pairAge = s && isNum(s.pairCreatedAt) ? now - s.pairCreatedAt : null;
  A.core = { price, priceRaw: s ? s.priceRaw : null, liq, mc, fdv: s ? s.fdv : null, pairAge, source: s ? s.source : null, dexId: s ? s.dexId : null, pairAddress: (s && s.pairAddress) || (tok.snap && tok.snap.pairAddress) || (tok.alt && tok.alt.pairAddress) || null, fetchedAt: s ? s.fetchedAt : null };

  /* --- Liquidity Engine --- */
  const h1m = histAgo(hist, now, MIN, 30 * SEC), h5 = histAgo(hist, now, 5 * MIN, 90 * SEC), h15 = histAgo(hist, now, 15 * MIN, 3 * MIN);
  const chgOf = (a, b) => (isNum(a) && isNum(b) && b > 0 ? (a / b - 1) * 100 : null);
  const ratioMc = isNum(liq) && isNum(mc) && mc > 0 ? liq / mc : null;
  const plannedSize = ctx.plannedSizeUsd || 0;
  const impactPlanned = isNum(liq) && liq > 0 && plannedSize > 0 ? plannedSize / (liq / 2 + plannedSize) * 100 : null;
  A.liq = {
    usd: liq, ratioMc, chg5: h5 ? chgOf(liq, h5.liq) : null, chg15: h15 ? chgOf(liq, h15.liq) : null,
    exitLiqUsd: isNum(liq) ? liq / 2 : null, impactPlanned,
    slipRisk: impactPlanned == null ? 'UNKNOWN' : impactPlanned < 1 ? 'LOW' : impactPlanned < S.maxSlippagePct ? 'MODERATE' : 'HIGH'
  };
  A.liq.shock = A.liq.chg5 != null && A.liq.chg5 <= -20;
  A.liq.spike = A.liq.chg5 != null && A.liq.chg5 >= 50;

  /* --- Price Engine --- */
  const recent = hist.filter(x => now - x.t <= 30 * MIN);
  const hi = recent.length ? Math.max(...recent.map(x => x.p)) : null;
  const lo = recent.length ? Math.min(...recent.map(x => x.p)) : null;
  const rets = logReturns(prices.slice(-80));
  const volMeasured = rets.length >= 10 ? stdev(rets) * Math.sqrt(12) * 100 : null;
  const volPct = volMeasured != null ? volMeasured : isNum(ch.m5) ? Math.abs(ch.m5) / Math.sqrt(5) : null;
  const m1 = h1m && price ? chgOf(price, h1m.p) : null;
  const m15 = isNum(ch.m15) ? ch.m15 : h15 && price ? chgOf(price, h15.p) : null;
  const emaF = prices.length >= 12 ? ema(prices, 12) : null, emaS = prices.length >= 36 ? ema(prices, 36) : null;
  let mom = 50;
  if (isNum(ch.m5)) mom += clamp(ch.m5 * 2.5, -30, 30); else A.unknowns.push('Preisänderung 5m');
  if (isNum(ch.h1)) mom += clamp(ch.h1 * 0.4, -20, 20);
  if (isNum(m1)) mom += clamp(m1 * 3, -10, 10);
  let tr = 50;
  if (isNum(ch.h1)) tr += ch.h1 > 0 ? 12 : -12;
  if (isNum(ch.h6)) tr += ch.h6 > 0 ? 10 : -10;
  if (isNum(ch.h24)) tr += ch.h24 > 0 ? 6 : -6;
  if (emaF != null && emaS != null) tr += emaF > emaS ? 15 : -15;
  A.price = {
    p: price, chg: { m1, m5: num(ch.m5), m15, h1: num(ch.h1), h6: num(ch.h6), h24: num(ch.h24) }, high: hi, low: lo,
    volPct, volLabel: volMeasured != null ? 'LIVE' : volPct != null ? 'ESTIMATED' : 'UNKNOWN',
    drawdown: hi && price ? chgOf(price, hi) : null, recovery: lo && price ? chgOf(price, lo) : null,
    emaF, emaS, momentum: Math.round(clamp(mom, 0, 100)), trend: Math.round(clamp(tr, 0, 100)),
    stability: volPct != null ? Math.round(clamp(100 - volPct * 8, 0, 100)) : null, points: prices.length
  };

  /* --- Volume Engine --- */
  const runRate5 = isNum(v.m5) && isNum(v.h1) && v.h1 > 0 ? (v.m5 * 12) / v.h1 : null;
  const turnover = isNum(v.h1) && isNum(liq) && liq > 0 ? v.h1 / liq : null;
  const anomalies = [];
  if (runRate5 != null && runRate5 > 2 && isNum(ch.m5) && Math.abs(ch.m5) < 1) anomalies.push('Volumen ohne Preisbestätigung');
  if (isNum(ch.m5) && Math.abs(ch.m5) > 10 && isNum(v.m5) && isNum(liq) && v.m5 < liq * 0.01) anomalies.push('Preisbewegung ohne Volumen');
  if (turnover != null && turnover > 15) anomalies.push('Extremer Umschlag (Wash-Trading möglich)');
  A.vol = { m5: v.m5 != null ? v.m5 : null, m15: v.m15 != null ? v.m15 : null, h1: v.h1 != null ? v.h1 : null, h6: v.h6 != null ? v.h6 : null, h24: v.h24 != null ? v.h24 : null, runRate5, turnover, buyVolume: null, sellVolume: null, anomalies };

  /* --- Transaktions-Engine --- */
  const b5 = t5 ? t5.b : null, s5 = t5 ? t5.s : null, b1 = t1 ? t1.b : null, s1 = t1 ? t1.s : null;
  const n5 = b5 != null && s5 != null ? b5 + s5 : null, n1 = b1 != null && s1 != null ? b1 + s1 : null;
  const avgTrade5 = n5 && isNum(v.m5) ? v.m5 / n5 : null;
  A.tx = {
    b5, s5, b1, s1, n5, n1, ratio5: n5 ? b5 / n5 : null, ratio1: n1 ? b1 / n1 : null,
    perMin5: n5 != null ? n5 / 5 : null, perMin1: n1 != null ? n1 / 60 : null,
    accel: n5 != null && n1 ? (n5 / 5) / (n1 / 60) : null, avgTrade5,
    whaleRel: avgTrade5 != null && isNum(liq) && liq > 0 ? avgTrade5 / liq * 100 : null,
    micro: avgTrade5 != null && avgTrade5 < 15 && n5 > 50
  };
  if (n1 == null) A.unknowns.push('Transaktionen 1h');

  /* --- Security / Holder (aus Security Engine) --- */
  const sec = tok.sec || null;
  const secAge = sec ? now - sec.checkedAt : null;
  const secStale = sec ? secAge > S.securityTtlMin * MIN : false;
  A.sec = { status: sec ? sec.status : 'UNKNOWN', stale: secStale, age: secAge, pending: !!tok.secPending, flags: sec ? sec.flags : [], top10Pct: sec ? sec.top10Pct : null };
  if (!sec) A.unknowns.push('Security (Mint/Freeze Authority, RugCheck)');
  if (!sec || !isNum(sec.top10Pct)) A.unknowns.push('Holder-Konzentration');
  A.unknowns.push('Creator-Holdings', 'Buy-/Sell-Volumen (nur Transaktionszahlen verfügbar)', 'Social/Sentiment (keine Datenquelle)');

  /* --- Technische Analyse (OHLCV wenn frisch, sonst eigene Live-Samples) --- */
  const oh = tok.ohlcv && tok.ohlcv['1m'];
  if (oh && oh.candles.length >= 30 && now - oh.fetchedAt < 3 * MIN) {
    const cl = oh.candles.map(c => c.c); const a14 = atr(oh.candles, 14);
    A.ta = { source: 'OHLCV 1m (GeckoTerminal)', label: 'LIVE', ema9: ema(cl, 9), ema21: ema(cl, 21), sma20: sma(cl, 20), rsi: rsi(cl, 14), atr: a14, atrPct: a14 && cl[cl.length - 1] ? a14 / cl[cl.length - 1] * 100 : null, roc: roc(cl, 10), vwap: vwap(oh.candles.slice(-60)) };
  } else if (prices.length >= 15) {
    A.ta = { source: 'Live-Samples (~5s)', label: 'ESTIMATED', ema9: ema(prices, 9), ema21: prices.length >= 21 ? ema(prices, 21) : null, sma20: prices.length >= 20 ? sma(prices, 20) : null, rsi: rsi(prices, 14), atr: null, atrPct: null, roc: roc(prices, 10), vwap: null };
  } else A.ta = null;

  /* --- Pump-/Manipulation-Detector (Pump ist nie automatisch ein Buy) --- */
  const pf = [];
  if (isNum(ch.m5) && ch.m5 >= 40) pf.push(`Vertikaler Anstieg (${fmtPct(ch.m5, 0)} in 5m)`);
  if (isNum(ch.h1) && ch.h1 >= 300) pf.push(`Extremer 1h-Anstieg (${fmtPct(ch.h1, 0)})`);
  if (A.tx.ratio5 != null && n5 >= 30 && A.tx.ratio5 >= 0.9) pf.push('Extremes Kauf/Verkauf-Verhältnis');
  if (runRate5 != null && runRate5 >= 5) pf.push('Volume Spike (≥5× Stundenschnitt)');
  if (A.liq.spike) pf.push('Liquiditäts-Spike (+50 % in 5m)');
  if (A.tx.whaleRel != null && A.tx.whaleRel >= 2) pf.push('Whale-dominierte Bewegung');
  A.pump = { flags: pf, score: clamp(pf.length * 25, 0, 100), detected: pf.length >= 2 || (isNum(ch.m5) && ch.m5 >= 60) };

  /* --- Data Conflict Engine (nur gleicher Pool, vergleichbare Zeitpunkte) --- */
  const conflicts = []; const prim = tok.snap, alt = tok.alt;
  A.crossChecked = false;
  if (prim && alt && Math.abs(prim.fetchedAt - alt.fetchedAt) <= 90 * SEC && prim.pairAddress && prim.pairAddress === alt.pairAddress) {
    A.crossChecked = true;
    if (isNum(prim.priceUsd) && isNum(alt.priceUsd)) { const d = Math.abs(prim.priceUsd / alt.priceUsd - 1) * 100; A.crossPriceDiff = d; if (d > 5) conflicts.push({ field: 'Preis', a: prim.priceUsd, b: alt.priceUsd, diffPct: d }); }
    if (isNum(prim.liquidityUsd) && isNum(alt.liquidityUsd) && alt.liquidityUsd > 0) { const d = Math.abs(prim.liquidityUsd / alt.liquidityUsd - 1) * 100; if (d > 35) conflicts.push({ field: 'Liquidität', a: prim.liquidityUsd, b: alt.liquidityUsd, diffPct: d }); }
  }
  A.conflicts = conflicts;

  /* --- Data Confidence Engine --- */
  const fresh = es.label === 'LIVE' || es.label === 'CACHED';
  const C = {};
  C.price = !price ? 0 : !fresh ? (es.label === 'FALLBACK' ? 45 : 12) : 68 + (A.crossChecked ? (conflicts.some(c => c.field === 'Preis') ? -40 : 27) : 12);
  C.liquidity = !isNum(liq) ? 0 : !fresh ? 12 : 70 + (A.crossChecked && !conflicts.some(c => c.field === 'Liquidität') ? 20 : 8) - (A.liq.spike ? 30 : 0);
  C.volume = !isNum(v.h1) ? 0 : !fresh ? 12 : 62 + (n5 != null ? 20 : 0) - (isNum(v.m5) && v.m5 > 0 && n5 === 0 ? 30 : 0) - anomalies.length * 10;
  C.security = !sec ? 0 : Math.round(({ VERIFIED: 92, PARTIAL: 58, CRITICAL: 88, UNKNOWN: 5 }[sec.status] || 0) * (secStale ? 0.5 : 1));
  C.market = clamp(prices.length * 3, 0, 100);
  C.onchain = sec && sec.sources.rpc ? (sec.sources.holders ? 90 : 72) : 0;
  C.social = null;
  for (const k of Object.keys(C)) if (C[k] != null) C[k] = Math.round(clamp(C[k], 0, 100));
  let ctot = 0.25 * C.price + 0.2 * C.liquidity + 0.15 * C.volume + 0.2 * C.security + 0.1 * C.market + 0.1 * C.onchain;
  if (es.fallback) ctot *= 0.7;
  C.total = Math.round(clamp(ctot, 0, 100));
  A.confidence = C;

  /* --- Rug-/Scam-Filter: getrennte Risk Factors --- */
  const R = {};
  R.liquidity = !isNum(liq) ? null : Math.max(liq < S.minLiq ? 90 : liq < S.minLiq * 2 ? 55 : 25, ratioMc != null ? (ratioMc < 0.03 ? 80 : ratioMc < 0.06 ? 50 : 20) : 40, A.liq.shock ? 90 : 0);
  R.holder = sec && isNum(sec.top10Pct) ? Math.round(clamp(sec.top10Pct * 1.1, 5, 100)) : null;
  R.creator = null;
  R.contract = !sec || sec.status === 'UNKNOWN' ? null : sec.status === 'CRITICAL' ? 100 : Math.round(clamp((sec.status === 'VERIFIED' ? 10 : 30) + sec.flags.filter(x => x.level === 'HIGH').length * 25 + sec.flags.filter(x => x.level === 'WARN').length * 8, 0, 100));
  R.marketStructure = Math.round(clamp(Math.max(A.pump.score, isNum(ch.h1) && ch.h1 < -30 ? 70 : 0, volPct != null ? clamp((volPct - 3) * 8, 0, 80) : 30), 0, 100));
  R.volumeAnomaly = Math.round(clamp(anomalies.length * 30 + (A.tx.micro ? 20 : 0), 0, 100));
  R.sellPressure = A.tx.ratio1 == null ? null : n1 >= 20 && A.tx.ratio1 < 0.4 ? 80 : A.tx.ratio1 < 0.5 ? 55 : A.tx.ratio5 != null && A.tx.ratio5 < 0.4 && n5 >= 10 ? 60 : 20;
  R.dataReliability = 100 - C.total;
  R.execution = impactPlanned == null ? null : Math.round(clamp(impactPlanned / S.maxSlippagePct * 70, 0, 100));
  let wsum = 0; const known = [];
  for (const [k, w] of Object.entries(W_RISK)) { const val = R[k]; if (val == null) { wsum += w * 50; A.unknowns.push(RISK_NAMES[k] + ' (keine Daten)'); } else { wsum += w * val; known.push(val); } }
  const rTotal = Math.round(clamp(0.65 * wsum + 0.35 * (known.length ? Math.max(...known) : 50), 0, 100));
  let level;
  if (C.total < 30) level = 'UNKNOWN';
  else if ((sec && sec.status === 'CRITICAL') || rTotal >= 75) level = 'CRITICAL';
  else if (rTotal >= 55) level = 'HIGH';
  else if (rTotal >= 30) level = 'MODERATE';
  else level = 'LOW';
  A.risk = { factors: R, total: rTotal, level };

  /* --- Signal Engine (modular, jedes Signal mit Strength/Confidence/Timestamp/Reason) --- */
  const sig = []; const addSig = (type, strength, conf, reason) => sig.push({ type, strength: Math.round(clamp(strength, 0, 100)), confidence: Math.round(clamp(conf, 0, 100)), ts: now, reason });
  const r5 = A.tx.ratio5;
  if (isNum(ch.m5) && ch.m5 >= 3 && (ch.h1 == null || ch.h1 >= 0)) addSig('MOMENTUM', ch.m5 * 5 + (ch.h1 || 0) * 0.3, C.price, `5m ${fmtPct(ch.m5)}, 1h ${fmtPct(ch.h1)}`);
  if (prices.length >= 24 && price) { const prevHigh = Math.max(...prices.slice(-24, -1)); if (price > prevHigh * 1.01 && (runRate5 == null || runRate5 >= 1.2)) addSig('BREAKOUT', 30 + (price / prevHigh - 1) * 1000, Math.min(C.price, C.market), `Preis ${fmtPct((price / prevHigh - 1) * 100)} über lokalem Hoch (${prices.length} Samples)`); }
  if (runRate5 != null && runRate5 >= 1.5 && (ch.m5 || 0) > 0) addSig('VOLUME_EXPANSION', (runRate5 - 1) * 40, C.volume, `5m-Volumen ${runRate5.toFixed(1)}× Stundenschnitt`);
  const lg = A.liq.chg15 != null ? A.liq.chg15 : A.liq.chg5;
  if (lg != null && lg >= 10 && (ch.m5 == null || ch.m5 >= -2)) addSig('LIQUIDITY_GROWTH', lg * 3, C.liquidity, `Liquidität ${fmtPct(lg)} (${A.liq.chg15 != null ? '15m' : '5m'})`);
  if (r5 != null && n5 >= 20 && r5 >= 0.6) addSig('BUYER_DOMINANCE', (r5 - 0.5) * 250, C.volume, `Käufer ${(r5 * 100).toFixed(0)} % von ${n5} Trades (5m)`);
  if (isNum(ch.h1) && isNum(ch.h6) && ch.h1 > 0 && ch.h6 > 0 && (ch.m5 == null || ch.m5 >= 0) && (emaF == null || emaS == null || emaF > emaS)) addSig('TREND_CONTINUATION', 20 + ch.h1 * 0.5 + (emaF != null && emaS != null ? 20 : 0), C.price, `1h ${fmtPct(ch.h1)}, 6h ${fmtPct(ch.h6)}${emaF != null && emaS != null ? ', EMA steigend' : ''}`);
  if (isNum(ch.h1) && ch.h1 <= -10 && isNum(ch.m5) && ch.m5 >= 3 && r5 != null && r5 >= 0.55) addSig('RECOVERY', ch.m5 * 6, C.price, `Erholung: 1h ${fmtPct(ch.h1)}, 5m ${fmtPct(ch.m5)}`);
  if (emaS != null && price && price < emaS * 0.88 && r5 != null && r5 >= 0.55) addSig('MEAN_REVERSION', (1 - price / emaS) * 300, Math.min(C.price, C.market), `Preis ${fmtPct((price / emaS - 1) * 100)} unter EMA36`);
  if (rets.length >= 40) {
    const sShort = stdev(rets.slice(-10)), sLong = stdev(rets.slice(-40));
    if (sShort != null && sLong) {
      if (sShort > sLong * 1.8) addSig('VOLATILITY_EXPANSION', (sShort / sLong - 1) * 50, C.market, `Volatilität ${(sShort / sLong).toFixed(1)}× Durchschnitt`);
      else if (sShort < sLong * 0.5) addSig('VOLATILITY_COMPRESSION', (1 - sShort / sLong) * 100, C.market, `Volatilität ${(sShort / sLong).toFixed(2)}× Durchschnitt`);
    }
  }
  if (A.tx.whaleRel != null && A.tx.whaleRel >= 0.5) addSig('WHALE_ACTIVITY', A.tx.whaleRel * 40, C.volume, `Ø Trade ${fmtUsd(avgTrade5)} = ${A.tx.whaleRel.toFixed(2)} % der Liquidität`);
  if (pairAge != null && pairAge < HOUR && r5 != null && r5 >= 0.6 && runRate5 != null && runRate5 >= 1.2) addSig('NEW_PAIR_MOMENTUM', 40 + (r5 - 0.6) * 150, Math.min(C.volume, 60), `Pair ${fmtAge(pairAge)} alt, Käufer ${(r5 * 100).toFixed(0)} %`);
  if (emaF != null && emaS != null && emaF > emaS && A.price.drawdown != null && A.price.drawdown <= -4 && A.price.drawdown >= -15) {
    const rs = rsi(prices, 14); if (rs != null && rs >= 38 && rs <= 55) addSig('PULLBACK', 40 + Math.abs(A.price.drawdown) * 2, Math.min(C.price, C.market), `Rücksetzer ${fmtPct(A.price.drawdown)} im Aufwärtstrend, RSI ${rs.toFixed(0)}`);
  }
  A.signals = sig;

  /* --- Komponenten-Scores (Scorecard) --- */
  const comp = {};
  comp.market = !isNum(mc) ? 30 : mc < S.minMcap || mc > S.maxMcap ? 25 : 65 + (['EARLY', 'ESTABLISHED'].includes(ageClass(pairAge)) ? 10 : 0);
  comp.momentum = A.pump.detected ? Math.min(A.price.momentum, 40) : A.price.momentum;
  comp.liquidity = !isNum(liq) ? 0 : clamp(Math.log10(liq / Math.max(S.minLiq, 1) + 1) * 60 + (ratioMc == null ? 0 : ratioMc >= 0.1 ? 25 : ratioMc >= 0.05 ? 10 : ratioMc < 0.03 ? -30 : 0), 0, 100);
  comp.volume = turnover == null ? 0 : turnover > 15 ? 40 : turnover >= 0.5 ? 70 + clamp((A.tx.ratio1 || 0.5) - 0.5, 0, 0.3) * 100 : turnover >= 0.1 ? 45 : 20;
  comp.holders = sec && isNum(sec.top10Pct) ? clamp(100 - sec.top10Pct, 0, 100) : 40;
  comp.security = !sec ? 0 : sec.status === 'VERIFIED' ? (sec.flags.some(x => x.level === 'HIGH') ? 55 : 90) : sec.status === 'PARTIAL' ? (sec.flags.some(x => x.level === 'HIGH') ? 40 : 65) : 0;
  comp.trend = A.price.trend;
  comp.data = C.total;
  comp.execution = impactPlanned == null ? 30 : clamp(100 - impactPlanned / S.maxSlippagePct * 100, 0, 100);
  for (const k of Object.keys(comp)) comp[k] = Math.round(comp[k]);
  A.components = comp;
  let fs = 0; for (const [k, w] of Object.entries(W_SCORE)) fs += w * comp[k];
  const penalty = Math.max(0, rTotal - 40) * 0.6 + (A.pump.detected ? 15 : 0);
  A.finalScore = Math.round(clamp(fs - penalty, 0, 100));
  const buySig = sig.filter(x => !CONTEXT_SIGNALS.has(x.type));
  const topSig = buySig.length ? Math.max(...buySig.map(x => x.strength)) : 0;
  A.opportunity = Math.round(clamp(0.3 * comp.momentum + 0.25 * comp.volume + 0.25 * comp.trend + 0.2 * topSig, 0, 100));
  A.executionScore = comp.execution;

  /* --- Klassifizierung, Tags, Flags --- */
  A.ageClass = ageClass(pairAge);
  if (volPct != null && volPct >= 6) A.tags.push('HIGH_VOLATILITY'); else if (volPct != null && volPct < 1.5) A.tags.push('LOW_VOLATILITY');
  if (isNum(ch.h1) && Math.abs(ch.h1) >= 15 && isNum(ch.h6) && Math.sign(ch.h1) === Math.sign(ch.h6)) A.tags.push('TRENDING');
  if (isNum(liq) && liq < S.minLiq) A.tags.push('LOW_LIQUIDITY');
  if (A.ageClass === 'NEW') A.tags.push('NEW_PAIR');
  if (sig.some(x => x.type === 'BREAKOUT')) A.tags.push('BREAKOUT');
  if (sig.some(x => x.type === 'RECOVERY')) A.tags.push('RECOVERY');
  if (A.pump.detected) A.tags.push('PUMP');
  if (isNum(pairAge) && pairAge < 15 * MIN) A.flags.push('BRANDNEU');
  if (ratioMc != null && ratioMc < 0.03) A.flags.push('DÜNNE LIQ');
  if (n1 >= 20 && A.tx.ratio1 < 0.4) A.flags.push('VERKÄUFER');
  if (isNum(ch.h1) && ch.h1 < -30) A.flags.push('DUMP');
  if (A.pump.detected) A.flags.push('PUMP');
  if (tok.meta && tok.meta.boostedAt) A.flags.push('BOOST');
  A.labels = {
    price: price ? es.label : 'UNKNOWN', liquidity: isNum(liq) ? es.label : 'UNKNOWN', volume: isNum(v.h1) ? es.label : 'UNKNOWN',
    security: !sec ? 'UNKNOWN' : secStale ? 'STALE' : 'LIVE', holders: sec && isNum(sec.top10Pct) ? (secStale ? 'STALE' : 'LIVE') : 'UNKNOWN', social: 'UNKNOWN'
  };
  A.unknowns = [...new Set(A.unknowns)];
  return A;
}

/* ============================== STRATEGIEN & KONSENS ============================== */
function evalStrategies(A, strategies, S) {
  const has = t => A.signals.find(x => x.type === t);
  const rules = {
    momentum: () => { const m = has('MOMENTUM'), b = has('BUYER_DOMINANCE'); return m && b ? { strength: (m.strength + b.strength) / 2, why: 'Momentum + Käuferdominanz' } : null; },
    breakout: () => { const b = has('BREAKOUT'), v = has('VOLUME_EXPANSION'); return b && v ? { strength: (b.strength + v.strength) / 2, why: 'Breakout mit Volumenbestätigung' } : null; },
    volume: () => { const v = has('VOLUME_EXPANSION'); return v && (A.tx.ratio5 || 0) >= 0.55 && (A.price.chg.m5 || 0) > 0 ? { strength: v.strength, why: 'Volume Expansion, Preis & Käufer bestätigen' } : null; },
    liquidity: () => { const l = has('LIQUIDITY_GROWTH'); return l && (A.price.chg.m5 == null ? false : A.price.chg.m5 >= 0) ? { strength: l.strength, why: 'Liquidität wächst, Preis stabil' } : null; },
    pullback: () => { const p = has('PULLBACK'); return p ? { strength: p.strength, why: 'Pullback im Aufwärtstrend' } : null; },
    meanrev: () => { const m = has('MEAN_REVERSION'); return m ? { strength: m.strength, why: 'Mean Reversion unter EMA' } : null; },
    trend: () => { const t = has('TREND_CONTINUATION'); return t ? { strength: t.strength, why: 'Trendfortsetzung' } : null; }
  };
  const votes = [];
  for (const def of STRATEGY_DEFS) {
    const cfg = strategies[def.id];
    if (!cfg.enabled && !S.ffShadowMode) continue;
    const r = rules[def.id]();
    const reasons = []; let vote = 'NONE';
    if (r) {
      if (A.finalScore < cfg.minScore) reasons.push(`Score ${A.finalScore} < ${cfg.minScore}`);
      if (A.risk.total > cfg.riskLimit) reasons.push(`Risk ${A.risk.total} > ${cfg.riskLimit}`);
      if (!isNum(A.liq.usd) || A.liq.usd < cfg.minLiquidity) reasons.push(`Liquidität < ${fmtUsd(cfg.minLiquidity)}`);
      if (A.confidence.total < cfg.minConfidence) reasons.push(`Confidence ${A.confidence.total} < ${cfg.minConfidence}`);
      if (!reasons.length) vote = 'BUY';
    } else reasons.push('kein passendes Signal');
    votes.push({ id: def.id, name: def.name, enabled: cfg.enabled, shadow: !cfg.enabled, vote, strength: r ? Math.round(r.strength) : 0, weight: cfg.weight, why: r ? r.why : null, reasons });
  }
  const buy = votes.filter(x => x.enabled && x.vote === 'BUY');
  const weightSum = Math.round(sum(buy.map(x => x.weight)) * 100) / 100;
  const lead = [...buy].sort((a, b) => b.weight * b.strength - a.weight * a.strength)[0];
  return { votes, weightSum, consensus: buy.length > 0 && weightSum >= S.consensusMinWeight, lead: lead ? lead.id : null };
}

/* ============================== DECISION ENGINE ==============================
   Pipeline: DISCOVERY → BASIC → LIQUIDITY → SECURITY → MARKET STRUCTURE → SIGNALS → RISK → DECISION → EXECUTION CHECK → TRADE
   Ein hoher Score überstimmt niemals harte Sicherheitsregeln. NO TRADE ist eine vollwertige Entscheidung. */
const PIPELINE = ['DISCOVERY', 'BASIC_FILTER', 'LIQUIDITY_FILTER', 'SECURITY_FILTER', 'MARKET_STRUCTURE', 'SIGNAL_ENGINE', 'RISK_ENGINE', 'DECISION', 'EXECUTION_CHECK', 'TRADE'];
function decideToken(tok, A, ctx) {
  const S = ctx.S; const trace = []; const all = [];
  const stageRun = (name, fn) => { const B = []; const add = (c, m, x) => B.push(mkBlocker(c, m, x)); const detail = fn(add); trace.push({ stage: name, ok: B.length === 0, detail: B.length ? B.map(b => b.msg).join(' · ') : detail }); all.push(...B); return B.length === 0; };
  trace.push({ stage: 'DISCOVERY', ok: true, detail: 'Quelle: ' + ((tok.meta && tok.meta.via && tok.meta.via.join(', ')) || '—') });
  const basicOk = stageRun('BASIC_FILTER', add => {
    if (!isNum(A.core.price)) add('PRICE_MISSING', 'Kein gültiger Preis vorhanden');
    if (A.stale) add('DATA_STALE', `Marktdaten veraltet (${A.dataAge == null ? 'keine' : fmtAge(A.dataAge)})`);
    if (!isNum(A.core.mc)) add('MCAP_RANGE', 'Market Cap unbekannt');
    else if (A.core.mc < S.minMcap || A.core.mc > S.maxMcap) add('MCAP_RANGE', `MCap ${fmtUsd(A.core.mc)} außerhalb ${fmtUsd(S.minMcap)}–${fmtUsd(S.maxMcap)}`);
    if (!isNum(A.vol.h1) || A.vol.h1 < S.minVol1h) add('LOW_VOLUME', `Vol 1h ${fmtUsd(A.vol.h1)} < ${fmtUsd(S.minVol1h)}`);
    if (A.tx.ratio1 == null || A.tx.ratio1 < S.minBuyRatio) add('BUYER_RATIO', `Käufer 1h ${A.tx.ratio1 == null ? '—' : (A.tx.ratio1 * 100).toFixed(0) + ' %'} < ${(S.minBuyRatio * 100).toFixed(0)} %`);
    if (S.minPairAgeMin > 0 && (A.core.pairAge == null || A.core.pairAge < S.minPairAgeMin * MIN)) add('PAIR_TOO_NEW', A.core.pairAge == null ? 'Pair-Alter unbekannt' : `Pair erst ${fmtAge(A.core.pairAge)} alt (< ${S.minPairAgeMin} min)`);
    return 'Preis, Frische, MCap, Volumen, Käuferanteil ok';
  });
  const liqOk = stageRun('LIQUIDITY_FILTER', add => {
    if (!isNum(A.liq.usd) || A.liq.usd < S.minLiq) add('LOW_LIQUIDITY', `Liquidität ${fmtUsd(A.liq.usd)} < ${fmtUsd(S.minLiq)}`);
    if (A.liq.ratioMc != null && A.liq.ratioMc < 0.03) add('THIN_LIQUIDITY', `Liquidität/MCap nur ${(A.liq.ratioMc * 100).toFixed(1)} %`);
    if (A.liq.shock) add('LIQUIDITY_SHOCK', `Liquidität ${fmtPct(A.liq.chg5)} in 5m`);
    return `Liquidität ${fmtUsd(A.liq.usd)}, Verhältnis ${A.liq.ratioMc == null ? '—' : (A.liq.ratioMc * 100).toFixed(1) + ' %'}`;
  });
  const fastPass = basicOk && liqOk;
  const secOk = stageRun('SECURITY_FILTER', add => {
    const st = A.sec.status;
    if (st === 'CRITICAL') add('SECURITY_CRITICAL', (A.sec.flags.find(x => x.level === 'CRITICAL') || {}).msg || 'Kritisches Sicherheitsrisiko');
    else if (st === 'UNKNOWN') add('SECURITY_UNKNOWN', A.sec.pending ? 'Sicherheitsprüfung läuft …' : fastPass ? 'Sicherheitsprüfung ausstehend' : 'Nicht geprüft (Schnellfilter nicht bestanden)');
    else if (st === 'PARTIAL' && S.requireVerifiedSecurity) add('SECURITY_UNVERIFIED', 'Nur eine Sicherheitsquelle verfügbar (PARTIAL)');
    if (A.sec.stale) add('SECURITY_STALE', `Security-Daten ${fmtAge(A.sec.age)} alt`);
    return 'Security ' + st;
  });
  stageRun('MARKET_STRUCTURE', add => {
    if (A.pump.detected) add('PUMP_DETECTED', A.pump.flags.join(', '));
    const pc = A.conflicts.find(c => c.field === 'Preis');
    if (pc) add('DATA_CONFLICT', `Preis weicht ${pc.diffPct.toFixed(1)} % zwischen DexScreener und GeckoTerminal ab`);
    if (A.fallback) add('DATA_FALLBACK', 'Primärquelle nicht aktuell – nur GeckoTerminal-Fallback');
    return A.tags.length ? A.tags.join(', ') : 'unauffällig';
  });
  stageRun('SIGNAL_ENGINE', add => { if (!A.signals.some(x => !CONTEXT_SIGNALS.has(x.type))) add('NO_SIGNAL', 'Keine Kaufsignale (nur Kontext-Signale)'); return A.signals.map(x => SIGNAL_NAMES[x.type] + ' ' + x.strength).join(', '); });
  stageRun('RISK_ENGINE', add => {
    if (A.risk.level === 'CRITICAL' || A.risk.total > S.maxRiskScore) add('RISK_TOO_HIGH', `Risk ${A.risk.total} (${A.risk.level}) > ${S.maxRiskScore}`);
    if (A.confidence.total < S.minConfidence) add('CONFIDENCE_LOW', `Confidence ${A.confidence.total} < ${S.minConfidence}`);
    return `Risk ${A.risk.total} ${A.risk.level}, Confidence ${A.confidence.total}`;
  });
  const strat = evalStrategies(A, ctx.strategies, S);
  A.strat = strat;
  stageRun('DECISION', add => {
    if (A.finalScore < S.minScore) add('SCORE_TOO_LOW', `Final Score ${A.finalScore} < ${S.minScore}`);
    if (!strat.consensus) add('NO_CONSENSUS', `Konsens ${strat.weightSum} < ${S.consensusMinWeight}`);
    return `Score ${A.finalScore}, Konsens ${strat.weightSum} (${strat.votes.filter(x => x.enabled && x.vote === 'BUY').map(x => x.name).join(', ')})`;
  });
  const analysisBlockers = sortBlockers(all);
  const ex = ctx.execCheck ? ctx.execCheck(tok, A, { auto: true, lead: strat.lead }) : { blockers: [], sizing: null };
  trace.push({ stage: 'EXECUTION_CHECK', ok: ex.blockers.length === 0, detail: ex.blockers.length ? ex.blockers.map(b => b.msg).join(' · ') : 'Portfolio, Limits, Cooldowns, Ausführung ok' + (ex.sizing ? ` · Größe ${fmtUsd(ex.sizing.size)}` : '') });
  let decision;
  if (!analysisBlockers.length && !ex.blockers.length) decision = 'APPROVED';
  else if (!analysisBlockers.length) decision = 'BUY_CANDIDATE';
  else if (fastPass && secOk && !analysisBlockers.some(b => b.prio <= 3)) decision = 'WATCH';
  else decision = 'REJECTED';
  trace.push({ stage: 'TRADE', ok: decision === 'APPROVED' ? true : null, detail: decision === 'APPROVED' ? 'Freigegeben für Ausführung' : 'Kein Trade (NO TRADE ist eine valide Entscheidung)' });
  const blockers = sortBlockers([...analysisBlockers, ...ex.blockers]);
  let stageReached = PIPELINE.length - 1;
  for (let i = 0; i < trace.length; i++) if (trace[i].ok === false) { stageReached = i; break; }
  const reason = decision === 'APPROVED' ? 'Alle Prüfungen bestanden: ' + (strat.votes.filter(x => x.enabled && x.vote === 'BUY').map(x => x.why).join('; ') || '—')
    : decision === 'BUY_CANDIDATE' ? 'Analyse positiv, Ausführung blockiert: ' + ex.blockers.slice(0, 2).map(b => b.msg).join('; ')
      : blockers.slice(0, 3).map(b => b.msg).join('; ') || 'Keine Freigabe';
  return {
    tokenId: tok.id, ts: A.ts, decision, reason, blockers, analysisBlockers, execBlockers: ex.blockers, trace, fastPass, secOk, stageReached,
    score: A.finalScore, opportunity: A.opportunity, confidence: A.confidence.total, risk: { total: A.risk.total, level: A.risk.level },
    signals: A.signals.map(x => ({ type: x.type, strength: x.strength })), strategy: strat.lead, consensus: strat.weightSum,
    positionSize: ex.sizing ? ex.sizing.size : 0, executionRisk: A.liq.slipRisk, dataQuality: A.labels
  };
}

/* ============================== MARKET REGIME ============================== */
function computeRegime(analyses, sol) {
  const h1 = analyses.map(a => a.price.chg.h1).filter(isNum), m5 = analyses.map(a => a.price.chg.m5).filter(isNum);
  if (h1.length < 5) return { tags: ['UNKNOWN'], breadth: null, medH1: null, medM5: null, medVol: null, n: h1.length, sol };
  const breadth = h1.filter(x => x > 0).length / h1.length;
  const medH1 = median(h1), medM5 = median(m5.map(Math.abs)), vols = analyses.map(a => a.price.volPct).filter(isNum), medVol = median(vols);
  const tags = [];
  if (breadth > 0.6 && medH1 > 5) tags.push('RISK_ON'); else if (breadth < 0.35 && medH1 < -5) tags.push('RISK_OFF');
  if (medM5 != null && medM5 > 8) tags.push('HIGH_VOLATILITY'); else if (medM5 != null && medM5 < 1.5) tags.push('LOW_VOLATILITY');
  if (Math.abs(medH1) > 10) tags.push('TRENDING'); else tags.push('CHOPPY');
  return { tags, breadth, medH1, medM5, medVol, n: h1.length, sol };
}

/* ============================== ANALYTICS (reine Funktionen) ============================== */
function perfStats(trades) {
  const closed = trades.filter(t => t.status === 'CLOSED' && t.result && isNum(t.result.pnlUsd));
  const pnl = closed.map(t => t.result.pnlUsd);
  const wins = pnl.filter(x => x > 0), losses = pnl.filter(x => x <= 0);
  const gw = sum(wins), gl = -sum(losses);
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of [...closed].sort((a, b) => a.closedAt - b.closedAt)) { eq += t.result.pnlUsd; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  return {
    trades: closed.length, wins: wins.length, losses: losses.length, winRate: closed.length ? wins.length / closed.length : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null, expectancy: closed.length ? sum(pnl) / closed.length : null,
    maxDD, fees: sum(closed.map(t => t.feesUsd || 0)), slippage: sum(closed.map(t => t.slippageUsd || 0)),
    gross: sum(pnl) + sum(closed.map(t => t.feesUsd || 0)), net: sum(pnl),
    avgHold: closed.length ? avg(closed.map(t => t.closedAt - t.openedAt)) : null,
    best: pnl.length ? Math.max(...pnl) : null, worst: pnl.length ? Math.min(...pnl) : null
  };
}
function bucketize(values, edges, labels) {
  const out = labels.map(l => ({ label: l, n: 0 }));
  for (const v of values) { if (!isNum(v)) continue; let i = edges.findIndex(e => v < e); if (i === -1) i = edges.length; out[i].n++; }
  return out;
}

/* ============================== BACKTEST (ohne Look-Ahead) ==============================
   Signal auf Kerze i (geschlossen) → Einstieg zum Open von Kerze i+1. Stops vor TPs geprüft (konservativ). */
const BT_STRATEGIES = {
  momentum: { name: 'Momentum', param: 'thr', grid: [2, 3, 5, 8], def: 3, fn: (c, i, p, x) => { const r = roc(x.cl.slice(0, i + 1), 5); return r != null && r > p.thr && x.e9[i] > x.e21[i] && c[i].v > (x.vs[i] || Infinity) * 1.5; } },
  breakout: { name: 'Breakout', param: 'look', grid: [10, 20, 30], def: 20, fn: (c, i, p, x) => { if (i < p.look + 1) return false; let hh = 0; for (let j = i - p.look; j < i; j++) hh = Math.max(hh, c[j].h); return c[i].c > hh && c[i].v > (x.vs[i] || Infinity) * 1.5; } },
  trend: { name: 'Trend Following', param: 'rsiMax', grid: [65, 70, 75], def: 70, fn: (c, i, p, x) => i > 0 && x.e9[i - 1] != null && x.e21[i - 1] != null && x.e9[i - 1] <= x.e21[i - 1] && x.e9[i] > x.e21[i] && x.rs[i] != null && x.rs[i] >= 50 && x.rs[i] <= p.rsiMax },
  meanrev: { name: 'Mean Reversion', param: 'dev', grid: [10, 15, 20], def: 15, fn: (c, i, p, x) => x.rs[i] != null && x.rs[i] < 30 && x.e21[i] != null && c[i].c < x.e21[i] * (1 - p.dev / 100) },
  volume: { name: 'Volume Expansion', param: 'mult', grid: [2, 3, 4], def: 3, fn: (c, i, p, x) => c[i].v > (x.vs[i] || Infinity) * p.mult && c[i].c > c[i].o }
};
function btPrecompute(c) {
  const cl = c.map(x => x.c), e9 = emaSeries(cl, 9), e21 = emaSeries(cl, 21);
  const rs = cl.map((_, i) => (i >= 15 ? rsi(cl.slice(Math.max(0, i - 60), i + 1), 14) : null));
  const vs = c.map((_, i) => (i >= 20 ? sum(c.slice(i - 20, i).map(k => k.v)) / 20 : null)); // Durchschnitt der VORHERIGEN 20 Kerzen
  return { cl, e9, e21, rs, vs };
}
function runBacktest(candles, cfg) {
  const def = BT_STRATEGIES[cfg.strategy]; if (!def) throw new Error('Unbekannte Strategie');
  const c = candles; const x = btPrecompute(c);
  const p = { [def.param]: cfg.param != null ? cfg.param : def.def };
  const feePct = cfg.feePct / 100, slip = cfg.slipPct / 100;
  let equity = cfg.capital, peak = equity, maxDD = 0; const trades = []; const curve = [{ t: c[0] ? c[0].t : 0, v: equity }];
  let pos = null, barsIn = 0;
  const from = cfg.from || 0, to = cfg.to == null ? c.length : cfg.to;
  for (let i = Math.max(from, 22); i < to; i++) {
    if (pos) {
      const k = c[i]; let exit = null;
      if (k.l <= pos.stop) exit = { price: Math.min(k.o, pos.stop) * (1 - slip), reason: pos.trailing ? 'TRAILING_STOP' : 'STOP_LOSS' };
      else if (k.h >= pos.tp) exit = { price: Math.max(k.o, pos.tp) * (1 - slip), reason: 'TAKE_PROFIT' };
      else if (i - pos.i >= cfg.timeBars) exit = { price: k.c * (1 - slip), reason: 'TIME_EXIT' };
      if (!exit) { pos.high = Math.max(pos.high, k.h); if (pos.high >= pos.entry * (1 + cfg.trailActPct / 100)) { pos.trailing = true; pos.stop = Math.max(pos.stop, pos.high * (1 - cfg.trailPct / 100)); } }
      if (exit) {
        const gross = pos.qty * exit.price, fee = gross * feePct, net = gross - fee;
        const pnl = net - pos.cost; equity += net; barsIn += i - pos.i + 1;
        trades.push({ entryT: pos.t, exitT: k.t, entry: pos.entry, exit: exit.price, pnl, pnlPct: pnl / pos.cost * 100, reason: exit.reason, bars: i - pos.i + 1, fees: pos.fee + fee, slippage: pos.cost * slip + gross * slip });
        pos = null; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak > 0 ? (peak - equity) / peak : 0); curve.push({ t: k.t, v: equity });
      }
      continue;
    }
    if (i + 1 < to && def.fn(c, i, p, x)) {
      const n = c[i + 1]; const entry = n.o * (1 + slip); const cost = equity * cfg.sizePct / 100; if (cost <= 0) continue;
      const fee = cost * feePct; const qty = (cost - fee) / entry; equity -= cost;
      // Einstieg auf Kerze i+1; deren Low/High wird in der nächsten Iteration für Exits geprüft.
      pos = { i: i + 1, t: n.t, entry, qty, cost, fee, stop: entry * (1 - cfg.slPct / 100), tp: entry * (1 + cfg.tpPct / 100), high: entry, trailing: false };
    }
  }
  if (pos) { const k = c[to - 1]; const gross = pos.qty * k.c * (1 - slip); const fee = gross * feePct; const pnl = gross - fee - pos.cost; equity += gross - fee; trades.push({ entryT: pos.t, exitT: k.t, entry: pos.entry, exit: k.c, pnl, pnlPct: pnl / pos.cost * 100, reason: 'END_OF_DATA', bars: to - pos.i, fees: pos.fee + fee, slippage: 0 }); curve.push({ t: k.t, v: equity }); }
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = sum(wins.map(t => t.pnl)), gl = -sum(losses.map(t => t.pnl));
  const span = Math.max(1, to - Math.max(from, 22));
  return {
    params: p, trades, curve, metrics: {
      trades: trades.length, winRate: trades.length ? wins.length / trades.length : null, avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
      profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null, maxDD: maxDD * 100, expectancy: trades.length ? sum(trades.map(t => t.pnl)) / trades.length : null,
      fees: sum(trades.map(t => t.fees)), slippage: sum(trades.map(t => t.slippage)), exposure: barsIn / span * 100, avgHoldBars: trades.length ? avg(trades.map(t => t.bars)) : null,
      netPnl: equity - cfg.capital, returnPct: (equity / cfg.capital - 1) * 100
    }
  };
}
/* Walk-Forward: Parameter nur auf Training wählen, auf Validation prüfen, Ergebnis separat auf Test berichten. */
function walkForward(candles, cfg) {
  const n = candles.length; const a = Math.floor(n * 0.5), b = Math.floor(n * 0.75);
  const def = BT_STRATEGIES[cfg.strategy];
  const rows = def.grid.map(g => ({ param: g, train: runBacktest(candles, { ...cfg, param: g, from: 0, to: a }).metrics }));
  const eligible = rows.filter(r => r.train.trades >= 3);
  const best = (eligible.length ? eligible : rows).sort((x, y) => (y.train.expectancy || -Infinity) - (x.train.expectancy || -Infinity))[0];
  const validation = runBacktest(candles, { ...cfg, param: best.param, from: a, to: b }).metrics;
  const test = runBacktest(candles, { ...cfg, param: best.param, from: b, to: n });
  return { split: { train: [0, a], validation: [a, b], test: [b, n] }, grid: rows, chosen: best.param, validation, test: test.metrics, testCurve: test.curve, testTrades: test.trades, lowSample: !eligible.length };
}

/* ============================== CORE: Scanner · Execution · Positionen · Portfolio · Risk State ==============================
   createCore() ist DOM-frei und über env (Uhr, fetch, Timer, Storage) injizierbar → testbar. */
const ORDER_TRANSITIONS = {
  DETECTED: ['ANALYZING', 'REJECTED', 'CANCELLED'],
  ANALYZING: ['APPROVED', 'REJECTED', 'CANCELLED', 'FAILED'],
  APPROVED: ['QUEUED', 'SUBMITTING', 'CANCELLED'],
  QUEUED: ['SUBMITTING', 'CANCELLED'],
  SUBMITTING: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['CONFIRMING', 'FAILED'],
  CONFIRMING: ['CONFIRMED', 'PARTIALLY_FILLED', 'FAILED'],
  PARTIALLY_FILLED: ['COMPLETED', 'FAILED'],
  CONFIRMED: ['COMPLETED'],
  RECONCILING: ['COMPLETED', 'CANCELLED', 'FAILED'],
  COMPLETED: [], FAILED: [], CANCELLED: [], REJECTED: []
};
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED']);
const BOT_TRANSITIONS = {
  STOPPED: ['STARTING', 'EMERGENCY_STOP'],
  STARTING: ['RECOVERING', 'RUNNING', 'PAUSED', 'ERROR', 'STOPPED', 'EMERGENCY_STOP'],
  RECOVERING: ['RUNNING', 'PAUSED', 'ERROR', 'STOPPED', 'EMERGENCY_STOP'],
  RUNNING: ['PAUSED', 'RECOVERING', 'ERROR', 'STOPPED', 'EMERGENCY_STOP'],
  PAUSED: ['RUNNING', 'RECOVERING', 'ERROR', 'STOPPED', 'EMERGENCY_STOP'],
  ERROR: ['RECOVERING', 'STARTING', 'STOPPED', 'EMERGENCY_STOP'],
  EMERGENCY_STOP: ['PAUSED', 'STOPPED']
};
/* Für manuelle Trades gelten nur die harten Sicherheitsregeln (Manual Override ohne Safety Bypass). */
const MANUAL_HARD = new Set(['PRICE_MISSING', 'DATA_STALE', 'DATA_FALLBACK', 'DATA_CONFLICT', 'SECURITY_CRITICAL', 'SECURITY_UNKNOWN', 'SECURITY_UNVERIFIED', 'SECURITY_STALE', 'LOW_LIQUIDITY', 'LIQUIDITY_SHOCK']);
const ALERT_TAGS = { BUY_CANDIDATE: '🔔 BUY CANDIDATE', SCORE: '⭐ SCORE', X2: '🚀 x2 seit Fund', NEW_TOKEN: '🆕 NEUER TOKEN', LIQ_SPIKE: '💧 LIQUIDITY SPIKE', LIQ_COLLAPSE: '⚠️ LIQUIDITY COLLAPSE', VOL_SPIKE: '📈 VOLUME SPIKE', WHALE: '🐋 WHALE ACTIVITY', SECURITY: '🛡 SECURITY RISK', SELL_CANDIDATE: '↘ SELL CANDIDATE', STOP_HIT: '⛔ STOP HIT', TP_HIT: '🎯 TAKE PROFIT', API_FAIL: '📡 API FAILURE', RPC_FAIL: '🛰 RPC FAILURE', WATCH: '👁 WATCHLIST', RISK: '⚠️ RISK', SYSTEM: '⚙ SYSTEM', TRADE: '💱 TRADE', POSITION_DATA: '⚠️ POSITIONSDATEN', LEGACY: '🔔 Alarm' };
/* Nur diese globalen Blocker bedeuten „BLOCKED“. Kein Kandidat / niedriger Score / kein Konsens → WAITING, nie BLOCKED. */
const HARD_GLOBAL = new Set(['EMERGENCY_STOP', 'SAFE_MODE', 'OFFLINE', 'SYSTEM_UNHEALTHY', 'FEE_UNKNOWN', 'DAILY_LOSS_LIMIT', 'GLOBAL_PAUSE', 'LOSS_COOLDOWN', 'RECONCILIATION_REQUIRED', 'SECURITY_SOURCES_DOWN', 'LIVE_UNAVAILABLE']);
const GENESIS = { '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet' };
const CHAIN_STEPS = [
  ['DATA', ['PRICE_MISSING', 'DATA_STALE', 'DATA_CONFLICT', 'DATA_FALLBACK']],
  ['SECURITY', ['SECURITY_CRITICAL', 'SECURITY_UNKNOWN', 'SECURITY_UNVERIFIED', 'SECURITY_STALE']],
  ['LIQUIDITY', ['LOW_LIQUIDITY', 'THIN_LIQUIDITY', 'LIQUIDITY_SHOCK']],
  ['MARKET', ['MCAP_RANGE', 'PAIR_TOO_NEW']],
  ['VOLUME', ['LOW_VOLUME', 'BUYER_RATIO']],
  ['MOMENTUM', ['NO_SIGNAL', 'PUMP_DETECTED']],
  ['RISK', ['RISK_TOO_HIGH']],
  ['SCORE', ['SCORE_TOO_LOW']],
  ['CONFIDENCE', ['CONFIDENCE_LOW']],
  ['CONSENSUS', ['NO_CONSENSUS']]
];
/* Kandidaten-Kette: SECURITY PASS → LIQUIDITY PASS → … → FINAL. Rein funktional aus Analyse + Entscheidung. */
function candidateChain(t) {
  const A = t.A, D = t.D; if (!A || !D) return null;
  const steps = CHAIN_STEPS.map(([k, codes]) => {
    const hit = D.analysisBlockers.find(b => codes.includes(b.code));
    // Security wird erst nach bestandenen Schnellfiltern geprüft → „nicht erreicht“ statt Fehler
    const na = !!hit && hit.code === 'SECURITY_UNKNOWN' && !D.fastPass;
    return { k, ok: !hit, na, code: hit ? hit.code : null, msg: na ? 'nicht geprüft (Schnellfilter nicht bestanden)' : hit ? hit.msg : '' };
  });
  const values = { DATA: A.label + (A.dataAge != null ? ' · ' + fmtAge(A.dataAge) : ''), SECURITY: A.sec.status, LIQUIDITY: fmtUsd(A.liq.usd), MARKET: fmtUsd(A.core.mc), VOLUME: fmtUsd(A.vol.h1), MOMENTUM: String(A.price.momentum), RISK: A.risk.total + ' ' + A.risk.level, SCORE: String(A.finalScore), CONFIDENCE: A.confidence.total + '%', CONSENSUS: String(A.strat ? A.strat.weightSum : 0) };
  steps.forEach(x => { x.value = values[x.k]; });
  const firstFail = steps.find(x => !x.ok && !x.na);
  const final = D.decision === 'APPROVED' ? 'BUY – freigegeben' : D.decision === 'BUY_CANDIDATE' ? 'BEREIT – Ausführung wartet: ' + (D.execBlockers[0] ? D.execBlockers[0].msg : '—') : 'NO TRADE';
  const text = steps.map(x => x.k + ' ' + (x.ok ? 'PASS' : x.na ? '—' : x.code.replace(/_/g, ' '))).join(' → ') + ' → FINAL: ' + final;
  return { steps, final, text, reason: firstFail ? firstFail.msg : D.decision === 'BUY_CANDIDATE' ? (D.execBlockers[0] || {}).msg || '' : '', decision: D.decision };
}
const csvCell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function createCore(opts) {
  const env = opts.env;
  const log = createLogger(env, 1500);
  const store = createStorage(opts.backend, log);
  const http = createHttp(env, log);
  const subs = new Map();
  const on = (ev, fn) => { if (!subs.has(ev)) subs.set(ev, new Set()); subs.get(ev).add(fn); return () => subs.get(ev).delete(fn); };
  const emit = (ev, data) => { const s = subs.get(ev); if (s) s.forEach(fn => { try { fn(data); } catch (e) { log.error('UI', 'Listener-Fehler (' + ev + '): ' + e.message); } }); };
  const seqs = { order: 0, pos: 0, alert: 0 };

  http.define('dexDisc', { label: 'DexScreener Discovery', limitPerMin: 50, staleMs: 3 * MIN, timeoutMs: 12000 });
  http.define('dexPairs', { label: 'DexScreener Pairs', limitPerMin: 240, staleMs: 45 * SEC, timeoutMs: 12000 });
  http.define('dexSol', { label: 'DexScreener SOL-Preis', limitPerMin: 10, staleMs: 3 * MIN });
  http.define('gecko', { label: 'GeckoTerminal', limitPerMin: 25, staleMs: 3 * MIN });
  http.define('rugcheck', { label: 'RugCheck', limitPerMin: 20, staleMs: 20 * MIN, timeoutMs: 10000 });

  const freshPortfolio = cap => ({ startCapital: cap, cash: cap, realized: 0, fees: 0, peakEquity: cap, maxDD: 0 });
  const state = {
    settings: defaultSettings(), strategies: defaultStrategies(), mode: 'SIMULATION',
    bot: { state: 'STOPPED', desired: 'RUNNING', autoTrading: false, safeMode: false, safeAuto: false, emergency: false, emergencyReason: '', lastError: null, errorStreak: 0, errorAt: 0, startedAt: 0, readyAt: 0 },
    scanner: { id: 0, lock: false, running: false, lastAt: 0, lastDuration: 0, skipped: 0, errors: 0, lateIgnored: 0, nextAt: 0, lastDisc: 0, lastGtDisc: 0, gtKind: 0, lastCross: 0, lastRpc: 0, lastRpcAll: 0, lastOhlcv: 0, scansWindow: [] },
    markets: new Map(), selected: null, sol: null,
    positions: [], orders: [], journal: [], feed: [], queue: [], locks: new Set(), usedKeys: new Map(),
    portfolio: freshPortfolio(1000),
    risk: { buyCount: {}, coinCooldown: {}, stratCooldown: {}, lossCooldownUntil: 0, globalPauseUntil: 0, lossStreak: 0, dayKey: '', dailyPnl: 0, dailyStartEquity: null, dailyTrades: 0, dailyLimitHit: false, reviewRequired: false, buyTimes: [] },
    watchlist: {}, seen: {}, alertMarks: {}, stratMarks: {},
    rpc: { slot: null, prevSlot: null, slotAt: 0, latency: null, endpoint: null },
    wallet: { status: 'NOT_CONNECTED', pubkey: null, provider: null, network: null, networkAt: 0, balanceLamports: null, balanceAt: 0, error: '' },
    tradeSeq: 0, reconciliation: { required: false, issues: [], at: 0 },
    metrics: { perf: { scan: null, analysis: null, exec: null, render: null }, counters: { scans: 0, buySignals: 0, rejected: 0, executed: 0, apiErrors: 0 }, funnel: {}, scanStats: {}, minute: { t: 0, scans: 0, candidates: 0, accepted: 0, rejected: 0, executed: 0 }, rejectReasons: {}, preTradeRejects: {} },
    hist: { equity: [], risk: [], api: [], scanner: [] },
    paramVersions: [], activeParam: 1, configLog: [], auditLog: [], sessions: [], session: null, stratStats: {}, falseSignals: [],
    secQueue: [], secBusy: false, regime: { tags: ['UNKNOWN'] }, storageOk: true, lastSaveAt: 0, ui: {}, loadInfo: {}
  };
  const S = () => state.settings;

  /* ---------- Timer-Verwaltung (keine doppelten Timer) ---------- */
  const timers = new Map();
  function setT(name, fn, ms) { clearT(name); timers.set(name, env.setTimeout(() => { timers.delete(name); fn(); }, ms)); }
  function clearT(name) { if (timers.has(name)) { env.clearTimeout(timers.get(name)); timers.delete(name); } }

  /* ---------- Audit / Logging-Hilfen ---------- */
  function audit(who, what, detail, why) {
    state.auditLog.unshift({ ts: env.now(), who, what, detail: str(String(detail || ''), 300), why: str(String(why || ''), 300) });
    if (state.auditLog.length > 400) state.auditLog.length = 400;
  }
  function noteApiError(src, e) {
    if (!e) return;
    if (!['BACKOFF', 'RATE_LIMIT_LOCAL', 'ABORTED', 'OFFLINE'].includes(e.code)) state.metrics.counters.apiErrors++;
    if (S().debugMode) log.debug('API', `${src}: ${e.message}`);
  }
  http.onStatus((name, prev, st) => {
    const src = http.sources[name]; if (!src) return;
    const label = src.cfg.label;
    if (st === 'OFFLINE') { log.error('API', `${label}: OFFLINE – ${src.lastError || 'keine Antwort'}`); alert(src.cfg.kind === 'rpc' ? 'RPC_FAIL' : 'API_FAIL', null, `${label} ist OFFLINE: ${src.lastError || 'keine Antwort'}`, 'ERROR', { key: name }); }
    else if (st === 'DEGRADED') log.warn('API', `${label}: DEGRADED – ${src.lastError || 'hohe Latenz/Fehlerrate'}`);
    else if (st === 'STALE') log.warn('API', `${label}: STALE – seit ${fmtAge(env.now() - src.lastSuccess)} keine erfolgreiche Antwort`);
    else if (st === 'ONLINE' && prev !== 'UNKNOWN') log.success('API', `${label}: wieder ONLINE`);
    else if (st === 'ONLINE') log.info('API', `${label}: ONLINE`);
  });

  /* ---------- Alerts (dedupliziert, keine Endlosschleifen) ---------- */
  function alert(type, t, detail, level = 'INFO', extra = {}) {
    const now = env.now();
    const key = type + ':' + (t ? t.id : '-') + (extra.key ? ':' + extra.key : '');
    const cd = extra.cooldownMs != null ? extra.cooldownMs : S().alertCooldownMin * MIN;
    if (state.alertMarks[key] && now - state.alertMarks[key] < cd) return null;
    state.alertMarks[key] = now;
    const A = t && t.A;
    const e = {
      id: 'a' + now.toString(36) + '_' + (++seqs.alert), ts: now, type, level, tag: ALERT_TAGS[type] || type,
      tokenId: t ? t.id : null, mint: t ? t.mint : null, sym: t ? t.symbol : null,
      mc: A ? A.core.mc : null, price: A ? A.core.price : null, score: A ? A.finalScore : null, risk: A ? A.risk.level : null,
      riskScore: A ? A.risk.total : null, conf: A ? A.confidence.total : null, dataAge: A ? A.dataAge : null, label: A ? A.label : null,
      detail: String(detail).slice(0, 300), strength: extra.strength != null ? extra.strength : null
    };
    state.feed.unshift(e); if (state.feed.length > 120) state.feed.length = 120;
    persist(); emit('alert', e);
    return e;
  }

  /* ---------- Universe ---------- */
  function mergeLinks(t, links) {
    for (const l of links || []) if (!t.meta.links.some(x => x.url === l.url) && t.meta.links.length < 12) t.meta.links.push(l);
  }
  const openPos = id => state.positions.find(p => p.tokenId === id && p.status === 'OPEN') || null;
  function pinnedIds() {
    const ids = new Set();
    for (const p of state.positions) ids.add(p.tokenId);
    for (const q of state.queue) ids.add(q.tokenId);
    if (state.selected) ids.add(state.selected);
    for (const id of Object.keys(state.watchlist)) ids.add(id);
    return ids;
  }
  function priorityOf(t) {
    let p = 0;
    if (openPos(t.id)) p += 1000;
    if (state.selected === t.id) p += 800;
    const w = state.watchlist[t.id]; if (w) p += 500 + (4 - (w.priority || 2)) * 30;
    if (t.A) { p += t.A.finalScore * 2; if (t.D && (t.D.decision === 'APPROVED' || t.D.decision === 'BUY_CANDIDATE')) p += 150; if (isNum(t.A.liq.usd)) p += Math.log10(t.A.liq.usd + 1) * 5; }
    if (t.meta.discoveredAt && env.now() - t.meta.discoveredAt < 5 * MIN) p += 60;
    return p;
  }
  function evictOne() {
    const pinned = pinnedIds(); let worst = null, wp = Infinity;
    for (const t of state.markets.values()) {
      if (pinned.has(t.id) || state.locks.has(t.id)) continue;
      const p = priorityOf(t) - (t.lastSeenAt ? (env.now() - t.lastSeenAt) / MIN : 50);
      if (p < wp) { wp = p; worst = t; }
    }
    if (!worst) return false;
    state.markets.delete(worst.id); return true;
  }
  function ensureToken(mint, via) {
    if (!isMint(mint) || NON_MEME.has(mint)) return null;
    const id = tokenIdOf(mint);
    let t = state.markets.get(id);
    if (t) { if (via && !t.meta.via.includes(via) && t.meta.via.length < 6) t.meta.via.push(via); return t; }
    if (state.markets.size >= S().maxTokens && !evictOne()) return null;
    t = { id, mint, symbol: '?', name: '', meta: { discoveredAt: env.now(), via: via ? [via] : [], boostedAt: 0, links: [] }, snap: null, snapReqAt: 0, alt: null, altReqAt: 0, hist: [], ohlcv: {}, sec: null, secPending: false, secFailAt: 0, A: null, D: null, lastReqAt: 0, lastSeenAt: 0, isNew: true, noPair: 0 };
    const sn = state.seen[id]; if (sn && sn.sym) t.symbol = sn.sym;
    state.markets.set(id, t);
    return t;
  }
  function pushHist(t, sn) {
    const last = t.hist[t.hist.length - 1];
    if (isNum(sn.priceUsd) && (!last || sn.fetchedAt - last.t >= 4000)) {
      t.hist.push({ t: sn.fetchedAt, p: sn.priceUsd, liq: sn.liquidityUsd, mc: sn.marketCap != null ? sn.marketCap : sn.fdv });
      if (t.hist.length > 720) t.hist.shift();
    }
  }
  /* Race-Condition-Schutz: nur neuere Requests dürfen den State überschreiben. */
  function applySnapshot(sn, reqAt) {
    if (NON_MEME.has(sn.mint)) return false;
    const t = state.markets.get(sn.id) || ensureToken(sn.mint, 'DexScreener');
    if (!t) return false;
    if (t.snapReqAt && (reqAt < t.snapReqAt || (reqAt === t.snapReqAt && sn.cached))) {
      if (reqAt < t.snapReqAt) { state.scanner.lateIgnored++; if (S().debugMode) log.debug('SCANNER', `Verspätete Antwort für ${t.symbol} verworfen (Race-Schutz)`); }
      return false;
    }
    t.snap = sn; t.snapReqAt = reqAt; t.lastSeenAt = env.now(); t.noPair = 0;
    if (sn.symbol && sn.symbol !== '?') t.symbol = sn.symbol;
    if (sn.name) t.name = sn.name;
    mergeLinks(t, sn.links);
    if (!sn.cached) pushHist(t, sn);
    const mc = sn.marketCap != null ? sn.marketCap : sn.fdv;
    if (!state.seen[t.id] && isNum(mc)) state.seen[t.id] = { mc, t: env.now(), sym: t.symbol };
    return true;
  }
  function applyAlt(t, sn, reqAt) {
    if (t.altReqAt && reqAt < t.altReqAt) { state.scanner.lateIgnored++; return false; }
    t.alt = sn; t.altReqAt = reqAt; t.lastSeenAt = t.lastSeenAt || env.now();
    if ((t.symbol === '?' || !t.symbol) && sn.symbol) t.symbol = sn.symbol;
    if (!t.name && sn.name) t.name = sn.name;
    if (!t.snap || env.now() - t.snap.fetchedAt > S().staleAfterSec * SEC) pushHist(t, sn);
    return true;
  }

  /* ---------- Data Layer: Discovery, Pairs, Cross-Check, OHLCV, RPC, Security ---------- */
  const listValidator = d => (Array.isArray(d) ? null : 'Antwort ist keine Liste');
  const gtValidator = d => (d && Array.isArray(d.data) ? null : 'unerwartetes Schema');
  async function discovery() {
    const now = env.now(), sc = state.scanner;
    if (now - sc.lastDisc >= S().discoveryIntervalSec * SEC || (state.markets.size < 5 && now - sc.lastDisc >= 5 * SEC)) {
      sc.lastDisc = now;
      const eps = [['/token-profiles/latest/v1', 'Profile'], ['/token-boosts/latest/v1', 'Boost'], ['/token-boosts/top/v1', 'Top-Boost']];
      const res = await Promise.allSettled(eps.map(([p]) => http.request('dexDisc', DEX_API + p, { cacheMs: 5 * SEC, validate: listValidator, keepRaw: S().rawApiLog })));
      let added = 0;
      res.forEach((r, i) => {
        if (r.status !== 'fulfilled') { noteApiError('dexDisc', r.reason); return; }
        for (const x of r.value.data) {
          if (!x || x.chainId !== 'solana' || !isMint(x.tokenAddress)) continue;
          const had = state.markets.has(tokenIdOf(x.tokenAddress));
          const t = ensureToken(x.tokenAddress, 'DexScreener ' + eps[i][1]);
          if (!t) continue;
          if (!had) added++;
          if (i > 0) t.meta.boostedAt = now;
          mergeLinks(t, normLinks(x.links, 'type'));
        }
      });
      if (added) log.info('SCANNER', `${added} neue Tokens entdeckt (Universe: ${state.markets.size})`);
    }
    if (S().ffCrossCheck && now - sc.lastGtDisc >= 15 * SEC) {
      sc.lastGtDisc = now;
      const kind = sc.gtKind++ % 2 ? 'trending_pools' : 'new_pools';
      try {
        const r = await http.request('gecko', `${GT_API}/networks/solana/${kind}?page=1`, { cacheMs: 10 * SEC, headers: GT_HEADERS, validate: gtValidator, keepRaw: S().rawApiLog });
        for (const it of r.data.data) {
          const sn = normGtPool(it, r.fetchedAt); if (!sn) continue;
          const t = ensureToken(sn.mint, 'GeckoTerminal ' + (kind === 'new_pools' ? 'New' : 'Trending'));
          if (t) applyAlt(t, sn, r.fetchedAt);
        }
      } catch (e) { noteApiError('gecko', e); }
    }
  }
  async function fetchChunk(mints, noCache) {
    const now0 = env.now();
    for (const m of mints) { const t = state.markets.get(tokenIdOf(m)); if (t) t.lastReqAt = now0; }
    const r = await http.request('dexPairs', DEX_API + '/tokens/v1/solana/' + mints.join(','), { cacheMs: noCache ? 0 : 800, noCache: !!noCache, validate: listValidator, keepRaw: S().rawApiLog });
    const best = {}, solRatios = [];
    for (const p of r.data) {
      const sn = normDexPair(p, r.fetchedAt);
      if (sn && p.quoteToken && p.quoteToken.address === WSOL && sn.priceNative > 0 && sn.priceUsd > 0) solRatios.push(sn.priceUsd / sn.priceNative);
      if (!sn || !mints.includes(sn.mint)) continue;
      const cur = best[sn.mint];
      if (!cur || (sn.liquidityUsd || 0) > (cur.liquidityUsd || 0)) best[sn.mint] = sn;
    }
    // SOL/USD = priceUsd / priceNative bei SOL-quotierten Pools (reale Daten, nur Fallback wenn Direktpreis fehlt/alt)
    if (!r.cached && solRatios.length >= 3 && (!state.sol || state.sol.derived || env.now() - state.sol.at > MIN)) {
      const med = median(solRatios);
      if (isNum(med) && med > 1 && med < 100000) state.sol = { usd: m6(med), at: r.fetchedAt, reqAt: r.fetchedAt, chg: state.sol ? state.sol.chg : null, derived: true, n: solRatios.length };
    }
    let applied = 0;
    for (const m of mints) {
      const sn = best[m];
      if (sn) { sn.cached = !!r.cached; if (applySnapshot(sn, r.fetchedAt)) applied++; }
      else { const t = state.markets.get(tokenIdOf(m)); if (t && !r.cached) t.noPair++; }
    }
    return applied;
  }
  async function fetchMarket() {
    const budget = Math.min(S().chunksPerTick, http.remaining('dexPairs'));
    if (budget <= 0) return;
    const scored = [...state.markets.values()].map(t => ({ t, p: priorityOf(t) })).sort((a, b) => b.p - a.p);
    const first = []; const used = new Set();
    for (const { t } of scored) { if (first.length >= 30) break; first.push(t.mint); used.add(t.mint); }
    const rest = scored.map(x => x.t).filter(t => !used.has(t.mint)).sort((a, b) => a.lastReqAt - b.lastReqAt).map(t => t.mint);
    const chunks = [first];
    for (let i = 0; i < rest.length && chunks.length < budget; i += 30) chunks.push(rest.slice(i, i + 30));
    const res = await Promise.allSettled(chunks.map(ch => fetchChunk(ch)));
    res.forEach(r => { if (r.status === 'rejected') noteApiError('dexPairs', r.reason); });
  }
  async function refreshToken(t) {
    if (t.snap && env.now() - t.snap.fetchedAt < 1500) return;
    try { await fetchChunk([t.mint], true); }
    catch (e) { noteApiError('dexPairs', e); log.warn('TRADE', `Pre-Trade-Refresh für ${t.symbol} fehlgeschlagen: ${e.message}`); }
  }
  /* SOL-Preis (für Fee Engine) – eigener, seltener Request, damit Token-Batches nicht durch WSOL-Pairs aufgebläht werden. */
  async function updateSolPrice(force) {
    if (!force && state.sol && env.now() - state.sol.reqAt < 20 * SEC) return;
    if (state.scanner.solBusy) return;
    state.scanner.solBusy = true;
    try {
      const r = await http.request('dexSol', DEX_API + '/tokens/v1/solana/' + WSOL, { cacheMs: 10 * SEC, validate: listValidator });
      let best = null;
      for (const p of r.data) {
        const sn = normDexPair(p, r.fetchedAt);
        const q = p && p.quoteToken && p.quoteToken.address;
        if (!sn || sn.mint !== WSOL || (q !== USDC && q !== USDT) || !isNum(sn.priceUsd)) continue;
        if (!best || (sn.liquidityUsd || 0) > (best.liquidityUsd || 0)) best = sn;
      }
      if (best && (!state.sol || state.sol.derived || r.fetchedAt >= state.sol.reqAt)) state.sol = { usd: best.priceUsd, at: best.fetchedAt, reqAt: r.fetchedAt, chg: best.chg, liq: best.liquidityUsd, derived: false };
    } catch (e) { noteApiError('dexSol', e); }
    finally { state.scanner.solBusy = false; }
  }
  async function crossCheck() {
    const now = env.now(), sc = state.scanner;
    const dexDown = ['OFFLINE', 'STALE'].includes(http.status('dexPairs'));
    if (!S().ffCrossCheck && !dexDown) return;
    if (now - sc.lastCross < (dexDown ? 8 : 12) * SEC) return;
    sc.lastCross = now;
    const pairs = [];
    const add = t => { const pa = (t.snap && t.snap.pairAddress) || (t.alt && t.alt.pairAddress); if (pa && !pairs.includes(pa) && pairs.length < 30) pairs.push(pa); };
    for (const id of pinnedIds()) { const t = state.markets.get(id); if (t) add(t); }
    [...state.markets.values()].filter(t => t.A).sort((a, b) => b.A.finalScore - a.A.finalScore).slice(0, 30).forEach(add);
    if (!pairs.length) return;
    try {
      const r = await http.request('gecko', `${GT_API}/networks/solana/pools/multi/${pairs.join(',')}`, { headers: GT_HEADERS, validate: gtValidator, keepRaw: S().rawApiLog });
      for (const it of r.data.data) { const sn = normGtPool(it, r.fetchedAt); if (!sn) continue; const t = state.markets.get(sn.id); if (t) applyAlt(t, sn, r.fetchedAt); }
    } catch (e) { noteApiError('gecko', e); }
  }
  async function fetchOhlcv(id, tf = '1m', force = false) {
    const t = state.markets.get(id); if (!t) throw new Error('Token nicht im Scanner');
    const pair = (t.snap && t.snap.pairAddress) || (t.alt && t.alt.pairAddress);
    if (!pair) throw new Error('Keine Pool-Adresse bekannt – Chart nicht verfügbar');
    const agg = { '1m': 1, '5m': 5, '15m': 15 }[tf]; if (!agg) throw new Error('Ungültiger Timeframe');
    const r = await http.request('gecko', `${GT_API}/networks/solana/pools/${pair}/ohlcv/minute?aggregate=${agg}&limit=300&currency=usd`, {
      cacheMs: force ? 0 : 30 * SEC, noCache: force, headers: GT_HEADERS,
      validate: d => (d && d.data && d.data.attributes && Array.isArray(d.data.attributes.ohlcv_list) ? null : 'unerwartetes OHLCV-Schema')
    });
    const candles = normOhlcv(r.data);
    t.ohlcv[tf] = { candles, fetchedAt: r.fetchedAt, pair, cached: r.cached };
    return t.ohlcv[tf];
  }
  async function fetchCandlesForBacktest(id, tf) {
    const t = state.markets.get(id); if (!t) throw new Error('Token nicht im Scanner');
    const pair = (t.snap && t.snap.pairAddress) || (t.alt && t.alt.pairAddress);
    if (!pair) throw new Error('Keine Pool-Adresse bekannt');
    const agg = { '1m': 1, '5m': 5, '15m': 15 }[tf];
    const r = await http.request('gecko', `${GT_API}/networks/solana/pools/${pair}/ohlcv/minute?aggregate=${agg}&limit=1000&currency=usd`, { cacheMs: 60 * SEC, headers: GT_HEADERS, validate: d => (d && d.data && d.data.attributes && Array.isArray(d.data.attributes.ohlcv_list) ? null : 'unerwartetes OHLCV-Schema') });
    return { candles: normOhlcv(r.data), fetchedAt: r.fetchedAt, pair };
  }
  function ohlcvForPositions() {
    if (env.now() - state.scanner.lastOhlcv < 60 * SEC || !state.positions.length) return;
    state.scanner.lastOhlcv = env.now();
    for (const p of state.positions.slice(0, 3)) fetchOhlcv(p.tokenId, '1m').catch(e => noteApiError('gecko', e));
  }
  function rpcEndpoints() {
    return S().rpcUrls.split(',').map(x => safeUrl(x.trim())).filter(Boolean).slice(0, 4).map((url, i) => {
      const name = 'rpc' + i; const src = http.sources[name];
      if (src && src.cfg.url !== url) delete http.sources[name];
      if (!http.sources[name]) http.define(name, { label: 'RPC ' + (i + 1) + ' · ' + maskUrl(url).replace('https://', ''), limitPerMin: 60, staleMs: 2 * MIN, kind: 'rpc', url });
      return { name, url };
    });
  }
  const RANK = { ONLINE: 0, UNKNOWN: 1, DEGRADED: 2, STALE: 3, OFFLINE: 4 };
  function rankedRpc() {
    return rpcEndpoints().sort((a, b) => (RANK[http.status(a.name)] - RANK[http.status(b.name)]) || ((http.sources[a.name].latency || 9e9) - (http.sources[b.name].latency || 9e9)));
  }
  const rpcValidator = d => (!d || typeof d !== 'object' ? 'keine JSON-RPC-Antwort' : d.error ? 'RPC-Fehler: ' + str(d.error.message, 100) : !('result' in d) ? 'result fehlt' : null);
  async function rpcCall(method, params, o = {}) {
    const eps = rankedRpc(); if (!eps.length) throw httpError('NO_RPC', 'Keine gültige RPC-URL konfiguriert');
    let lastErr;
    for (const ep of eps.slice(0, o.single ? 1 : 2)) {
      try {
        const r = await http.request(ep.name, ep.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), cacheMs: o.cacheMs || 0, maskInLog: true, keepRaw: S().rawApiLog, validate: rpcValidator });
        return r.data.result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  async function rpcPing() {
    const now = env.now(); if (now - state.scanner.lastRpc < 10 * SEC) return;
    state.scanner.lastRpc = now;
    const eps = rankedRpc(); if (!eps.length) return;
    const all = now - state.scanner.lastRpcAll > 60 * SEC;
    if (all) state.scanner.lastRpcAll = now;
    const targets = all ? eps : eps.slice(0, 1);
    const res = await Promise.allSettled(targets.map(async ep => {
      const t0 = env.now();
      const r = await http.request(ep.name, ep.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }), maskInLog: true, validate: d => (d && isNum(d.result) ? null : rpcValidator(d) || 'ungültiger Slot') });
      return { ep, slot: r.data.result, ms: env.now() - t0 };
    }));
    const ok = res.filter(x => x.status === 'fulfilled').map(x => x.value).sort((a, b) => RANK[http.status(a.ep.name)] - RANK[http.status(b.ep.name)]);
    if (ok.length) { const b = ok[0]; state.rpc.prevSlot = state.rpc.slot; state.rpc.slot = b.slot; state.rpc.slotAt = env.now(); state.rpc.latency = b.ms; state.rpc.endpoint = http.sources[b.ep.name].cfg.label; }
    res.forEach(x => { if (x.status === 'rejected') noteApiError('rpc', x.reason); });
  }
  function enqueueSecurity(t, prio, force) {
    if (t.secPending) return;
    if (!force && t.sec && env.now() - t.sec.checkedAt < S().securityTtlMin * MIN && (t.sec.sources.rpc || t.sec.sources.rug)) return;
    if (!force && t.secFailAt && env.now() - t.secFailAt < 2 * MIN) return;
    const q = state.secQueue.find(x => x.id === t.id);
    if (q) q.prio = Math.max(q.prio, prio); else state.secQueue.push({ id: t.id, prio });
    if (state.secQueue.length > 60) { state.secQueue.sort((a, b) => b.prio - a.prio); state.secQueue.length = 60; }
  }
  async function checkSecurity(mint) {
    const s = S(); let mintInfo = null, holders = null, rug = null;
    try { mintInfo = normMintAccount(await rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }])); }
    catch (e) { noteApiError('rpc', e); }
    if (s.ffHolderAnalysis && mintInfo && mintInfo.exists && mintInfo.supply) {
      try { holders = normLargest(await rpcCall('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], { single: true }), mintInfo.supply); }
      catch (e) { if (s.debugMode) log.debug('SECURITY', 'Holder-Daten nicht verfügbar: ' + e.message); }
    }
    if (s.ffRugcheck) {
      try { const r = await http.request('rugcheck', `${RUG_API}/tokens/${mint}/report/summary`, { cacheMs: 10 * MIN, keepRaw: s.rawApiLog, validate: d => (d && typeof d === 'object' && !Array.isArray(d) ? null : 'unerwartetes Schema') }); rug = normRug(r.data); }
      catch (e) { noteApiError('rugcheck', e); }
    }
    return buildSecurity(mintInfo, holders, rug, env.now());
  }
  async function processSecurity() {
    if (state.secBusy || !state.secQueue.length) return;
    state.secQueue.sort((a, b) => b.prio - a.prio);
    const item = state.secQueue.shift();
    const t = state.markets.get(item.id); if (!t) return;
    state.secBusy = true; t.secPending = true;
    try {
      const sec = await checkSecurity(t.mint);
      t.sec = sec;
      if (!sec.sources.rpc && !sec.sources.rug) t.secFailAt = env.now();
      log.sec(`Security ${t.symbol} (${shortAddr(t.mint)}): ${sec.status}`, { flags: sec.flags.map(f => f.code), sources: sec.sources });
      if (sec.status === 'CRITICAL') { alert('SECURITY', t, sec.flags.filter(f => f.level === 'CRITICAL').map(f => f.msg).join('; '), 'WARNING', { cooldownMs: DAY }); }
    } catch (e) { t.secFailAt = env.now(); log.warn('SECURITY', `Security-Check ${t.symbol} fehlgeschlagen: ${e.message}`); }
    finally { t.secPending = false; state.secBusy = false; }
  }

  /* ---------- Portfolio, Gebühren, Price Impact ---------- */
  function estImpact(size, liq) { return isNum(liq) && liq > 0 && isNum(size) && size >= 0 ? size / (liq / 2 + size) : null; }
  function estFees(sizeUsd) {
    const sol = state.sol && state.sol.usd; if (!isNum(sol) || !isNum(sizeUsd)) return null;
    const s = S();
    const network = BASE_FEE_LAMPORTS / 1e9 * sol, priority = s.priorityFeeLamports / 1e9 * sol, dex = sizeUsd * s.dexFeePct / 100;
    return { network: m6(network), priority: m6(priority), dex: m6(dex), total: m6(network + priority + dex), solUsd: sol, lamports: BASE_FEE_LAMPORTS + s.priorityFeeLamports };
  }
  function equityInfo() {
    let exposure = 0, value = 0, unknown = 0;
    for (const p of state.positions) { exposure += p.costUsd; if (isNum(p.value)) value += p.value; else { value += p.costUsd; unknown++; } }
    const equity = state.portfolio.cash + value;
    return { equity, cash: state.portfolio.cash, exposure, value, unknown, exposurePct: equity > 0 ? exposure / equity * 100 : 0, estimated: unknown > 0 };
  }
  function valuePosition(pos, p, liq) {
    const gross = pos.qty * p; const imp = estImpact(gross, liq); const fees = estFees(gross);
    if (imp == null || !fees) return { net: null, impactPct: imp != null ? imp * 100 : null };
    return { net: gross * (1 - imp) - fees.total, impactPct: imp * 100, fees };
  }
  let healthCache = { at: -1, val: null };
  function systemHealth() {
    const now = env.now();
    if (healthCache.val && now - healthCache.at < 500) return healthCache.val;
    let val;
    if (!env.online()) val = { score: 0, parts: { offline: true } };
    else {
      const conf = n => SOURCE_STATUS_CONF[http.status(n)];
      const rpcs = rpcEndpoints().map(e => conf(e.name));
      const toks = [...state.markets.values()].filter(t => t.snap);
      const freshShare = toks.length ? toks.filter(t => now - t.snap.fetchedAt <= S().staleAfterSec * SEC).length / toks.length : 0;
      const crit = ['dexPairs', ...rpcEndpoints().map(e => e.name)].map(n => http.snapshot(n)).filter(x => x && x.total > 0);
      const dexErr = (http.snapshot('dexPairs') || {}).errorRate;
      const rpcErr = crit.filter(x => x.kind === 'rpc').map(x => x.errorRate || 0);
      const errRate = dexErr == null && !rpcErr.length ? null : Math.max(dexErr || 0, rpcErr.length ? Math.min(...rpcErr) : 0);
      const parts = { dexPairs: conf('dexPairs'), rpc: rpcs.length ? Math.max(...rpcs) : 0, freshness: Math.round(freshShare * 100), errors: errRate == null ? 50 : Math.round(100 - errRate * 100) };
      const w = { dexPairs: 0.4, rpc: 0.15, freshness: 0.3, errors: 0.15 };
      let tot = 0, ws = 0; for (const [k, wt] of Object.entries(w)) if (parts[k] != null) { tot += parts[k] * wt; ws += wt; }
      val = { score: Math.round(tot / ws), parts };
    }
    healthCache = { at: now, val };
    return val;
  }
  function bucketSeries(hist, now, span = 30 * MIN, step = 30 * SEC) {
    const n = Math.floor(span / step), out = new Array(n).fill(null);
    for (const h of hist) { const i = Math.floor((h.t - (now - span)) / step); if (i >= 0 && i < n) out[i] = h.p; }
    for (let i = 1; i < n; i++) if (out[i] == null) out[i] = out[i - 1];
    return out;
  }
  function corrBetween(ta, tb, now) {
    const a = bucketSeries(ta.hist, now), b = bucketSeries(tb.hist, now); const ra = [], rb = [];
    for (let i = 1; i < a.length; i++) if (a[i] && a[i - 1] && b[i] && b[i - 1]) { ra.push(Math.log(a[i] / a[i - 1])); rb.push(Math.log(b[i] / b[i - 1])); }
    return pearson(ra, rb);
  }
  function maxCorrelation(t) {
    const now = env.now(); let best = null;
    for (const p of state.positions) {
      if (p.tokenId === t.id) continue;
      const pt = state.markets.get(p.tokenId); if (!pt) continue;
      const r = corrBetween(t, pt, now);
      if (r != null && (!best || r > best.r)) best = { r, sym: p.symbol };
    }
    return best;
  }
  function positionCorrelations() {
    const now = env.now(), out = [];
    for (let i = 0; i < state.positions.length; i++) for (let j = i + 1; j < state.positions.length; j++) {
      const a = state.markets.get(state.positions[i].tokenId), b = state.markets.get(state.positions[j].tokenId);
      if (!a || !b) continue;
      out.push({ a: state.positions[i].symbol, b: state.positions[j].symbol, r: corrBetween(a, b, now) });
    }
    return out;
  }

  /* ---------- Position Sizing ---------- */
  function sizePosition(t, A, leadId, manualSize) {
    const s = S(), eqi = equityInfo(), eq = eqi.equity;
    if (!isNum(eq) || eq <= 0) return { size: 0, reason: 'Kein Kapital verfügbar' };
    if (!A) return { size: 0, reason: 'Keine Analyse vorhanden' };
    const maxPos = eq * s.maxPositionPct / 100;
    if (manualSize != null) {
      if (!isNum(manualSize) || manualSize <= 0) return { size: 0, reason: 'Ungültiger Betrag' };
      if (manualSize < MIN_ORDER_USD) return { size: 0, reason: `Betrag < Minimum ${fmtUsd(MIN_ORDER_USD)}` };
      if (manualSize > maxPos + 1e-9) return { size: 0, reason: `Betrag über max. Positionsgröße (${fmtUsd(maxPos)})` };
      return { size: m2(manualSize), manual: true, capBy: 'manuell', factors: {} };
    }
    if (A.confidence.total < s.minConfidence) return { size: 0, reason: `Datenqualität unzureichend (Confidence ${A.confidence.total}) → Position Size 0` };
    const cfg = leadId && state.strategies[leadId];
    const basePct = Math.min(cfg ? cfg.positionSizePct : s.maxPositionPct / 2, s.maxPositionPct);
    const fRisk = clamp(1.2 - A.risk.total / 100, 0.2, 1), fConf = clamp((A.confidence.total - 40) / 60, 0, 1);
    const fVol = A.price.volPct != null ? clamp(1 - Math.max(0, A.price.volPct - 5) / 30, 0.3, 1) : 0.6;
    const liq = A.liq.usd, mi = s.maxSlippagePct / 2 / 100;
    const caps = {
      Strategie: eq * basePct / 100 * fRisk * fConf * fVol,
      Liquidität: isNum(liq) && liq > 0 ? mi * (liq / 2) / (1 - mi) : 0,
      Exposure: Math.max(0, eq * s.maxExposurePct / 100 - eqi.exposure),
      'Max. Position': maxPos,
      Cash: Math.max(0, state.portfolio.cash * 0.98)
    };
    const capBy = Object.entries(caps).sort((a, b) => a[1] - b[1])[0];
    const size = Math.max(0, capBy[1]);
    const factors = { basePct, fRisk: m2(fRisk), fConf: m2(fConf), fVol: m2(fVol), caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, m2(v)])) };
    if (size < MIN_ORDER_USD) return { size: 0, reason: `Größe ${fmtUsd(size)} < Minimum ${fmtUsd(MIN_ORDER_USD)} (begrenzt durch ${capBy[0]})`, factors, capBy: capBy[0] };
    return { size: m2(size), capBy: capBy[0], factors };
  }

  /* ---------- Execution Check (harte Regeln, Portfolio, Limits, Cooldowns) ---------- */
  function closedTradesRecent(n) { return state.journal.filter(j => j.status === 'CLOSED').slice(0, n); }
  function globalBlockers({ auto, ownOrder = null } = {}) {
    const B = []; const add = (c, m) => B.push(mkBlocker(c, m));
    const b = state.bot, s = S(), now = env.now(), r = state.risk;
    if (b.emergency) add('EMERGENCY_STOP', 'Emergency Stop aktiv' + (b.emergencyReason ? ': ' + b.emergencyReason : ''));
    if (state.mode === 'LIVE') add('LIVE_UNAVAILABLE', 'LIVE: kein verifizierter Wallet-/Swap-Provider (REQUIRES EXTERNAL PROVIDER)');
    if (state.mode === 'READ_ONLY') add('MODE_READ_ONLY', 'READ ONLY / WATCH-ONLY: Trades immer blockiert');
    if (b.safeMode) add('SAFE_MODE', 'Safe Mode: keine neuen Käufe' + (b.safeAuto ? ' (automatisch nach Fehlern aktiviert)' : ''));
    if (auto) {
      if (!b.autoTrading) add('AUTO_TRADING_OFF', 'Auto-Trading ist AUS (Bot analysiert nur)');
      if (state.mode === 'PAPER') add('PAPER_MANUAL', 'PAPER-Modus: nur manuelle Trades');
      if (b.state === 'RECOVERING' || b.state === 'STARTING') add('RECOVERING', 'Recovery – warte auf ausreichende Datenqualität');
      else if (b.state !== 'RUNNING') add('BOT_NOT_RUNNING', 'Bot-Status: ' + b.state);
    }
    if (!env.online()) add('OFFLINE', 'Keine Netzwerkverbindung');
    const h = systemHealth(); if (h.score < s.minSystemHealth) add('SYSTEM_UNHEALTHY', `System Health ${h.score} < ${s.minSystemHealth}`);
    if (!state.sol || now - state.sol.at > 5 * MIN) add('FEE_UNKNOWN', 'SOL-Preis unbekannt/veraltet → Gebühren nicht berechenbar');
    if (state.reconciliation.required) add('RECONCILIATION_REQUIRED', 'Abgleich nach Neustart erforderlich – bitte prüfen & bestätigen');
    const rpcSt = rpcEndpoints().map(e => http.status(e.name));
    if (rpcSt.length && rpcSt.every(x => x === 'OFFLINE') && (!s.ffRugcheck || http.status('rugcheck') === 'OFFLINE')) add('SECURITY_SOURCES_DOWN', 'Alle Security-Quellen (RPC' + (s.ffRugcheck ? ', RugCheck' : '') + ') OFFLINE');
    if (r.dailyLimitHit) add('DAILY_LOSS_LIMIT', `Tagesverlust-Limit erreicht (${fmtSigned(r.dailyPnl)})`);
    if (r.globalPauseUntil > now) add('GLOBAL_PAUSE', `Globale Pause nach Verlustserie – noch ${fmtAge(r.globalPauseUntil - now)}`);
    if (r.lossCooldownUntil > now) add('LOSS_COOLDOWN', `Loss-Cooldown – noch ${fmtAge(r.lossCooldownUntil - now)}`);
    const hourBuys = r.buyTimes.filter(x => now - x < HOUR).length;
    if (hourBuys >= s.maxTradesPerHour) add('OVERTRADING', `${hourBuys} Käufe in 60 min (Limit ${s.maxTradesPerHour})`);
    else {
      const last = closedTradesRecent(5);
      if (last.length === 5 && now - last[0].closedAt < 30 * MIN && avg(last.map(j => j.holdMs || 0)) < 2 * MIN) add('OVERTRADING', 'Sehr kurze Haltezeiten der letzten 5 Trades – Throttle');
      else if (last.length === 5 && avg(last.map(j => j.sizeUsd > 0 ? (j.slippageUsd || 0) / j.sizeUsd * 100 : 0)) > s.maxSlippagePct * 0.8) add('OVERTRADING', 'Hohe durchschnittliche Slippage – Throttle');
    }
    const active = state.orders.filter(o => !TERMINAL.has(o.state) && o.id !== ownOrder).length;
    if (active >= s.maxActiveOrders) add('MAX_ACTIVE_ORDERS', `${active} aktive Order(s)`);
    return B;
  }
  function execCheck(t, A, o = {}) {
    const { auto = false, preTrade = false, sizeUsd = null, ownOrder = null, lead = null, fromQueue = false } = o;
    const B = globalBlockers({ auto, ownOrder });
    const add = (c, m) => B.push(mkBlocker(c, m));
    const s = S(), now = env.now(), r = state.risk;
    const pos = openPos(t.id);
    const maxBuys = Math.min(s.maxBuysPerCoin, HARD_LIMITS.MAX_BUYS_PER_COIN);
    const bc = r.buyCount[t.id] || 0;
    if (bc >= maxBuys) add('BUY_LIMIT_REACHED', `Buy #${bc + 1} blockiert – max. ${maxBuys} Käufe pro Coin`);
    if (!pos && state.positions.length >= s.maxOpenPositions) add('MAX_POSITIONS', `${state.positions.length}/${s.maxOpenPositions} Positionen offen`);
    if (pos) {
      const pnl = isNum(pos.lastPrice) && isNum(pos.entryPrice) && pos.priceLabel !== 'STALE' ? (pos.lastPrice / pos.entryPrice - 1) * 100 : null;
      if (pnl == null || pnl < PYRAMID_MIN_PNL_PCT) add('NO_AVERAGING_DOWN', pnl == null ? 'Kein aktueller Positionspreis – kein Nachkauf' : `Nachkauf nur ab +${PYRAMID_MIN_PNL_PCT} % (aktuell ${fmtPct(pnl)}) – kein Martingale/DCA`);
    }
    if ((r.coinCooldown[t.id] || 0) > now) add('COOLDOWN_ACTIVE', `Coin-Cooldown noch ${fmtAge(r.coinCooldown[t.id] - now)}`);
    if (auto && (r.stratCooldown[t.id] || 0) > now) add('STRATEGY_COOLDOWN', `Strategie-Cooldown noch ${fmtAge(r.stratCooldown[t.id] - now)}`);
    if (!ownOrder && (state.locks.has(t.id) || (!fromQueue && state.queue.some(q => q.tokenId === t.id)))) add('TRADE_LOCKED', 'Laufende/eingereihte Order für diesen Token');
    const es = effectiveSnap(t, now, s);
    if (preTrade) {
      if (!es.snap || !isNum(es.snap.priceUsd)) add('PRICE_MISSING', 'Pre-Trade: kein gültiger Preis');
      else if (es.fallback) add('DATA_FALLBACK', 'Pre-Trade: nur Fallback-Quelle aktuell');
      else if (es.age > s.snapshotMaxAgeSec * SEC) add('DATA_STALE', `Pre-Trade: Daten ${fmtAge(es.age)} alt (max. ${s.snapshotMaxAgeSec}s)`);
    }
    if (!pos && state.positions.length) { const c = maxCorrelation(t); if (c && c.r >= s.correlationLimit) add('CONCENTRATION', `Korrelation ${c.r.toFixed(2)} mit offener Position ${c.sym}`); }
    const sizing = sizePosition(t, A, lead, sizeUsd);
    if (!(sizing.size > 0)) add('SIZE_ZERO', sizing.reason || 'Positionsgröße 0');
    else {
      const eq = equityInfo();
      if (eq.exposure + sizing.size > eq.equity * s.maxExposurePct / 100 + 1e-6) add('EXPOSURE_LIMIT', `Exposure ${fmtUsd(eq.exposure + sizing.size)} > ${s.maxExposurePct} % von ${fmtUsd(eq.equity)}`);
      if (sizing.size > state.portfolio.cash + 1e-9) add('INSUFFICIENT_CASH', `Cash ${fmtUsd(state.portfolio.cash)} < ${fmtUsd(sizing.size)}`);
      const imp = estImpact(sizing.size, es.snap ? es.snap.liquidityUsd : null);
      sizing.impactPct = imp != null ? imp * 100 : null;
      sizing.fees = estFees(sizing.size);
      if (imp == null) add('SLIPPAGE_TOO_HIGH', 'Price Impact nicht schätzbar (Liquidität unbekannt)');
      else if (imp * 100 > s.maxSlippagePct) add('SLIPPAGE_TOO_HIGH', `Erw. Price Impact ${(imp * 100).toFixed(2)} % > ${s.maxSlippagePct} %`);
    }
    return { blockers: sortBlockers(B), sizing };
  }

  /* ---------- Orders (State Machine, Idempotenz) ---------- */
  function newOrder(t, side, meta) {
    const now = env.now();
    return {
      id: 'ORD-' + now.toString(36).toUpperCase() + '-' + (++seqs.order).toString(36).toUpperCase(), key: meta.key, tokenId: t.id, mint: t.mint, symbol: t.symbol, side, mode: state.mode,
      auto: !!meta.auto, reason: str(meta.reason || '', 300), strategy: meta.strategy || null, buyNo: meta.buyNo || null, positionId: meta.positionId || null,
      state: 'DETECTED', history: [{ s: 'DETECTED', ts: now, note: meta.auto ? 'Bot-Kandidat' : 'Manuelle Aktion' }], createdAt: now,
      sizeUsd: null, qty: null, estPrice: null, fillPrice: null, expSlipPct: null, estFees: null, fees: null, txSig: null, simulated: true, latencyMs: null, blockers: null, decision: null
    };
  }
  function transition(o, to, note) {
    if (!(ORDER_TRANSITIONS[o.state] || []).includes(to)) throw new Error(`Ungültiger Order-Übergang ${o.state} → ${to}`);
    o.state = to; o.history.push({ s: to, ts: env.now(), note: note ? String(note).slice(0, 200) : undefined });
    if (S().debugMode) log.debug('TRADE', `${o.id} ${o.side} ${o.symbol}: ${to}${note ? ' – ' + note : ''}`);
  }
  function trimOrders() { if (state.orders.length > 300) state.orders = state.orders.filter((o, i) => i < 200 || !TERMINAL.has(o.state)); }
  function immutableDecision(t, A, D, ex, blockers) {
    return deepClone({
      ts: env.now(), tokenId: t.id, snapshot: t.snap ? { ...t.snap, links: undefined } : null, security: t.sec ? { status: t.sec.status, mintAuthority: t.sec.mintAuthority, freezeAuthority: t.sec.freezeAuthority, top10Pct: t.sec.top10Pct, flags: t.sec.flags, checkedAt: t.sec.checkedAt } : null,
      score: A.finalScore, opportunity: A.opportunity, confidence: A.confidence, risk: A.risk, components: A.components, signals: A.signals, tags: A.tags, pump: A.pump,
      strategies: A.strat ? A.strat.votes : null, trace: D.trace, blockers, sizing: ex.sizing, decision: blockers.length ? 'REJECTED' : 'APPROVED', reason: D.reason, dataQuality: A.labels, regime: state.regime.tags, sol: state.sol ? state.sol.usd : null
    });
  }
  function recordRejection(blockers) {
    state.metrics.counters.rejected++;
    const c = blockers[0] && blockers[0].code; if (c) state.metrics.preTradeRejects[c] = (state.metrics.preTradeRejects[c] || 0) + 1;
  }
  function stratStat(id, field) { if (!id) return; const st = state.stratStats[id] || (state.stratStats[id] = { signals: 0, accepted: 0, rejected: 0, executed: 0, profitable: 0, unprofitable: 0 }); st[field] = (st[field] || 0) + 1; }
  function sourcesUsed(t) { const s = []; if (t.snap) s.push('DexScreener'); if (t.alt) s.push('GeckoTerminal'); if (t.sec && t.sec.sources.rpc) s.push('Solana RPC'); if (t.sec && t.sec.sources.rug) s.push('RugCheck'); return s; }

  async function executeBuy(tokenId, o = {}) {
    const { auto = false, sizeUsd = null, reason = '', lead = null, fromQueue = false } = o;
    const t0 = env.now();
    const t = state.markets.get(tokenId);
    if (!t) return { ok: false, blockers: [mkBlocker('PRICE_MISSING', 'Token nicht im Scanner')] };
    const bc = state.risk.buyCount[tokenId] || 0, buyNo = bc + 1;
    const key = `${tokenId}:BUY:${buyNo}:${state.session ? state.session.id : 's0'}`;
    if (state.locks.has(tokenId)) { log.risk(`Parallele Aktion für ${t.symbol} verhindert (Trade Lock)`); return { ok: false, blockers: [mkBlocker('TRADE_LOCKED')] }; }
    if (state.usedKeys.has(key)) { log.risk(`Duplicate Order verhindert: Buy #${buyNo} ${t.symbol}`); return { ok: false, blockers: [mkBlocker('DUPLICATE_ORDER', `Buy #${buyNo} für ${t.symbol} existiert bereits`)] }; }
    state.locks.add(tokenId); state.usedKeys.set(key, 'pending');
    const ord = newOrder(t, 'BUY', { key, auto, reason, strategy: lead, buyNo });
    state.orders.unshift(ord); trimOrders();
    try {
      transition(ord, 'ANALYZING', 'Pre-Trade-Check mit frischen Daten');
      persistNow();
      await refreshToken(t);
      const ctx = buildCtx();
      const A = analyzeToken(t, ctx); t.A = A;
      const D = decideToken(t, A, { ...ctx, execCheck: null });
      const ex = execCheck(t, A, { auto, preTrade: true, sizeUsd, ownOrder: ord.id, lead: lead || D.strategy, fromQueue });
      const hard = auto ? D.analysisBlockers : D.analysisBlockers.filter(b => MANUAL_HARD.has(b.code) || (b.code === 'RISK_TOO_HIGH' && A.risk.level === 'CRITICAL'));
      const blockers = sortBlockers([...hard, ...ex.blockers]);
      ord.decision = immutableDecision(t, A, D, ex, blockers);
      if (blockers.length) {
        ord.blockers = blockers; transition(ord, 'REJECTED', blockers[0].code + ': ' + blockers[0].msg);
        state.usedKeys.delete(key); recordRejection(blockers); stratStat(lead || D.strategy, 'rejected');
        log.risk(`Buy ${t.symbol} abgelehnt: ${blockers.slice(0, 3).map(b => b.code).join(', ')}`);
        persistNow();
        return { ok: false, order: ord, blockers };
      }
      const size = ex.sizing.size, snap = t.snap, price = snap.priceUsd;
      const impact = estImpact(size, snap.liquidityUsd), fees = estFees(size);
      ord.sizeUsd = size; ord.estPrice = price; ord.expSlipPct = impact * 100; ord.estFees = fees;
      transition(ord, 'APPROVED', 'Alle Pre-Trade-Checks bestanden');
      transition(ord, 'SUBMITTING', state.mode + ' – keine echte Order');
      if (state.bot.emergency) { transition(ord, 'CANCELLED', 'Emergency Stop während Ausführung'); state.usedKeys.delete(key); persistNow(); return { ok: false, order: ord, blockers: [mkBlocker('EMERGENCY_STOP')] }; }
      transition(ord, 'SUBMITTED', 'Simulierte Übermittlung – keine Transaktion');
      transition(ord, 'CONFIRMING');
      const fillPrice = price * (1 + impact);
      const qty = (size - fees.total) / fillPrice;
      if (!(qty > 0)) throw new Error('Menge nach Gebühren ≤ 0');
      transition(ord, 'CONFIRMED', 'Simulierte Füllung: Live-Preis + geschätzter Price Impact');
      ord.fillPrice = fillPrice; ord.qty = qty; ord.fees = fees; ord.priceAt = snap.fetchedAt; ord.latencyMs = env.now() - t0;
      const leadId = lead || D.strategy;
      applyBuyFill(t, ord, A, D, { price: fillPrice, refPrice: price, qty, size, fees, impact, lead: leadId });
      state.risk.buyCount[tokenId] = buyNo;
      state.risk.buyTimes = state.risk.buyTimes.filter(x => env.now() - x < DAY); state.risk.buyTimes.push(env.now());
      state.risk.dailyTrades++;
      if (leadId && state.strategies[leadId]) state.risk.stratCooldown[tokenId] = env.now() + state.strategies[leadId].cooldownMin * MIN;
      transition(ord, 'COMPLETED', 'Order Receipt erstellt (SIMULATED)');
      state.usedKeys.set(key, ord.id);
      state.metrics.counters.executed++; state.metrics.minute.executed++; state.metrics.perf.exec = ord.latencyMs;
      stratStat(leadId, 'executed');
      audit(auto ? 'BOT' : 'USER', 'BUY', `${t.symbol} Buy #${buyNo}: ${fmtUsd(size)} @ ${fmtPrice(fillPrice)} (${state.mode})`, reason || D.reason);
      log.trade(`${state.mode} BUY #${buyNo} ${t.symbol}: ${fmtUsd(size)} @ ${fmtPrice(fillPrice)} · Impact ${(impact * 100).toFixed(2)} % · Fees ${fmtUsd(fees.total, 4)}`, { order: ord.id });
      alert('TRADE', t, `${state.mode} BUY #${buyNo}: ${fmtUsd(size)} @ ${fmtPrice(fillPrice)}`, 'SUCCESS', { cooldownMs: 0, key: ord.id });
      persistNow(); emit('trade', { order: ord });
      return { ok: true, order: ord };
    } catch (e) {
      if (!TERMINAL.has(ord.state)) { try { transition(ord, 'FAILED', e.message); } catch (x) { ord.state = 'FAILED'; } }
      state.usedKeys.delete(key);
      log.error('TRADE', `Buy ${t.symbol} fehlgeschlagen: ${e.message}`);
      persistNow();
      return { ok: false, order: ord, error: e.message };
    } finally { state.locks.delete(tokenId); emit('order', ord); }
  }
  function applyBuyFill(t, o, A, D, f) {
    const now = env.now();
    let pos = openPos(t.id);
    if (!pos) {
      pos = {
        id: 'T-' + now.toString(36).toUpperCase() + '-' + (++seqs.pos).toString(36).toUpperCase(), tokenId: t.id, mint: t.mint, symbol: t.symbol, name: t.name,
        pair: A.core.pairAddress, dexId: A.core.dexId, mode: state.mode, status: 'OPEN', openedAt: now, entries: [], exits: [],
        qty: 0, initialQty: 0, costUsd: 0, investedUsd: 0, feesUsd: 0, slippageUsd: 0, realizedUsd: 0, entryPrice: null,
        highest: f.refPrice, stop: null, stopType: 'PERCENT', tps: [], tpHit: [false, false, false], breakEven: false, trailing: false,
        strategy: f.lead || null, entryLiq: A.liq.usd, lastPrice: f.refPrice, lastPriceAt: now, priceLabel: 'LIVE', value: null, pnlUsd: null, pnlPct: null,
        mae2m: 0, timeExitFlag: false, exitPending: null, paramVersion: state.activeParam, entryScore: A.finalScore
      };
      state.positions.unshift(pos);
      journalOpen(pos, t, A, D, o);
    }
    pos.entries.push({ orderId: o.id, ts: now, price: f.price, refPrice: f.refPrice, qty: f.qty, usd: f.size, fees: f.fees.total, impactPct: f.impact * 100, latencyMs: o.latencyMs });
    const sq = sum(pos.entries.map(e => e.qty));
    pos.entryPrice = sum(pos.entries.map(e => e.price * e.qty)) / sq;
    pos.qty += f.qty; pos.initialQty += f.qty; pos.costUsd += f.size; pos.investedUsd += f.size; pos.feesUsd += f.fees.total;
    pos.slippageUsd += (f.size - f.fees.total) * (1 - f.refPrice / f.price);
    state.tradeSeq++;
    state.portfolio.cash = m6(state.portfolio.cash - f.size);
    state.portfolio.fees = m6(state.portfolio.fees + f.fees.total);
    setStops(pos, t);
    journalUpdate(pos);
  }
  function setStops(pos, t) {
    const s = S(), e = pos.entryPrice;
    let stop = e * (1 - s.stopLossPct / 100), type = 'PERCENT';
    const oh = t && t.ohlcv && t.ohlcv['1m'];
    if (s.useAtrStop && oh && oh.candles.length >= 20 && env.now() - oh.fetchedAt < 5 * MIN) {
      const a = atr(oh.candles, 14);
      if (a) { const as = e - s.atrMult * a; if (as > stop && as < e) { stop = as; type = 'ATR'; } }
    }
    if (!pos.trailing && !pos.breakEven) { pos.stop = stop; pos.stopType = type; }
    pos.tps = [s.tp1Pct, s.tp2Pct, s.tp3Pct].map(p => e * (1 + p / 100));
  }
  function exitDecision(pos, t, p, pnlPct, liq, now) {
    const s = S(), A = t && t.A;
    if (p <= pos.stop) return { code: pos.stopType === 'TRAILING' ? 'TRAILING_STOP' : pos.stopType === 'BREAK_EVEN' ? 'BREAK_EVEN' : pos.stopType === 'ATR' ? 'ATR_STOP' : 'STOP_LOSS', frac: 'ALL', detail: `Preis ${fmtPrice(p)} ≤ Stop ${fmtPrice(pos.stop)}` };
    if (isNum(liq) && isNum(pos.entryLiq) && pos.entryLiq > 0 && liq < pos.entryLiq * (1 - s.liqCollapsePct / 100)) return { code: 'LIQUIDITY_COLLAPSE', frac: 'ALL', detail: `Liquidität ${fmtUsd(liq)} (Entry ${fmtUsd(pos.entryLiq)})` };
    if (s.exitOnRiskCritical && A && (A.sec.status === 'CRITICAL' || (A.risk.level === 'CRITICAL' && A.confidence.total >= 50))) return { code: 'RISK_INCREASE', frac: 'ALL', detail: `Risiko ${A.risk.level} (${A.risk.total})` };
    if (pnlPct >= s.tp3Pct) return { code: 'TP3', frac: 'ALL', detail: `+${pnlPct.toFixed(1)} % ≥ TP3` };
    if (pnlPct >= s.tp1Pct && !pos.tpHit[0]) return { code: 'TP1', frac: s.tp1Frac, detail: `+${pnlPct.toFixed(1)} % ≥ TP1` };
    if (pnlPct >= s.tp2Pct && !pos.tpHit[1]) return { code: 'TP2', frac: s.tp2Frac, detail: `+${pnlPct.toFixed(1)} % ≥ TP2` };
    if (s.momentumReversalExit && A && isNum(A.price.chg.m5) && A.price.chg.m5 <= -10 && A.tx.ratio5 != null && A.tx.ratio5 < 0.4 && pnlPct < s.tp1Pct) return { code: 'MOMENTUM_REVERSAL', frac: 'ALL', detail: `5m ${fmtPct(A.price.chg.m5)}, Käufer ${(A.tx.ratio5 * 100).toFixed(0)} %` };
    const held = now - pos.openedAt;
    if (held >= s.timeExitMin * MIN && pnlPct < s.timeExitMinPnlPct) {
      if (!pos.timeExitFlag) { pos.timeExitFlag = true; alert('SELL_CANDIDATE', t, `Time Exit Candidate: ${pos.symbol} nach ${fmtAge(held)} nur ${fmtPct(pnlPct)}`, 'INFO', { key: 'time' }); }
      if (s.timeExitAuto) return { code: 'TIME_EXIT', frac: 'ALL', detail: `${fmtAge(held)} ohne erwartete Bewegung (${fmtPct(pnlPct)})` };
    }
    if (p <= pos.stop * 1.03) alert('SELL_CANDIDATE', t, `${pos.symbol} nahe am Stop (${fmtPrice(p)} / Stop ${fmtPrice(pos.stop)})`, 'WARNING', { key: 'nearstop' });
    return null;
  }
  async function managePositions() {
    const now = env.now(), s = S();
    for (const pos of [...state.positions]) {
      if (pos.status !== 'OPEN' || state.locks.has('pos:' + pos.id)) continue;
      const t = state.markets.get(pos.tokenId) || ensureToken(pos.mint, 'Position');
      const es = t ? effectiveSnap(t, now, s) : null;
      if (!es || !es.snap || !isNum(es.snap.priceUsd) || es.label === 'STALE' || es.label === 'UNKNOWN') {
        pos.priceLabel = es ? es.label : 'UNKNOWN'; pos.value = null; pos.pnlUsd = null; pos.pnlPct = null;
        if (!pos.staleSince) pos.staleSince = now;
        else if (now - pos.staleSince > MIN) alert('POSITION_DATA', t, `Keine aktuellen Preisdaten für ${pos.symbol} – PnL nicht verfügbar, Exits ausgesetzt`, 'WARNING');
        continue;
      }
      pos.staleSince = 0;
      const p = es.snap.priceUsd, liq = es.snap.liquidityUsd;
      pos.lastPrice = p; pos.lastPriceAt = es.snap.fetchedAt; pos.priceLabel = es.label; pos.highest = Math.max(pos.highest || p, p);
      const pnlPct = (p / pos.entryPrice - 1) * 100;
      if (now - pos.openedAt <= 2 * MIN) pos.mae2m = Math.min(pos.mae2m || 0, pnlPct);
      const val = valuePosition(pos, p, liq);
      pos.value = val.net; pos.exitImpactPct = val.impactPct;
      pos.pnlUsd = val.net != null ? val.net - pos.costUsd : null;
      pos.pnlPct = pos.pnlUsd != null && pos.costUsd > 0 ? pos.pnlUsd / pos.costUsd * 100 : null;
      if (pnlPct >= s.trailActivatePct && !pos.trailing) { pos.trailing = true; log.trade(`${pos.symbol}: Trailing Stop aktiviert (${fmtPct(pnlPct)})`); }
      if (pos.trailing) { const ts = pos.highest * (1 - s.trailPct / 100); if (ts > pos.stop) { pos.stop = ts; pos.stopType = 'TRAILING'; } }
      const ex = exitDecision(pos, t, p, pnlPct, liq, now);
      if (ex) await executeSell(pos.id, ex.frac, ex.code, { auto: true, detail: ex.detail });
    }
  }
  async function executeSell(posId, frac, reasonCode, o = {}) {
    const { auto = false, emergency = false, detail = '' } = o;
    const pos = state.positions.find(p => p.id === posId);
    if (!pos || pos.status !== 'OPEN') return { ok: false, error: 'Position nicht offen' };
    const lk = 'pos:' + pos.id;
    if (state.locks.has(lk)) return { ok: false, blockers: [mkBlocker('TRADE_LOCKED', 'Position wird bereits bearbeitet')] };
    const key = `${pos.id}:SELL:${pos.exits.length + 1}`;
    if (state.usedKeys.has(key)) return { ok: false, blockers: [mkBlocker('DUPLICATE_ORDER')] };
    state.locks.add(lk); state.usedKeys.set(key, 'pending');
    const t = state.markets.get(pos.tokenId) || ensureToken(pos.mint, 'Position');
    const ord = newOrder(t || { id: pos.tokenId, mint: pos.mint, symbol: pos.symbol }, 'SELL', { key, auto, reason: reasonCode + (detail ? ' – ' + detail : ''), strategy: pos.strategy, positionId: pos.id });
    state.orders.unshift(ord); trimOrders();
    const t0 = env.now();
    try {
      transition(ord, 'ANALYZING', emergency ? 'Emergency Exit – Pre-Exit-Check' : 'Pre-Exit-Check');
      persistNow();
      if (t) await refreshToken(t);
      const es = t ? effectiveSnap(t, env.now(), S()) : null;
      const B = [];
      if (!es || !es.snap || !isNum(es.snap.priceUsd)) B.push(mkBlocker('PRICE_MISSING', 'Kein verifizierter Preis – Exit wird nicht simuliert (kein Fantasiepreis)'));
      else if (es.label === 'STALE') B.push(mkBlocker('DATA_STALE', `Preis ${fmtAge(es.age)} alt – Exit ausgesetzt`));
      if (!estFees(1)) B.push(mkBlocker('FEE_UNKNOWN'));
      if (B.length) {
        pos.exitPending = { code: reasonCode, since: pos.exitPending ? pos.exitPending.since : env.now(), blocker: B[0].msg };
        ord.blockers = B; transition(ord, 'REJECTED', B[0].msg); state.usedKeys.delete(key); persistNow();
        return { ok: false, order: ord, blockers: B };
      }
      const p = es.snap.priceUsd, liq = es.snap.liquidityUsd;
      let qty = frac === 'ALL' ? pos.qty : Math.min(pos.qty, pos.initialQty * frac);
      if (pos.qty - qty < pos.initialQty * 0.01) qty = pos.qty;
      const gross = qty * p;
      let imp = estImpact(gross, liq); const impEst = imp == null;
      if (imp == null) imp = S().maxSlippagePct / 100;
      const fillPrice = p * (1 - imp), proceeds = qty * fillPrice, fees = estFees(proceeds), net = proceeds - fees.total;
      transition(ord, 'APPROVED', 'Pre-Exit-Check bestanden' + (impEst ? ' (Impact geschätzt: max. Slippage)' : ''));
      transition(ord, 'SUBMITTING', state.mode + ' – keine echte Order');
      transition(ord, 'SUBMITTED', 'Simulierte Übermittlung – keine Transaktion');
      transition(ord, 'CONFIRMING');
      transition(ord, 'CONFIRMED', 'Simulierte Füllung');
      const costPortion = pos.costUsd * (qty / pos.qty);
      const realized = net - costPortion;
      pos.exits.push({ orderId: ord.id, ts: env.now(), price: fillPrice, refPrice: p, qty, usd: net, fees: fees.total, impactPct: imp * 100, reason: reasonCode, realized });
      pos.qty -= qty; pos.costUsd -= costPortion;
      if (pos.qty <= pos.initialQty * 1e-9) { pos.qty = 0; pos.costUsd = 0; }
      pos.realizedUsd += realized; pos.feesUsd += fees.total; pos.slippageUsd += qty * (p - fillPrice); pos.exitPending = null;
      state.tradeSeq++;
      state.portfolio.cash = m6(state.portfolio.cash + net); state.portfolio.realized = m6(state.portfolio.realized + realized); state.portfolio.fees = m6(state.portfolio.fees + fees.total);
      const r = state.risk;
      r.coinCooldown[pos.tokenId] = env.now() + S().sellCooldownMin * MIN;
      r.dailyPnl = m6(r.dailyPnl + realized);
      ord.sizeUsd = net; ord.qty = qty; ord.fillPrice = fillPrice; ord.estPrice = p; ord.fees = fees; ord.expSlipPct = imp * 100; ord.latencyMs = env.now() - t0; ord.priceAt = es.snap.fetchedAt;
      if (reasonCode === 'TP1') { pos.tpHit[0] = true; if (S().breakEvenAfterTp1 && pos.qty > 0) { const be = pos.costUsd / pos.qty; if (be > pos.stop) { pos.stop = be; pos.stopType = 'BREAK_EVEN'; pos.breakEven = true; } } }
      if (reasonCode === 'TP2') pos.tpHit[1] = true;
      transition(ord, 'COMPLETED', 'Order Receipt erstellt (SIMULATED)');
      state.usedKeys.set(key, ord.id);
      log.trade(`${pos.mode} SELL ${pos.symbol} (${reasonCode}): ${fmtUsd(net)} @ ${fmtPrice(fillPrice)} · realisiert ${fmtSigned(realized)}`, { order: ord.id });
      audit(auto ? 'BOT' : 'USER', 'SELL', `${pos.symbol} ${reasonCode}: ${fmtUsd(net)} (${fmtSigned(realized)})`, detail);
      if (/STOP|BREAK_EVEN/.test(reasonCode)) alert('STOP_HIT', t, `${pos.symbol}: ${reasonCode} ${detail}`, 'WARNING', { cooldownMs: 0, key: ord.id });
      else if (/^TP/.test(reasonCode)) alert('TP_HIT', t, `${pos.symbol}: ${reasonCode} ${fmtSigned(realized)}`, 'SUCCESS', { cooldownMs: 0, key: ord.id });
      else alert('TRADE', t, `${pos.mode} SELL ${pos.symbol} (${reasonCode}): ${fmtSigned(realized)}`, 'INFO', { cooldownMs: 0, key: ord.id });
      if (pos.qty <= 0) closePosition(pos, reasonCode); else journalUpdate(pos);
      checkDailyLimit();
      persistNow(); emit('trade', { order: ord });
      return { ok: true, order: ord };
    } catch (e) {
      if (!TERMINAL.has(ord.state)) { try { transition(ord, 'FAILED', e.message); } catch (x) { ord.state = 'FAILED'; } }
      state.usedKeys.delete(key);
      log.error('TRADE', `Sell ${pos.symbol} fehlgeschlagen: ${e.message}`);
      persistNow();
      return { ok: false, order: ord, error: e.message };
    } finally { state.locks.delete(lk); emit('order', ord); }
  }
  function closePosition(pos, reason) {
    const now = env.now(), s = S(), r = state.risk;
    pos.status = 'CLOSED'; pos.closedAt = now; pos.exitReason = reason;
    state.positions = state.positions.filter(p => p.id !== pos.id);
    const pnl = pos.realizedUsd, win = pnl > 0;
    if (!win) {
      r.lossStreak++; r.lossCooldownUntil = now + s.lossCooldownMin * MIN;
      log.risk(`Verlust ${pos.symbol} ${fmtSigned(pnl)} → Loss-Cooldown ${s.lossCooldownMin} min (Serie ${r.lossStreak})`);
      if (r.lossStreak >= s.lossStreakLimit) {
        r.globalPauseUntil = now + s.globalPauseMin * MIN; r.reviewRequired = true;
        log.risk(`${r.lossStreak} Verluste in Folge → globale Pause ${s.globalPauseMin} min`);
        alert('RISK', null, `${r.lossStreak} Verluste in Folge → globale Pause ${s.globalPauseMin} min. Kontrollierter Review empfohlen.`, 'CRITICAL', { key: 'streak', cooldownMs: 0 });
      }
    } else r.lossStreak = 0;
    ensureSession();
    const se = state.session; se.trades++; if (win) se.wins++; else se.losses++; se.pnl = m6(se.pnl + pnl);
    journalClose(pos);
    stratStat(pos.strategy, win ? 'profitable' : 'unprofitable');
    const j = state.journal.find(x => x.id === pos.id);
    if (j && isNum(pos.mae2m) && pos.mae2m <= -5 && j.signals.some(x => x.strength >= 70)) {
      state.falseSignals.unshift({ ts: now, tradeId: pos.id, symbol: pos.symbol, signals: j.signals.filter(x => x.strength >= 70).map(x => x.type), mae2m: pos.mae2m, pnlUsd: pnl });
      if (state.falseSignals.length > 60) state.falseSignals.length = 60;
    }
    const eq = equityInfo(); state.hist.equity.push({ t: now, v: m2(eq.equity), realized: m2(state.portfolio.realized) }); if (state.hist.equity.length > 500) state.hist.equity.shift();
    maybeTune();
  }
  function checkDailyLimit() {
    const r = state.risk, s = S();
    const base = r.dailyStartEquity || state.portfolio.startCapital;
    if (!r.dailyLimitHit && r.dailyPnl <= -base * s.dailyLossLimitPct / 100) {
      r.dailyLimitHit = true;
      if (state.bot.autoTrading) { state.bot.autoTrading = false; audit('BOT', 'AUTO_TRADING_OFF', 'Tagesverlust-Limit erreicht'); }
      log.risk(`Tagesverlust-Limit erreicht (${fmtSigned(r.dailyPnl)}) → Auto-Trading deaktiviert`);
      alert('RISK', null, `Tagesverlust-Limit erreicht (${fmtSigned(r.dailyPnl)}) → Auto-Trading deaktiviert`, 'CRITICAL', { key: 'daily', cooldownMs: HOUR });
    }
  }

  /* ---------- Trade Journal ---------- */
  function journalOpen(pos, t, A, D, o) {
    state.journal.unshift({
      id: pos.id, tokenId: pos.tokenId, symbol: pos.symbol, name: t.name, mint: pos.mint, pair: pos.pair, dexId: pos.dexId, mode: pos.mode, status: 'OPEN',
      openedAt: pos.openedAt, closedAt: null, entries: [], exits: [], sizeUsd: 0, feesUsd: 0, slippageUsd: 0,
      score: A.finalScore, opportunity: A.opportunity, confidence: A.confidence.total, risk: { total: A.risk.total, level: A.risk.level },
      signals: A.signals.map(x => ({ type: x.type, strength: x.strength, reason: x.reason })), strategy: pos.strategy, auto: o.auto,
      reason: o.reason || D.reason, sources: sourcesUsed(t), tags: [...A.tags], regime: [...(state.regime.tags || [])],
      decision: o.decision, paramVersion: state.activeParam, result: null, exitReason: null, mae2m: null, holdMs: null
    });
    if (state.journal.length > 800) state.journal = state.journal.filter((j, i) => i < 600 || j.status === 'OPEN');
  }
  function journalUpdate(pos) {
    const j = state.journal.find(x => x.id === pos.id); if (!j) return;
    j.entries = deepClone(pos.entries); j.exits = deepClone(pos.exits); j.sizeUsd = m6(pos.investedUsd); j.feesUsd = m6(pos.feesUsd); j.slippageUsd = m6(pos.slippageUsd);
    j.mae2m = pos.mae2m; j.execLatencyMs = avg(pos.entries.map(e => e.latencyMs).filter(isNum));
  }
  function journalClose(pos) {
    journalUpdate(pos);
    const j = state.journal.find(x => x.id === pos.id); if (!j) return;
    j.status = 'CLOSED'; j.closedAt = pos.closedAt; j.exitReason = pos.exitReason; j.holdMs = pos.closedAt - pos.openedAt;
    j.result = { pnlUsd: m6(pos.realizedUsd), pnlPct: pos.investedUsd > 0 ? pos.realizedUsd / pos.investedUsd * 100 : null, win: pos.realizedUsd > 0 };
  }

  /* ---------- Trade Queue & Auto-Trading ---------- */
  function enqueue(tokenId, lead) {
    if (state.queue.some(q => q.tokenId === tokenId) || state.locks.has(tokenId) || state.queue.length >= 5) return false;
    state.queue.push({ tokenId, lead, at: env.now() });
    stratStat(lead, 'accepted');
    return true;
  }
  let queueBusy = false;
  async function processQueue() {
    if (queueBusy) return;
    queueBusy = true;
    try {
      while (state.queue.length) {
        if (state.bot.emergency) { state.queue = []; break; }
        if (state.orders.filter(o => !TERMINAL.has(o.state)).length >= S().maxActiveOrders) break;
        const q = state.queue.shift();
        const t = state.markets.get(q.tokenId); if (!t) continue;
        if (env.now() - q.at > 30 * SEC) { log.info('TRADE', `Queue-Eintrag ${t.symbol} verfallen (älter als 30 s)`); continue; }
        await executeBuy(q.tokenId, { auto: true, lead: q.lead, fromQueue: true, reason: t.D ? t.D.reason : '' });
      }
    } finally { queueBusy = false; }
  }
  async function maybeAutoTrade() {
    if (globalBlockers({ auto: true }).length) return;
    const cands = [...state.markets.values()].filter(t => t.D && t.D.decision === 'APPROVED').sort((a, b) => b.A.finalScore - a.A.finalScore);
    for (const t of cands) enqueue(t.id, t.D.strategy);
    if (state.queue.length) await processQueue();
  }

  /* ---------- Analyse aller Tokens ---------- */
  function buildCtx() {
    const eq = equityInfo();
    return { now: env.now(), S: S(), strategies: state.strategies, plannedSizeUsd: Math.max(0, (eq.equity || 0) * S().maxPositionPct / 100), execCheck: (t, A, o) => execCheck(t, A, o) };
  }
  function analyzeAll() {
    const ctx = buildCtx(), pinned = pinnedIds(), now = env.now();
    const funnel = Object.fromEntries(PIPELINE.map(p => [p, 0]));
    const reasons = {}; let fastPass = 0, approved = 0, cand = 0, rejected = 0, withSignals = 0; const analyses = [];
    for (const t of state.markets.values()) {
      if (!t.snap && !t.alt) { t.A = null; t.D = null; continue; }
      try { t.A = analyzeToken(t, ctx); t.D = decideToken(t, t.A, ctx); }
      catch (e) { log.error('SCANNER', `Analysefehler ${t.symbol}: ${e.message}`); t.A = null; t.D = null; continue; }
      analyses.push(t.A);
      for (let i = 0; i < t.D.trace.length && t.D.trace[i].ok === true; i++) funnel[t.D.trace[i].stage]++;
      if (t.D.fastPass) { fastPass++; enqueueSecurity(t, 100 + t.A.finalScore); }
      if (pinned.has(t.id)) enqueueSecurity(t, 1000);
      if (t.A.signals.some(x => !CONTEXT_SIGNALS.has(x.type))) withSignals++;
      if (t.D.decision === 'APPROVED') approved++;
      if (t.D.decision === 'APPROVED' || t.D.decision === 'BUY_CANDIDATE') cand++;
      if (t.D.decision !== 'APPROVED' && t.D.decision !== 'BUY_CANDIDATE') { if (t.D.decision === 'REJECTED') rejected++; const ab = t.D.analysisBlockers.filter(b => !(b.code === 'SECURITY_UNKNOWN' && !t.D.fastPass)); const c = ab[0] && ab[0].code; if (c) reasons[c] = (reasons[c] || 0) + 1; }
      if (t.A.strat) for (const v of t.A.strat.votes) if (v.enabled && v.vote === 'BUY') { const k = v.id + ':' + t.id; if (!state.stratMarks[k] || now - state.stratMarks[k] > 30 * MIN) { state.stratMarks[k] = now; stratStat(v.id, 'signals'); state.metrics.counters.buySignals++; } }
    }
    state.metrics.funnel = funnel; state.metrics.rejectReasons = reasons;
    state.metrics.scanStats = { tokens: analyses.length, fastPass, approved, candidates: cand, rejected, withSignals };
    const m = state.metrics.minute; m.scans++; m.candidates += fastPass; m.accepted += approved; m.rejected += rejected;
    const solT = state.sol ? { usd: state.sol.usd, h1: state.sol.chg ? state.sol.chg.h1 : null, h24: state.sol.chg ? state.sol.chg.h24 : null } : null;
    state.regime = computeRegime(analyses, solT);
  }
  function runAlerts() {
    const s = S();
    for (const t of state.markets.values()) {
      const A = t.A, D = t.D; if (!A || !D) continue;
      if (t.isNew) { t.isNew = false; if (s.alertNewTokens && D.fastPass) alert('NEW_TOKEN', t, `Neuer Token: ${t.symbol} (${A.ageClass}, Liq ${fmtUsd(A.liq.usd)})`, 'INFO'); }
      if (D.decision === 'APPROVED' || D.decision === 'BUY_CANDIDATE') alert('BUY_CANDIDATE', t, D.reason, 'SUCCESS', { strength: A.finalScore });
      else if (A.finalScore >= s.alertScore && D.decision !== 'REJECTED') alert('SCORE', t, `Final Score ${A.finalScore} ≥ ${s.alertScore}`, 'INFO', { strength: A.finalScore });
      if (s.alertX2) { const seen = state.seen[t.id]; if (seen && seen.mc > 0 && isNum(A.core.mc) && A.core.mc >= seen.mc * 2 && isNum(A.liq.usd) && A.liq.usd >= s.minLiq) alert('X2', t, `x${(A.core.mc / seen.mc).toFixed(1)} seit Fund (${fmtUsd(seen.mc)} → ${fmtUsd(A.core.mc)})`, 'SUCCESS', { cooldownMs: DAY }); }
      if (D.fastPass) {
        if (A.liq.spike) alert('LIQ_SPIKE', t, `Liquidität ${fmtPct(A.liq.chg5)} in 5 min`, 'INFO');
        if (A.liq.shock) alert('LIQ_COLLAPSE', t, `Liquidität ${fmtPct(A.liq.chg5)} in 5 min`, 'WARNING');
        const vs = A.signals.find(x => x.type === 'VOLUME_EXPANSION' && x.strength >= 80); if (vs) alert('VOL_SPIKE', t, vs.reason, 'INFO', { strength: vs.strength });
        const wh = A.signals.find(x => x.type === 'WHALE_ACTIVITY' && x.strength >= 70); if (wh) alert('WHALE', t, wh.reason, 'INFO', { strength: wh.strength });
      }
      const w = state.watchlist[t.id];
      if (w && w.alerts) {
        const p = A.core.price;
        if (isNum(w.priceAbove) && isNum(p) && p >= w.priceAbove) alert('WATCH', t, `Preis ${fmtPrice(p)} ≥ ${fmtPrice(w.priceAbove)}`, 'INFO', { key: 'above' });
        if (isNum(w.priceBelow) && isNum(p) && p <= w.priceBelow) alert('WATCH', t, `Preis ${fmtPrice(p)} ≤ ${fmtPrice(w.priceBelow)}`, 'WARNING', { key: 'below' });
        if (isNum(w.scoreAbove) && A.finalScore >= w.scoreAbove) alert('WATCH', t, `Score ${A.finalScore} ≥ ${w.scoreAbove}`, 'INFO', { key: 'score' });
      }
    }
  }

  /* ---------- Bot-Zustand, Readiness, Recovery ---------- */
  function setBotState(to, note) {
    const from = state.bot.state; if (from === to) return true;
    if (!(BOT_TRANSITIONS[from] || []).includes(to)) { log.warn('SYSTEM', `Ungültiger Bot-Zustandswechsel ${from} → ${to} ignoriert`); return false; }
    state.bot.state = to;
    log.info('SYSTEM', `Bot: ${from} → ${to}${note ? ' (' + note + ')' : ''}`);
    emit('bot', { from, to });
    return true;
  }
  function isReady() {
    const s = S(), now = env.now();
    return env.online() && http.status('dexPairs') === 'ONLINE' && [...state.markets.values()].some(t => t.snap && now - t.snap.fetchedAt < s.staleAfterSec * SEC) && systemHealth().score >= s.minSystemHealth;
  }
  function updateReadiness() {
    const b = state.bot;
    if (b.state === 'RECOVERING' && isReady()) { setBotState(b.desired === 'PAUSED' ? 'PAUSED' : 'RUNNING', 'READY – Datenqualität ausreichend'); b.readyAt = env.now(); }
    else if (b.state === 'RUNNING' && (!env.online() || systemHealth().score < 30)) setBotState('RECOVERING', `System Health ${systemHealth().score} – Trading pausiert bis Datenqualität zurück ist`);
    else if (b.state === 'ERROR' && env.now() - b.errorAt > 30 * SEC) setBotState('RECOVERING', 'Automatischer Recovery-Versuch');
  }
  function ensureSession() { if (!state.session || !state.session.id) state.session = { id: 'S-' + env.now().toString(36).toUpperCase(), startedAt: env.now(), trades: 0, wins: 0, losses: 0, pnl: 0 }; }
  function dayRollover() {
    const k = dayKeyOf(env.now()), r = state.risk;
    if (r.dayKey !== k) {
      if (r.dayKey) log.info('RISK', `Tageswechsel: Tagesmetriken zurückgesetzt (Vortag ${fmtSigned(r.dailyPnl)}, ${r.dailyTrades} Käufe)`);
      r.dayKey = k; r.dailyPnl = 0; r.dailyTrades = 0; r.dailyLimitHit = false; r.dailyStartEquity = equityInfo().equity;
      for (const [key, ts] of Object.entries(state.alertMarks)) if (env.now() - ts > DAY) delete state.alertMarks[key];
    }
  }
  function sampleMetrics() {
    const now = env.now(), m = state.metrics.minute, H = state.hist;
    if (!m.t) m.t = now;
    if (now - m.t >= MIN) {
      // Speicher begrenzen: kurzlebige Markierungen & alte Fund-Daten rotieren
      for (const [k, v] of Object.entries(state.stratMarks)) if (now - v > 30 * MIN) delete state.stratMarks[k];
      for (const [k, v] of Object.entries(state.seen)) if (now - v.t > 2 * DAY && !state.markets.has(k)) delete state.seen[k];
      const sc = Math.max(1, m.scans);
      H.scanner.push({ t: now, candidates: m.candidates / sc, accepted: m.accepted / sc, rejected: m.rejected / sc, executed: m.executed, scans: m.scans });
      const apis = {}; for (const n of http.names()) { const x = http.snapshot(n); if (x.total > 0) apis[n] = { lat: x.latency != null ? Math.round(x.latency) : null, fail: x.errorRate != null ? m2(x.errorRate) : null, st: x.status }; }
      H.api.push({ t: now, apis });
      Object.assign(m, { t: now, scans: 0, candidates: 0, accepted: 0, rejected: 0, executed: 0 });
      for (const k of ['scanner', 'api']) if (H[k].length > 240) H[k].splice(0, H[k].length - 240);
    }
    if (!H.lastRisk || now - H.lastRisk >= 30 * SEC) {
      H.lastRisk = now;
      const eq = equityInfo(), pf = state.portfolio;
      pf.peakEquity = Math.max(pf.peakEquity || eq.equity, eq.equity);
      const dd = pf.peakEquity > 0 ? (pf.peakEquity - eq.equity) / pf.peakEquity * 100 : 0;
      pf.maxDD = Math.max(pf.maxDD || 0, dd);
      const pr = portfolioRisk();
      H.risk.push({ t: now, exposurePct: m2(eq.exposurePct), ddPct: m2(dd), risk: pr.score, equity: m2(eq.equity) });
      if (H.risk.length > 480) H.risk.splice(0, H.risk.length - 480);
      if (state.positions.length || !H.equity.length || now - H.equity[H.equity.length - 1].t > 10 * MIN) { H.equity.push({ t: now, v: m2(eq.equity), realized: m2(pf.realized) }); if (H.equity.length > 500) H.equity.shift(); }
    }
  }
  function portfolioRisk() {
    const eq = equityInfo(); let w = 0, tot = 0;
    for (const p of state.positions) { const t = state.markets.get(p.tokenId); const r = t && t.A ? t.A.risk.total : 60; tot += r * p.costUsd; w += p.costUsd; }
    const posRisk = w > 0 ? tot / w : 0;
    const expF = clamp(eq.exposurePct / Math.max(1, S().maxExposurePct), 0, 1.5);
    return { score: Math.round(clamp(posRisk * (0.4 + 0.6 * expF), 0, 100)), posRisk: Math.round(posRisk), exposurePct: eq.exposurePct };
  }

  /* ---------- Scanner (Lock, Scan IDs, kein paralleler Vollscan) ---------- */
  async function scanOnce() {
    const sc = state.scanner;
    if (sc.lock) { sc.skipped++; if (S().debugMode) log.debug('SCANNER', 'Scan übersprungen – vorheriger Scan läuft noch (Scanner Lock)'); return { skipped: true }; }
    sc.lock = true;
    const scanId = ++sc.id, t0 = env.now();
    try {
      dayRollover();
      http.tick();
      await discovery();
      await Promise.all([fetchMarket(), updateSolPrice()]);
      await crossCheck();
      rpcPing().catch(e => noteApiError('rpc', e));
      ohlcvForPositions();
      const ta = env.now(); analyzeAll(); state.metrics.perf.analysis = env.now() - ta;
      await managePositions();
      runAlerts();
      await maybeAutoTrade();
      state.bot.errorStreak = 0;
      return { scanId };
    } catch (e) {
      sc.errors++; state.bot.errorStreak++; state.bot.lastError = e.message;
      log.error('SCANNER', `Scan #${scanId} fehlgeschlagen: ${e.message}`);
      if (state.bot.errorStreak >= 5 && !['ERROR', 'EMERGENCY_STOP', 'STOPPED'].includes(state.bot.state)) {
        setBotState('ERROR', e.message); state.bot.errorAt = env.now(); state.bot.safeMode = true; state.bot.safeAuto = true;
        alert('SYSTEM', null, 'Wiederholte Scan-Fehler – Safe Mode aktiviert: ' + e.message, 'CRITICAL', { key: 'scanerr' });
      }
      return { scanId, error: e.message };
    } finally {
      try { updateReadiness(); sampleMetrics(); } catch (e) { log.error('SYSTEM', 'Readiness/Metrics: ' + e.message); }
      sc.lock = false; sc.lastAt = env.now(); sc.lastDuration = env.now() - t0;
      state.metrics.perf.scan = sc.lastDuration; state.metrics.counters.scans++;
      sc.scansWindow.push(env.now()); while (sc.scansWindow.length && env.now() - sc.scansWindow[0] > 10 * SEC) sc.scansWindow.shift();
      persist(); emit('scan', { scanId });
    }
  }
  function loop() {
    if (!state.scanner.running) return;
    const started = env.now();
    scanOnce().finally(() => {
      if (!state.scanner.running) return;
      const base = S().scanIntervalMs;
      const delay = http.status('dexPairs') === 'OFFLINE' ? Math.min(base * 5, 15000) : Math.max(base - (env.now() - started), 100);
      state.scanner.nextAt = env.now() + delay;
      setT('scan', loop, delay);
    });
  }
  function secLoop() {
    if (!state.scanner.running) return;
    processSecurity().catch(e => log.error('SECURITY', e.message)).finally(() => { if (state.scanner.running) setT('sec', secLoop, 1500); });
  }
  function startScanner() {
    if (state.scanner.running) return false;
    state.scanner.running = true;
    loop(); secLoop();
    log.info('SCANNER', `Scanner gestartet (Intervall ${S().scanIntervalMs} ms)`);
    return true;
  }
  function stopScanner() {
    if (!state.scanner.running) return false;
    state.scanner.running = false;
    clearT('scan'); clearT('sec');
    http.abortAll();
    log.info('SCANNER', 'Scanner gestoppt – Timer gelöscht, Requests abgebrochen');
    return true;
  }

  /* ---------- Bot Control ---------- */
  function start() {
    const b = state.bot;
    if (b.emergency) return { ok: false, error: 'Emergency Stop aktiv – zuerst freigeben' };
    b.desired = 'RUNNING';
    if (b.state === 'PAUSED') { setBotState(isReady() ? 'RUNNING' : 'RECOVERING', 'fortgesetzt'); audit('USER', 'RESUME', ''); persist(); return { ok: true }; }
    if (['RUNNING', 'RECOVERING', 'STARTING'].includes(b.state)) return { ok: true };
    setBotState('STARTING', 'Start angefordert'); b.startedAt = env.now();
    startScanner();
    setBotState('RECOVERING', 'Warte auf ausreichende Datenqualität');
    audit('USER', 'START', ''); persistNow();
    return { ok: true };
  }
  function pause() {
    const b = state.bot; b.desired = 'PAUSED';
    if (['RUNNING', 'RECOVERING'].includes(b.state)) setBotState('PAUSED', 'keine neuen Auto-Trades, Scanner & Exits laufen weiter');
    state.queue = []; audit('USER', 'PAUSE', ''); persistNow();
    return { ok: true };
  }
  function stop() {
    const b = state.bot; b.desired = 'STOPPED';
    stopScanner();
    for (const q of state.queue) log.info('TRADE', `Queue-Eintrag ${q.tokenId} beim Stop verworfen`);
    state.queue = [];
    if (b.state !== 'STOPPED') setBotState('STOPPED', 'Clean Stop');
    audit('USER', 'STOP', state.positions.length ? `${state.positions.length} offene Position(en) werden NICHT überwacht` : '');
    persistNow();
    return { ok: true, warning: state.positions.length ? 'Offene Positionen werden bei gestopptem Bot nicht überwacht.' : null };
  }
  async function emergencyStop(reason = 'Manuell ausgelöst') {
    const b = state.bot;
    if (b.emergency) return { ok: true };
    b.emergency = true; b.emergencyReason = str(reason, 120); b.autoTrading = false;
    if (!setBotState('EMERGENCY_STOP', reason)) b.state = 'EMERGENCY_STOP';
    const cancelled = state.queue.length; state.queue = [];
    for (const o of state.orders) if (['DETECTED', 'QUEUED'].includes(o.state)) { try { transition(o, 'CANCELLED', 'Emergency Stop'); } catch (e) { /* bereits terminal */ } }
    log.crit('SYSTEM', `EMERGENCY STOP: ${reason} – neue Käufe blockiert, ${cancelled} Queue-Einträge verworfen`);
    audit('USER', 'EMERGENCY_STOP', reason);
    alert('SYSTEM', null, `EMERGENCY STOP aktiv: ${reason}`, 'CRITICAL', { key: 'estop', cooldownMs: 0 });
    persistNow();
    if (S().estopPositionRule === 'close') for (const p of [...state.positions]) await executeSell(p.id, 'ALL', 'EMERGENCY', { emergency: true, detail: 'Emergency Stop – Positionsregel „schließen“' });
    if (!S().keepScannerOnEstop) stopScanner();
    emit('bot', { to: 'EMERGENCY_STOP' });
    return { ok: true };
  }
  function releaseEmergency() {
    const b = state.bot; if (!b.emergency) return { ok: true };
    b.emergency = false; b.emergencyReason = ''; b.desired = 'PAUSED';
    if (!setBotState('PAUSED', 'Emergency Stop freigegeben – Bot pausiert, Start erforderlich')) b.state = 'PAUSED';
    if (!state.scanner.running) startScanner();
    audit('USER', 'EMERGENCY_RELEASE', ''); log.warn('SYSTEM', 'Emergency Stop freigegeben – Bot bleibt PAUSED bis START');
    persistNow();
    return { ok: true };
  }
  /* Master-Status: READY · WAITING · BLOCKED · ERROR · EMERGENCY_STOP (+ Lebenszyklus STOPPED/PAUSED). */
  function readiness() {
    const b = state.bot, now = env.now(), ss = state.metrics.scanStats || {};
    if (b.emergency) return { state: 'EMERGENCY_STOP', reason: 'Not-Aus aktiv' + (b.emergencyReason ? ': ' + b.emergencyReason : ''), hard: [mkBlocker('EMERGENCY_STOP')], soft: [] };
    if (b.state === 'ERROR') return { state: 'ERROR', reason: 'Technischer Fehler: ' + (b.lastError || 'unbekannt'), hard: [], soft: [] };
    if (b.state === 'STOPPED') return { state: 'STOPPED', reason: 'Scanner gestoppt – START drücken', hard: [], soft: [] };
    const gb = globalBlockers({ auto: false });
    const hard = gb.filter(x => HARD_GLOBAL.has(x.code)), soft = gb.filter(x => !HARD_GLOBAL.has(x.code));
    if (b.state === 'PAUSED') return { state: 'PAUSED', reason: 'Pausiert – Scanner & Exits laufen, keine neuen Auto-Trades', hard, soft };
    const fresh = [...state.markets.values()].some(t => t.snap && now - t.snap.fetchedAt < S().staleAfterSec * SEC);
    if (b.state === 'RECOVERING' || b.state === 'STARTING') {
      if (!fresh && now - (b.startedAt || now) > 45 * SEC) hard.unshift(mkBlocker('SYSTEM_UNHEALTHY', 'Keine frischen Marktdaten seit Start (' + http.status('dexPairs') + ')'));
      else if (!hard.length) return { state: 'WAITING', reason: 'Start/Recovery – Datenqualität wird geprüft', hard, soft };
    }
    if (hard.length) return { state: 'BLOCKED', reason: hard[0].msg, hard, soft };
    if ((ss.candidates || 0) > 0) {
      const wait = [...state.markets.values()].filter(t => t.D && t.D.decision === 'BUY_CANDIDATE').map(t => t.D.execBlockers[0]).filter(Boolean)[0];
      return { state: 'READY', reason: `${ss.candidates} Kandidat(en) – ${ss.approved ? ss.approved + ' freigegeben' : 'Ausführung wartet: ' + (wait ? wait.msg : '—')}`, hard, soft };
    }
    const top = Object.entries(state.metrics.rejectReasons || {}).sort((a, x) => x[1] - a[1])[0];
    return { state: 'WAITING', reason: 'Kein geeignetes Setup' + (top ? ` – häufigster Grund: ${(BLOCKER_DEFS[top[0]] || [])[2] || top[0]} (${top[1]}×)` : ''), hard, soft };
  }
  /* LIVE-Gating: LIVE nur separat, ausdrücklich und wenn ALLE Voraussetzungen erfüllt sind. Auto-Trading bedeutet nie Echtgeld. */
  function liveReadiness() {
    const w = state.wallet, s = S(), now = env.now(), h = systemHealth();
    const hardErr = validateSettings(s, s).errors.filter(e => !e.soft).length;
    const checks = [
      { name: 'Wallet verbunden', ok: w.status === 'CONNECTED', detail: w.status === 'CONNECTED' ? `${w.provider} · ${shortAddr(w.pubkey)}` : 'nicht verbunden' },
      { name: 'Netzwerk mainnet-beta (Genesis-Hash via RPC)', ok: w.network === 'mainnet-beta' && now - w.networkAt < 10 * MIN, detail: w.network ? `${w.network} · ${fmtAge(now - w.networkAt)} alt` : 'nicht verifiziert' },
      { name: 'Balance verifiziert (RPC)', ok: w.balanceLamports != null && now - w.balanceAt < 5 * MIN, detail: w.balanceLamports != null ? lamportsToSol(BigInt(w.balanceLamports)) + ' SOL' : 'unbekannt' },
      { name: 'Risikolimits geprüft', ok: hardErr === 0 && s.maxPositionPct <= 5 && s.dailyLossLimitPct <= 10 && s.maxExposurePct <= 30, detail: `Position ≤ 5 % (${s.maxPositionPct}), Tagesverlust ≤ 10 % (${s.dailyLossLimitPct}), Exposure ≤ 30 % (${s.maxExposurePct})` },
      { name: 'Emergency Stop aus', ok: !state.bot.emergency, detail: state.bot.emergency ? 'aktiv' : 'aus' },
      { name: 'System Health ausreichend', ok: h.score >= s.minSystemHealth, detail: `${h.score} / min. ${s.minSystemHealth}` },
      { name: 'Kein offener Abgleich', ok: !state.reconciliation.required, detail: state.reconciliation.required ? 'RECONCILIATION REQUIRED' : 'ok' },
      { name: 'Swap-/Routing-Provider', ok: false, detail: 'NOT AVAILABLE – nicht integriert (REQUIRES EXTERNAL PROVIDER)' },
      { name: 'Signatur-Workflow', ok: false, detail: 'vorbereitet, aber deaktiviert – keine Transaktionen werden signiert' }
    ];
    return { ready: checks.every(c => c.ok), checks };
  }
  /* Vorbereitung Live-Order: alle Prüfungen, die vor einer echten Order bestehen müssten. Bei Unsicherheit NO TRADE. */
  function preLiveChecks(t, sizeUsd) {
    const s = S(), now = env.now(), A = t && t.A, w = state.wallet;
    if (!A) return [{ name: 'Analyse', ok: false, detail: 'keine Daten' }];
    const es = effectiveSnap(t, now, s), imp = estImpact(sizeUsd, A.liq.usd), fees = estFees(sizeUsd), sol = state.sol && state.sol.usd;
    const balUsd = w.balanceLamports != null && isNum(sol) ? Number(w.balanceLamports) / 1e9 * sol : null;
    const eq = equityInfo();
    return [
      { name: 'Mint', ok: isMint(t.mint) && !!(t.sec && t.sec.sources.rpc), detail: shortAddr(t.mint) + (t.sec && t.sec.sources.rpc ? ' · on-chain geprüft' : ' · nicht on-chain geprüft') },
      { name: 'Pool', ok: isMint(A.core.pairAddress), detail: A.core.pairAddress ? shortAddr(A.core.pairAddress) + ' · ' + (A.core.dexId || '—') : 'unbekannt' },
      { name: 'Route', ok: false, detail: 'kein Routing-Provider (NOT AVAILABLE)' },
      { name: 'Liquidität', ok: isNum(A.liq.usd) && A.liq.usd >= s.minLiq, detail: fmtUsd(A.liq.usd) + ' / min. ' + fmtUsd(s.minLiq) },
      { name: 'Slippage / Price Impact', ok: imp != null && imp * 100 <= s.maxSlippagePct, detail: imp != null ? (imp * 100).toFixed(3) + ' % / max. ' + s.maxSlippagePct + ' %' : 'nicht schätzbar' },
      { name: 'Balance', ok: balUsd != null && fees != null && balUsd >= sizeUsd + fees.total, detail: balUsd != null ? fmtUsd(balUsd) + ' verfügbar' : 'Wallet-Balance unbekannt' },
      { name: 'Position Size', ok: isNum(sizeUsd) && sizeUsd > 0 && sizeUsd <= eq.equity * s.maxPositionPct / 100, detail: fmtUsd(sizeUsd) + ' / max. ' + fmtUsd(eq.equity * s.maxPositionPct / 100) },
      { name: 'Risk Limit', ok: A.risk.total <= s.maxRiskScore && A.risk.level !== 'CRITICAL', detail: A.risk.total + ' ' + A.risk.level + ' / max. ' + s.maxRiskScore },
      { name: 'Security', ok: ['VERIFIED', 'PARTIAL'].includes(A.sec.status) && !A.sec.stale, detail: A.sec.status },
      { name: 'Datenfrische', ok: !!es.snap && !es.fallback && es.age <= s.snapshotMaxAgeSec * SEC, detail: es.age != null ? fmtAge(es.age) + ' alt (max. ' + s.snapshotMaxAgeSec + ' s)' : 'keine Daten' },
      { name: 'Duplicate-Schutz', ok: !state.locks.has(t.id) && !state.queue.some(q => q.tokenId === t.id), detail: state.locks.has(t.id) ? 'laufende Order' : 'frei' }
    ];
  }
  function setMode(m) {
    if (m === 'LIVE') {
      const lr = liveReadiness();
      log.sec('LIVE-Modus angefragt – Gating nicht erfüllt: ' + lr.checks.filter(c => !c.ok).map(c => c.name).join(', '));
      audit('USER', 'MODE_LIVE_DENIED', 'Gating: ' + lr.checks.filter(c => !c.ok).map(c => c.name).join(', '));
      return { ok: false, error: 'LIVE nicht aktivierbar – Voraussetzungen fehlen (REQUIRES EXTERNAL PROVIDER).', checks: lr.checks };
    }
    if (!['SIMULATION', 'PAPER', 'READ_ONLY'].includes(m)) return { ok: false, error: 'Unbekannter Modus' };
    const from = state.mode; if (from === m) return { ok: true };
    state.mode = m; state.queue = [];
    audit('USER', 'MODE', `${from} → ${m}`); log.info('SYSTEM', `Modus: ${from} → ${m}`);
    persistNow(); emit('bot', {});
    return { ok: true };
  }
  function setAutoTrading(on) {
    const b = state.bot;
    if (on) {
      if (state.mode !== 'SIMULATION') return { ok: false, error: `Auto-Trading nur im SIMULATION-Modus (aktuell ${state.mode})` };
      if (b.emergency) return { ok: false, error: 'Emergency Stop aktiv' };
      if (state.risk.dailyLimitHit) return { ok: false, error: 'Tagesverlust-Limit erreicht – heute kein Auto-Trading' };
    }
    b.autoTrading = !!on; audit('USER', on ? 'AUTO_TRADING_ON' : 'AUTO_TRADING_OFF', state.mode);
    log.info('SYSTEM', `Auto-Trading ${on ? 'AN' : 'AUS'} (${state.mode})`); persistNow();
    return { ok: true };
  }
  function setSafeMode(on) { state.bot.safeMode = !!on; if (!on) state.bot.safeAuto = false; audit('USER', on ? 'SAFE_MODE_ON' : 'SAFE_MODE_OFF', ''); log.info('SYSTEM', `Safe Mode ${on ? 'AN' : 'AUS'}`); persistNow(); return { ok: true }; }

  /* ---------- Settings / Strategien / Versionierung ---------- */
  const pickTunable = () => ({ minScore: S().minScore, stopLossPct: S().stopLossPct, trailPct: S().trailPct });
  function newParamVersion(params, status, note) {
    const v = state.paramVersions.reduce((mx, x) => Math.max(mx, x.version), 0) + 1;
    const pv = { version: v, ts: env.now(), params, status, note, perf: null, tradeCount: 0, basedOn: state.activeParam };
    state.paramVersions.push(pv); if (state.paramVersions.length > 40) state.paramVersions.shift();
    state.activeParam = v; return pv;
  }
  function updateSettings(patch, who = 'USER', o = {}) {
    const before = state.settings;
    const { settings, errors } = validateSettings(patch, before);
    const changes = [];
    for (const k of Object.keys(settings)) if (settings[k] !== before[k]) changes.push({ key: k, from: before[k], to: settings[k] });
    state.settings = settings; healthCache.at = -1;
    if (changes.length) {
      state.configLog.unshift({ ts: env.now(), who, kind: 'settings', changes: changes.map(c => ({ ...c, from: c.key === 'rpcUrls' ? maskUrl(String(c.from).split(',')[0]) + '…' : c.from, to: c.key === 'rpcUrls' ? maskUrl(String(c.to).split(',')[0]) + '…' : c.to })) });
      if (state.configLog.length > 200) state.configLog.length = 200;
      log.info('SYSTEM', `Konfiguration geändert (${who}): ${changes.map(c => c.key).join(', ')}`);
      if (!o.noVersion && changes.some(c => c.key in TUNING_BOUNDS)) newParamVersion(pickTunable(), 'STABLE', 'Manuelle Änderung');
    }
    persistNow(); emit('settings', {});
    return { errors, changes };
  }
  function updateStrategies(patch, who = 'USER') {
    const before = state.strategies;
    const { strategies, errors } = validateStrategies(patch, before);
    const changes = [];
    for (const id of Object.keys(strategies)) for (const k of Object.keys(strategies[id])) if (strategies[id][k] !== before[id][k]) changes.push({ key: id + '.' + k, from: before[id][k], to: strategies[id][k] });
    state.strategies = strategies;
    if (changes.length) { state.configLog.unshift({ ts: env.now(), who, kind: 'strategy', changes }); log.info('SYSTEM', `Strategie geändert: ${changes.map(c => c.key).join(', ')}`); }
    persistNow(); emit('settings', {});
    return { errors, changes };
  }
  function applyTunable(params, who) {
    const patch = {};
    for (const [k, [lo, hi]] of Object.entries(TUNING_BOUNDS)) if (isNum(params[k])) patch[k] = clamp(params[k], lo, hi);
    return updateSettings(patch, who, { noVersion: true });
  }
  /* Safe Auto-Tuning: nur SIMULATION, nur TUNING_BOUNDS, min. 20 Trades, automatischer Rollback. Harte Limits unveränderbar. */
  function maybeTune() {
    const s = S(); if (!s.ffAutoTuning || state.mode !== 'SIMULATION') return;
    const cur = state.paramVersions.find(p => p.version === state.activeParam); if (!cur) return;
    const minN = Math.max(s.minTradesForTuning, HARD_LIMITS.MIN_TRADES_FOR_TUNING);
    const trades = state.journal.filter(j => j.status === 'CLOSED' && j.paramVersion === cur.version && j.mode === 'SIMULATION');
    cur.tradeCount = trades.length;
    if (trades.length < minN) return;
    const perf = perfStats(trades);
    if (cur.status === 'CANDIDATE') {
      const base = state.paramVersions.find(p => p.version === cur.basedOn);
      if (base && base.perf && isNum(base.perf.expectancy) && isNum(perf.expectancy) && (perf.expectancy < base.perf.expectancy - Math.abs(base.perf.expectancy) * 0.1 || perf.maxDD > base.perf.maxDD * 1.25 + 1e-9)) {
        cur.status = 'ROLLED_BACK'; cur.perf = perf;
        applyTunable(base.params, 'AUTO_ROLLBACK'); state.activeParam = base.version; base.status = 'STABLE';
        state.configLog.unshift({ ts: env.now(), who: 'AUTO_ROLLBACK', kind: 'strategy', changes: [{ key: 'paramVersion', from: cur.version, to: base.version }] });
        log.risk(`Auto-Rollback: Version ${cur.version} schlechter als ${base.version} (Expectancy ${fmtUsd(perf.expectancy)} vs ${fmtUsd(base.perf.expectancy)})`);
        alert('RISK', null, `Auto-Rollback auf Parameter-Version ${base.version}`, 'WARNING', { key: 'rollback', cooldownMs: 0 });
        return;
      }
      cur.status = 'STABLE';
    }
    cur.perf = perf;
    const all = state.journal.filter(j => j.status === 'CLOSED' && j.mode === 'SIMULATION' && isNum(j.score) && j.result);
    const [lo, hi] = TUNING_BOUNDS.minScore; let best = { s: s.minScore, e: perf.expectancy };
    for (let c = Math.max(lo, s.minScore - 5); c <= Math.min(hi, s.minScore + 5); c += 5) {
      if (c === s.minScore) continue;
      const sub = all.filter(j => j.score >= c); if (sub.length < 10) continue;
      const e = avg(sub.map(j => j.result.pnlUsd));
      if (isNum(best.e) ? e > best.e + Math.abs(best.e) * 0.1 : e > 0) best = { s: c, e };
    }
    if (best.s !== s.minScore) {
      const params = { ...pickTunable(), minScore: best.s };
      applyTunable(params, 'AUTO_TUNING');
      newParamVersion(params, 'CANDIDATE', `Auto-Tuning: minScore ${s.minScore} → ${best.s} (${all.length} Trades, keine Garantie)`);
      log.info('RISK', `Auto-Tuning: neue Parameter-Version (minScore ${s.minScore} → ${best.s})`);
    }
  }
  function rollbackTo(version) {
    const pv = state.paramVersions.find(p => p.version === version); if (!pv) return { ok: false, error: 'Version nicht gefunden' };
    applyTunable(pv.params, 'USER_ROLLBACK'); state.activeParam = pv.version;
    log.info('SYSTEM', `Parameter-Version ${version} manuell aktiviert`); persistNow();
    return { ok: true };
  }

  /* ---------- Watchlist ---------- */
  function addWatch(id) {
    const mint = mintOfId(id) || id; if (!isMint(mint)) return { ok: false, error: 'Ungültige Mint-Adresse' };
    const tid = tokenIdOf(mint);
    if (!state.watchlist[tid]) { const t = ensureToken(mint, 'Watchlist'); state.watchlist[tid] = { note: '', priority: 2, alerts: true, priceAbove: null, priceBelow: null, scoreAbove: null, addedAt: env.now(), symbol: t ? t.symbol : '' }; log.info('UI', `Watchlist: ${t ? t.symbol : shortAddr(mint)} hinzugefügt`); }
    persist(); return { ok: true };
  }
  function removeWatch(id) { delete state.watchlist[id]; persist(); return { ok: true }; }
  function updateWatch(id, patch) {
    const w = state.watchlist[id]; if (!w) return { ok: false };
    if ('note' in patch) w.note = str(String(patch.note), 200);
    if ('priority' in patch) w.priority = clamp(Math.round(+patch.priority) || 2, 1, 3);
    if ('alerts' in patch) w.alerts = !!patch.alerts;
    for (const k of ['priceAbove', 'priceBelow', 'scoreAbove']) if (k in patch) { const v = patch[k] === '' || patch[k] == null ? null : Number(patch[k]); w[k] = v == null ? null : Number.isFinite(v) && v > 0 ? (k === 'scoreAbove' ? clamp(Math.round(v), 1, 100) : v) : w[k]; }
    persist(); return { ok: true };
  }

  /* ---------- Wallet (nur lesend: Public Key + Balance, keine Signaturen) ---------- */
  /* Wallet-Adapter (gekapselt): Provider, Verbindungsstatus, Public Key, Netzwerk, Balance, Signatur-Workflow.
     Private Keys / Seeds / Secret Keys werden NIE gelesen, gespeichert oder geloggt. Signieren ist deaktiviert. */
  const walletHooked = new WeakSet();
  const providerName = p => (p.isPhantom ? 'Phantom' : p.isSolflare ? 'Solflare' : p.isBackpack ? 'Backpack' : 'Wallet');
  function walletReset(status, error) {
    state.wallet = { status, pubkey: null, provider: null, network: null, networkAt: 0, balanceLamports: null, balanceAt: 0, error: error || '' };
  }
  function hookProvider(prov) {
    if (walletHooked.has(prov) || typeof prov.on !== 'function') return;
    walletHooked.add(prov);
    try {
      prov.on('accountChanged', pk => {
        const k = pk && typeof pk.toString === 'function' ? pk.toString() : null;
        if (!isMint(k)) { walletReset('NOT_CONNECTED'); log.info('SYSTEM', 'Wallet: Konto getrennt'); }
        else { state.wallet.pubkey = k; state.wallet.balanceLamports = null; state.wallet.balanceAt = 0; log.info('SYSTEM', 'Wallet: Konto gewechselt ' + shortAddr(k)); walletBalance(); }
        emit('bot', {});
      });
      prov.on('disconnect', () => { walletReset('NOT_CONNECTED'); log.info('SYSTEM', 'Wallet getrennt (Provider)'); emit('bot', {}); });
    } catch (e) { /* Provider ohne Events */ }
  }
  async function walletNetwork() {
    try { const g = await rpcCall('getGenesisHash', [], { cacheMs: 10 * MIN }); state.wallet.network = GENESIS[g] || 'unbekannt'; state.wallet.networkAt = env.now(); }
    catch (e) { state.wallet.network = null; state.wallet.error = 'Netzwerk nicht verifiziert: ' + e.message; }
  }
  async function walletConnect() {
    if (state.wallet.status === 'CONNECTING') return { ok: false, error: 'Verbindung läuft bereits' };
    const prov = env.walletProvider ? env.walletProvider() : null;
    if (!prov || typeof prov.connect !== 'function') { walletReset('NO_PROVIDER'); return { ok: false, error: 'Kein Wallet-Provider gefunden (z. B. Phantom- oder Solflare-Extension bzw. deren In-App-Browser).' }; }
    state.wallet.status = 'CONNECTING';
    try {
      const r = await prov.connect();
      const pkObj = (r && r.publicKey) || prov.publicKey; const pk = pkObj && typeof pkObj.toString === 'function' ? pkObj.toString() : null;
      if (!isMint(pk)) throw new Error('Wallet lieferte keinen gültigen Public Key');
      state.wallet = { status: 'CONNECTED', pubkey: pk, provider: providerName(prov), network: null, networkAt: 0, balanceLamports: null, balanceAt: 0, error: '' };
      hookProvider(prov);
      audit('USER', 'WALLET_CONNECT', shortAddr(pk)); log.info('SYSTEM', `Wallet verbunden (nur lesend): ${shortAddr(pk)}`);
      await Promise.all([walletBalance(), walletNetwork()]);
      return { ok: true };
    } catch (e) { walletReset('ERROR', str(e && e.message, 120) || 'Verbindung abgelehnt'); return { ok: false, error: state.wallet.error }; }
  }
  async function walletBalance() {
    if (state.wallet.status !== 'CONNECTED') return;
    try { const r = await rpcCall('getBalance', [state.wallet.pubkey, { commitment: 'confirmed' }]); if (r && isNum(r.value) && r.value >= 0) { state.wallet.balanceLamports = String(Math.round(r.value)); state.wallet.balanceAt = env.now(); state.wallet.error = ''; } }
    catch (e) { state.wallet.error = 'Balance nicht verifiziert: ' + e.message; }
  }
  function walletDisconnect() {
    const prov = env.walletProvider ? env.walletProvider() : null;
    try { if (prov && prov.disconnect) prov.disconnect(); } catch (e) { /* ignorieren */ }
    walletReset('NOT_CONNECTED');
    audit('USER', 'WALLET_DISCONNECT', '');
  }
  /* Signatur-Workflow: vorbereitet (klare Schnittstelle), aber deaktiviert – es wird nichts signiert. */
  async function requestSignature() {
    log.sec('Signatur angefragt – abgelehnt: Signatur-Workflow deaktiviert (kein Live-Provider)');
    return { ok: false, code: 'SIGNING_DISABLED', error: 'Signieren ist deaktiviert – LIVE ist nicht verfügbar.' };
  }

  /* ---------- Diagnose: Warum kauft der Bot nicht? ---------- */
  function diagnostics() {
    const now = env.now(), s = S(), b = state.bot, r = state.risk, h = systemHealth(), eq = equityInfo(), st = state.metrics.scanStats || {};
    const rd = readiness();
    const system = [], trading = [], market = [];
    const c = (list, name, status, detail) => list.push({ name, status, detail });
    // System & harte Sicherheitsblocker (rot nur bei echter Blockade)
    c(system, 'Emergency Stop', b.emergency ? 'fail' : 'pass', b.emergency ? 'AKTIV: ' + b.emergencyReason : 'aus');
    c(system, 'Bot-Lebenszyklus', b.state === 'RUNNING' ? 'pass' : b.state === 'ERROR' ? 'fail' : 'warn', `Status ${b.state}`);
    c(system, 'System Health', h.score >= s.minSystemHealth ? 'pass' : 'fail', `${h.score} / min. ${s.minSystemHealth}`);
    c(system, 'Marktdaten (DexScreener)', http.status('dexPairs') === 'ONLINE' ? 'pass' : http.status('dexPairs') === 'OFFLINE' ? 'fail' : 'warn', `${http.status('dexPairs')} · ${state.markets.size} Tokens im Universe`);
    const rpcSt = rpcEndpoints().map(e => http.status(e.name));
    c(system, 'Security-Quellen (RPC/RugCheck)', rpcSt.includes('ONLINE') || http.status('rugcheck') === 'ONLINE' ? 'pass' : rd.hard.some(x => x.code === 'SECURITY_SOURCES_DOWN') ? 'fail' : 'warn', `RPC ${rpcSt.join('/') || '—'}, RugCheck ${http.status('rugcheck')}`);
    c(system, 'SOL-Preis (Fee Engine)', state.sol && now - state.sol.at < 5 * MIN ? 'pass' : 'fail', state.sol ? `${fmtUsd(state.sol.usd)} · ${fmtAge(now - state.sol.at)} alt${state.sol.derived ? ' · abgeleitet aus SOL-Pools' : ''}` : 'unbekannt');
    c(system, 'Safe Mode', b.safeMode ? 'fail' : 'pass', b.safeMode ? 'aktiv – keine neuen Käufe' : 'aus');
    c(system, 'Abgleich (Reconciliation)', state.reconciliation.required ? 'fail' : 'pass', state.reconciliation.required ? state.reconciliation.issues.length + ' offene Punkte' : 'ok');
    c(system, 'Tagesverlust-Limit', r.dailyLimitHit ? 'fail' : 'pass', `Heute ${fmtSigned(r.dailyPnl)} / Limit −${s.dailyLossLimitPct} %`);
    c(system, 'Globale Pause', r.globalPauseUntil > now ? 'fail' : 'pass', r.globalPauseUntil > now ? `noch ${fmtAge(r.globalPauseUntil - now)} (Serie ${r.lossStreak})` : `Verlustserie ${r.lossStreak}/${s.lossStreakLimit}`);
    c(system, 'Loss-Cooldown', r.lossCooldownUntil > now ? 'fail' : 'pass', r.lossCooldownUntil > now ? `noch ${fmtAge(r.lossCooldownUntil - now)}` : 'frei');
    // Trading-Einstellungen (Hinweise, keine Blockade)
    c(trading, 'Modus', state.mode === 'SIMULATION' ? 'pass' : 'warn', `${state.mode}${state.mode === 'PAPER' ? ' – nur manuelle Trades' : state.mode === 'READ_ONLY' ? ' – Beobachtung, kein Handel' : ''}`);
    c(trading, 'Auto-Trading', b.autoTrading ? 'pass' : 'warn', b.autoTrading ? 'AN (nur SIMULATION, nie Echtgeld)' : 'AUS – der Bot analysiert nur (sichere Voreinstellung)');
    c(trading, 'Exposure', eq.exposurePct < s.maxExposurePct ? 'pass' : 'warn', `${eq.exposurePct.toFixed(1)} % / max. ${s.maxExposurePct} %`);
    c(trading, 'Offene Positionen', state.positions.length < s.maxOpenPositions ? 'pass' : 'warn', `${state.positions.length} / ${s.maxOpenPositions}`);
    const hourBuys = r.buyTimes.filter(x => now - x < HOUR).length;
    c(trading, 'Overtrading-Schutz', hourBuys < s.maxTradesPerHour ? 'pass' : 'warn', `${hourBuys} Käufe in 60 min / Limit ${s.maxTradesPerHour}`);
    // Markt (informativ – „kein Kandidat“ ist NIE ein globaler Block)
    const toks = [...state.markets.values()].filter(t => t.A && t.D);
    c(market, 'Tokens analysiert', 'info', `${st.tokens || 0} von ${state.markets.size}`);
    c(market, 'Schnellfilter bestanden', 'info', `${st.fastPass || 0} (Liquidität, Volumen, MCap, Käuferanteil, Frische)`);
    c(market, 'Security VERIFIED/PARTIAL', 'info', `${toks.filter(t => t.D.fastPass && ['VERIFIED', 'PARTIAL'].includes(t.A.sec.status)).length} Kandidaten`);
    c(market, 'Mit Kaufsignal', 'info', `${st.withSignals || 0} Tokens`);
    c(market, 'Buy Candidates', 'info', `${st.candidates || 0} (Score ≥ ${s.minScore}, Konsens ≥ ${s.consensusMinWeight})`);
    const chains = toks.filter(t => t.D.fastPass || t.A.finalScore >= 45).sort((a, x) => x.A.finalScore - a.A.finalScore).slice(0, 10).map(t => ({ id: t.id, symbol: t.symbol, score: t.A.finalScore, chain: candidateChain(t) }));
    const summary = `${rd.state === 'EMERGENCY_STOP' ? 'EMERGENCY STOP' : rd.state}: ${rd.reason}. Beobachtet ${state.markets.size} Tokens · ${st.fastPass || 0} bestehen Schnellfilter · ${st.candidates || 0} Kandidaten.`;
    return { readiness: rd, system, trading, market, chains, funnel: state.metrics.funnel, summary, rejectReasons: state.metrics.rejectReasons, preTradeRejects: state.metrics.preTradeRejects };
  }
  function botHealth() {
    const now = env.now(), s = S(), sc = state.scanner, r = state.risk;
    const apis = ['dexPairs', 'dexDisc', 'gecko', 'rugcheck'].map(n => http.status(n));
    const rpcs = rpcEndpoints().map(e => http.status(e.name));
    const toks = [...state.markets.values()].filter(t => t.snap);
    const fresh = toks.length ? toks.filter(t => now - t.snap.fetchedAt <= s.staleAfterSec * SEC).length / toks.length : 0;
    const failedRecent = state.orders.filter(o => o.state === 'FAILED' && now - o.createdAt < 10 * MIN).length;
    const rl = state.metrics.perf.render;
    return [
      { name: 'Scanner', status: !sc.running ? (state.bot.state === 'STOPPED' ? 'DEGRADED' : 'ERROR') : now - sc.lastAt < Math.max(6000, s.scanIntervalMs * 5) ? 'OK' : 'DEGRADED', detail: sc.running ? `Scan #${sc.id}, ${sc.lastDuration} ms, übersprungen ${sc.skipped}` : 'gestoppt' },
      { name: 'Data', status: fresh >= 0.6 ? 'OK' : fresh > 0 ? 'DEGRADED' : 'ERROR', detail: `${Math.round(fresh * 100)} % der Tokens frisch` },
      { name: 'APIs', status: apis[0] === 'ONLINE' ? (apis.every(x => x === 'ONLINE' || x === 'UNKNOWN') ? 'OK' : 'DEGRADED') : 'ERROR', detail: apis.join(' / ') },
      { name: 'RPC', status: rpcs.includes('ONLINE') ? 'OK' : rpcs.includes('DEGRADED') || rpcs.includes('UNKNOWN') ? 'DEGRADED' : 'ERROR', detail: rpcs.join(' / ') || 'keine RPC konfiguriert' },
      { name: 'Risk', status: r.dailyLimitHit || r.globalPauseUntil > now ? 'DEGRADED' : 'OK', detail: r.dailyLimitHit ? 'Tageslimit erreicht' : r.globalPauseUntil > now ? 'globale Pause' : 'normal' },
      { name: 'Execution', status: failedRecent ? 'DEGRADED' : 'OK', detail: `${state.orders.filter(o => !TERMINAL.has(o.state)).length} aktiv, ${failedRecent} Fehler (10 min) · LIVE nicht verfügbar` },
      { name: 'Storage', status: state.storageOk ? 'OK' : 'ERROR', detail: state.storageOk ? `gespeichert ${fmtAge(now - state.lastSaveAt)}` : store.status().lastError },
      { name: 'UI', status: rl == null ? 'OK' : rl < 50 ? 'OK' : rl < 200 ? 'DEGRADED' : 'ERROR', detail: rl == null ? '—' : `Render ${rl} ms` }
    ];
  }

  /* ---------- Persistenz (versioniert) & Recovery ---------- */
  let persistTimer = null, storageFrozen = false;
  function persist() { if (persistTimer || storageFrozen) return; persistTimer = env.setTimeout(() => { persistTimer = null; persistNow(); }, 5000); }
  function serialize() {
    const now = env.now();
    const seen = {}; for (const [k, v] of Object.entries(state.seen)) if (now - v.t < 2 * DAY) seen[k] = v;
    const marks = {}; for (const [k, v] of Object.entries(state.alertMarks)) if (now - v < DAY) marks[k] = v;
    const seq = state.tradeSeq;
    return {
      settings: { settings: state.settings, strategies: state.strategies, watchlist: state.watchlist, ui: state.ui },
      positions: { tradeSeq: seq, portfolio: state.portfolio, positions: state.positions, orders: state.orders.slice(0, 150), usedKeys: [...state.usedKeys.entries()].filter(([, v]) => v !== 'pending').slice(-600) },
      trades: { tradeSeq: seq, journal: state.journal.slice(0, 500) },
      runtime: { tradeSeq: seq, savedAt: now, app: APP_VERSION, mode: state.mode, bot: { desired: state.bot.desired, autoTrading: state.bot.autoTrading, safeMode: state.bot.safeMode, emergency: state.bot.emergency, emergencyReason: state.bot.emergencyReason }, risk: state.risk, session: state.session, seen, alertMarks: marks, reconciliation: state.reconciliation },
      logs: { logs: log.entries.slice(-200), auditLog: state.auditLog.slice(0, 300), configLog: state.configLog.slice(0, 100), feed: state.feed.slice(0, 80) },
      stats: { hist: state.hist, stratStats: state.stratStats, falseSignals: state.falseSignals.slice(0, 50), paramVersions: state.paramVersions, activeParam: state.activeParam, sessions: state.sessions.slice(0, 50) }
    };
  }
  function persistNow() {
    if (persistTimer) { env.clearTimeout(persistTimer); persistTimer = null; }
    if (storageFrozen) return true;
    const ok = store.save(serialize());
    if (ok !== state.storageOk && !ok) log.error('STORAGE', 'Speichern fehlgeschlagen: ' + store.status().lastError);
    state.storageOk = ok; if (ok) state.lastSaveAt = env.now();
    return ok;
  }
  function hydrate(d) {
    if (!d) return;
    state.settings = validateSettings(d.settings || d.settingsIn || {}, defaultSettings()).settings;
    state.strategies = validateStrategies(d.strategies, defaultStrategies()).strategies;
    if (['SIMULATION', 'PAPER', 'READ_ONLY'].includes(d.mode)) state.mode = d.mode;
    if (d.bot && typeof d.bot === 'object') {
      state.bot.desired = ['RUNNING', 'PAUSED', 'STOPPED'].includes(d.bot.desired) ? d.bot.desired : 'RUNNING';
      state.bot.autoTrading = d.bot.autoTrading === true && state.mode === 'SIMULATION';
      state.bot.safeMode = d.bot.safeMode === true; state.bot.emergency = d.bot.emergency === true; state.bot.emergencyReason = str(d.bot.emergencyReason, 120);
    }
    const numMap = (o, maxV) => { const out = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (k.startsWith('solana:') && isNum(v) && v >= 0) out[k] = maxV != null ? Math.min(v, maxV) : v; return out; };
    if (d.risk && typeof d.risk === 'object') {
      const r = d.risk, R = state.risk;
      R.buyCount = numMap(r.buyCount, HARD_LIMITS.MAX_BUYS_PER_COIN); R.coinCooldown = numMap(r.coinCooldown); R.stratCooldown = numMap(r.stratCooldown);
      for (const k of ['lossCooldownUntil', 'globalPauseUntil', 'lossStreak', 'dailyPnl', 'dailyTrades']) if (isNum(r[k])) R[k] = r[k];
      if (isNum(r.dailyStartEquity)) R.dailyStartEquity = r.dailyStartEquity;
      R.dayKey = typeof r.dayKey === 'string' ? r.dayKey : ''; R.dailyLimitHit = r.dailyLimitHit === true; R.reviewRequired = r.reviewRequired === true;
      R.buyTimes = arr(r.buyTimes).filter(isNum);
    }
    const pf = d.portfolio;
    state.portfolio = pf && isNum(pf.cash) && isNum(pf.startCapital) ? { ...freshPortfolio(pf.startCapital), ...Object.fromEntries(Object.entries(pf).filter(([, v]) => isNum(v))) } : freshPortfolio(state.settings.simCapitalUsd);
    state.positions = arr(d.positions).filter(p => p && p.status === 'OPEN' && isMint(p.mint) && isNum(p.qty) && p.qty > 0 && isNum(p.entryPrice) && p.entryPrice > 0 && Array.isArray(p.entries));
    for (const p of state.positions) { p.value = null; p.pnlUsd = null; p.pnlPct = null; p.priceLabel = 'STALE'; }
    state.orders = arr(d.orders).filter(o => o && typeof o.id === 'string' && ORDER_TRANSITIONS[o.state] && Array.isArray(o.history));
    state.journal = arr(d.journal).filter(j => j && typeof j.id === 'string' && isMint(j.mint));
    state.feed = arr(d.feed).filter(f => f && typeof f.id === 'string').slice(0, 120);
    state.watchlist = {};
    if (d.watchlist && typeof d.watchlist === 'object') for (const [k, w] of Object.entries(d.watchlist)) if (isMint(mintOfId(k)) && w && typeof w === 'object') state.watchlist[k] = { note: str(w.note, 200), priority: clamp(+w.priority || 2, 1, 3), alerts: w.alerts !== false, priceAbove: isNum(w.priceAbove) ? w.priceAbove : null, priceBelow: isNum(w.priceBelow) ? w.priceBelow : null, scoreAbove: isNum(w.scoreAbove) ? w.scoreAbove : null, addedAt: isNum(w.addedAt) ? w.addedAt : env.now(), symbol: str(w.symbol, 24) };
    if (d.seen && typeof d.seen === 'object') for (const [k, v] of Object.entries(d.seen)) if (v && isNum(v.mc) && isNum(v.t)) state.seen[k] = { mc: v.mc, t: v.t, sym: str(v.sym, 24) };
    if (d.alertMarks && typeof d.alertMarks === 'object') for (const [k, v] of Object.entries(d.alertMarks)) if (isNum(v)) state.alertMarks[k] = v;
    state.paramVersions = arr(d.paramVersions).filter(p => p && isNum(p.version) && p.params);
    if (isNum(d.activeParam)) state.activeParam = d.activeParam;
    state.configLog = arr(d.configLog).slice(0, 200); state.auditLog = arr(d.auditLog).slice(0, 400); state.sessions = arr(d.sessions).slice(0, 50);
    if (d.session && typeof d.session === 'object' && d.session.id) state.session = d.session;
    if (d.stratStats && typeof d.stratStats === 'object') state.stratStats = d.stratStats;
    state.falseSignals = arr(d.falseSignals).slice(0, 60);
    if (d.hist && typeof d.hist === 'object') for (const k of ['equity', 'risk', 'api', 'scanner']) state.hist[k] = arr(d.hist[k]).slice(-500);
    state.usedKeys = new Map(arr(d.usedKeys).filter(x => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string'));
    const restored = arr(d.logs).filter(e => e && LOG_LEVELS.includes(e.level) && isNum(e.ts)).map(e => ({ ...e, restored: true }));
    log.entries.unshift(...restored);
    if (d.ui && typeof d.ui === 'object') state.ui = d.ui;
    if (isNum(d.tradeSeq)) state.tradeSeq = d.tradeSeq;
    if (d.reconciliation && d.reconciliation.required === true) state.reconciliation = { required: true, issues: arr(d.reconciliation.issues).map(x => str(String(x), 200)), at: isNum(d.reconciliation.at) ? d.reconciliation.at : env.now() };
  }
  /* Recovery: bekannte Fälle deterministisch & konservativ auflösen, alles Unsichere → RECONCILIATION REQUIRED (keine neuen Käufe bis bestätigt). */
  function reconcile(loadInfo = {}) {
    const issues = [];
    for (const o of state.orders) {
      if (TERMINAL.has(o.state)) continue;
      const from = o.state; o.state = 'RECONCILING'; o.history.push({ s: 'RECONCILING', ts: env.now(), note: 'Nach Neustart ungeklärt (' + from + ')' });
      const inPos = f => state.positions.some(p => arr(p[f]).some(e => e.orderId === o.id)) || state.journal.some(j => arr(j[f]).some(e => e.orderId === o.id));
      const filled = o.side === 'BUY' ? inPos('entries') : inPos('exits');
      transition(o, filled ? 'COMPLETED' : 'CANCELLED', filled ? 'Abgleich: Füllung gefunden' : 'Abgleich: keine Füllung gefunden → nicht ausgeführt');
      if (!filled && o.key && state.usedKeys.get(o.key) === 'pending') state.usedKeys.delete(o.key);
      issues.push(`Order ${o.id} (${o.side} ${o.symbol}) war ${from} → ${filled ? 'COMPLETED' : 'CANCELLED'}`);
    }
    for (const [k, v] of [...state.usedKeys.entries()]) if (v === 'pending') state.usedKeys.delete(k);
    for (const j of state.journal) if (j.status === 'OPEN' && !state.positions.some(p => p.id === j.id)) { j.status = 'UNRESOLVED'; issues.push(`Journal ${j.id} (${j.symbol}) offen ohne Position → UNRESOLVED`); }
    for (const p of state.positions) if (!state.journal.some(j => j.id === p.id)) {
      state.journal.unshift({ id: p.id, tokenId: p.tokenId, symbol: p.symbol, name: p.name || '', mint: p.mint, pair: p.pair, dexId: p.dexId, mode: p.mode, status: 'OPEN', openedAt: p.openedAt, closedAt: null, entries: deepClone(p.entries), exits: deepClone(p.exits), sizeUsd: p.investedUsd, feesUsd: p.feesUsd, slippageUsd: p.slippageUsd, score: p.entryScore, confidence: null, risk: null, signals: [], strategy: p.strategy, auto: null, reason: 'Aus Positionsdaten rekonstruiert (Abgleich)', sources: [], tags: ['RECONCILED'], regime: [], decision: null, paramVersion: p.paramVersion, result: null, exitReason: null, mae2m: null, holdMs: null });
      issues.push(`Position ${p.symbol} ohne Journal-Eintrag → Eintrag rekonstruiert`);
    }
    // Buy-Zähler nie senken: mindestens Anzahl abgeschlossener BUY-Orders der aktuellen Session
    const sid = state.session ? state.session.id : null;
    if (sid) {
      const cnt = {}; for (const o of state.orders) if (o.side === 'BUY' && o.state === 'COMPLETED' && o.key && o.key.endsWith(':' + sid)) cnt[o.tokenId] = (cnt[o.tokenId] || 0) + 1;
      for (const [id, n] of Object.entries(cnt)) if ((state.risk.buyCount[id] || 0) < n) { state.risk.buyCount[id] = Math.min(n, HARD_LIMITS.MAX_BUYS_PER_COIN); issues.push(`Buy-Zähler ${id.slice(7, 13)}… auf ${n} korrigiert`); }
    }
    const sq = loadInfo.seqs;
    if (sq) { const vals = [sq.runtime, sq.positions, sq.trades].filter(x => x != null); if (vals.length && new Set(vals).size > 1) issues.push(`Speicherbereiche nicht synchron (Runtime ${sq.runtime}, Positionen ${sq.positions}, Trades ${sq.trades})`); }
    for (const c of loadInfo.corrupted || []) issues.push(`Speicherbereich „${c}“ beschädigt – mit sicheren Defaults ersetzt`);
    if (issues.length) {
      state.reconciliation = { required: true, issues: [...state.reconciliation.issues, ...issues].slice(-40), at: env.now() };
      log.warn('SYSTEM', `RECONCILIATION REQUIRED: ${issues.length} Punkt(e) – neue Käufe blockiert bis zur Bestätigung`);
    }
    return issues.length;
  }
  function ackReconciliation() {
    if (!state.reconciliation.required) return { ok: true };
    audit('USER', 'RECONCILIATION_ACK', state.reconciliation.issues.length + ' Punkte bestätigt', state.reconciliation.issues.slice(0, 5).join('; '));
    state.reconciliation = { required: false, issues: [], at: env.now() };
    log.info('SYSTEM', 'Abgleich bestätigt – Handel wieder möglich (alle anderen Regeln gelten weiter)');
    persistNow();
    return { ok: true };
  }
  function init(o = {}) {
    const loaded = store.load();
    state.loadInfo = { migrated: loaded.migrated || 0, corrupted: arr(loaded.corrupted).length > 0, hadData: !!loaded.data };
    hydrate(loaded.data);
    reconcile({ seqs: loaded.data && loaded.data.seqs, corrupted: arr(loaded.corrupted).filter(c => ['runtime', 'positions', 'trades', 'v2'].includes(c)) });
    ensureSession();
    if (!state.paramVersions.length) { state.paramVersions.push({ version: 1, ts: env.now(), params: pickTunable(), status: 'STABLE', note: 'Initiale Parameter', perf: null, tradeCount: 0, basedOn: null }); state.activeParam = 1; }
    for (const p of state.positions) ensureToken(p.mint, 'Position');
    for (const id of Object.keys(state.watchlist)) ensureToken(mintOfId(id), 'Watchlist');
    rpcEndpoints();
    dayRollover();
    if (state.bot.emergency) { state.bot.state = 'EMERGENCY_STOP'; if (S().keepScannerOnEstop && o.autoStart !== false) startScanner(); }
    else if (o.autoStart !== false && state.bot.desired !== 'STOPPED') { setBotState('STARTING', 'Systemstart'); state.bot.startedAt = env.now(); startScanner(); setBotState('RECOVERING', 'Datenqualität wird geprüft'); }
    log.info('SYSTEM', `Smart Lab v${APP_VERSION} initialisiert · Modus ${state.mode} · Auto-Trading ${state.bot.autoTrading ? 'AN' : 'AUS'}${state.loadInfo.migrated ? ' · Daten aus v' + state.loadInfo.migrated + ' migriert' : ''}`);
    persistNow();
  }

  /* ---------- Export / Import / Reset ---------- */
  function exportData(kind) {
    const ts = new Date(env.now()).toISOString().replace(/[:.]/g, '-');
    if (kind === 'journal-csv') {
      const cols = ['id', 'mode', 'status', 'symbol', 'mint', 'pair', 'openedAt', 'closedAt', 'sizeUsd', 'feesUsd', 'slippageUsd', 'pnlUsd', 'pnlPct', 'score', 'confidence', 'risk', 'strategy', 'signals', 'exitReason', 'holdMin', 'reason'];
      const rows = state.journal.map(j => [j.id, j.mode, j.status, j.symbol, j.mint, j.pair, isoTime(j.openedAt), isoTime(j.closedAt), j.sizeUsd, j.feesUsd, j.slippageUsd, j.result ? j.result.pnlUsd : '', j.result && isNum(j.result.pnlPct) ? j.result.pnlPct.toFixed(2) : '', j.score, j.confidence, j.risk ? j.risk.total : '', j.strategy, j.signals.map(s => s.type).join('|'), j.exitReason, j.holdMs ? (j.holdMs / MIN).toFixed(1) : '', j.reason]);
      return { name: `smartlab-journal-${ts}.csv`, mime: 'text/csv', data: [cols, ...rows].map(r => r.map(csvCell).join(',')).join('\n') };
    }
    const payloads = {
      'journal-json': () => ({ journal: state.journal }),
      'settings-json': () => ({ settings: state.settings, strategies: state.strategies, watchlist: state.watchlist }),
      'analytics-json': () => ({ performance: perfStats(state.journal), stratStats: state.stratStats, falseSignals: state.falseSignals, paramVersions: state.paramVersions, sessions: state.sessions, hist: state.hist }),
      'logs-json': () => ({ logs: log.entries, audit: state.auditLog, config: state.configLog })
    };
    if (!payloads[kind]) throw new Error('Unbekannter Export');
    return { name: `smartlab-${kind.replace('-json', '')}-${ts}.json`, mime: 'application/json', data: JSON.stringify({ app: APP_VERSION, exportedAt: isoTime(env.now()), kind, ...payloads[kind]() }, null, 2) };
  }
  function importSettings(text) {
    const d = parseJSON(text); if (!d || typeof d !== 'object') return { ok: false, errors: [{ msg: 'Datei ist kein gültiges JSON' }] };
    const errors = [];
    if (d.settings) errors.push(...updateSettings(d.settings, 'IMPORT').errors);
    if (d.strategies) errors.push(...updateStrategies(d.strategies, 'IMPORT').errors);
    let wl = 0;
    if (d.watchlist && typeof d.watchlist === 'object') for (const [k, w] of Object.entries(d.watchlist)) if (isMint(mintOfId(k))) { addWatch(k); updateWatch(k, w || {}); wl++; }
    audit('USER', 'IMPORT', `Settings/Strategien/Watchlist (${wl} Einträge)`);
    return { ok: true, errors, watchlist: wl };
  }
  function resetSettings() { const r = updateSettings(defaultSettings(), 'RESET'); updateStrategies(defaultStrategies(), 'RESET'); audit('USER', 'CONFIG_RESET', ''); return r; }
  function resetPortfolio() {
    if (state.positions.length) return { ok: false, error: 'Nicht möglich: offene Positionen vorhanden' };
    state.portfolio = freshPortfolio(S().simCapitalUsd); state.risk.dailyStartEquity = S().simCapitalUsd; state.hist.equity = [];
    audit('USER', 'PORTFOLIO_RESET', fmtUsd(S().simCapitalUsd)); persistNow(); return { ok: true };
  }
  function newSession() {
    ensureSession(); state.sessions.unshift({ ...state.session, endedAt: env.now() });
    let reset = 0;
    if (S().resetBuyCountOnSession) for (const id of Object.keys(state.risk.buyCount)) if (!openPos(id)) { delete state.risk.buyCount[id]; reset++; }
    state.session = null; ensureSession();
    audit('USER', 'SESSION_RESET', `${reset} Buy-Zähler zurückgesetzt (Cooldowns bleiben aktiv)`); log.info('SYSTEM', `Neue Session ${state.session.id} – ${reset} Buy-Zähler zurückgesetzt`);
    persistNow(); return { ok: true, reset };
  }
  function factoryReset() {
    stopScanner();
    storageFrozen = true; // nach Reset nichts mehr zurückschreiben
    store.clear(); for (const k of ['c', 'w', 's', 'h', 'fd']) opts.backend.remove(k);
    return { ok: true };
  }
  function select(id) {
    state.selected = id && state.markets.has(id) ? id : null;
    const t = state.selected && state.markets.get(state.selected);
    if (t) enqueueSecurity(t, 2000);
  }

  return {
    state, log, http, env, on, init, S, HARD_LIMITS,
    start, pause, stop, emergencyStop, releaseEmergency, setMode, setAutoTrading, setSafeMode,
    executeBuy, executeSell, execCheck: (t, o) => execCheck(t, t.A, o), globalBlockers, buildCtx, estFees, estImpact, equityInfo, portfolioRisk, positionCorrelations,
    systemHealth, diagnostics, botHealth, readiness, candidateChain, liveReadiness, preLiveChecks, ackReconciliation, requestSignature, rpcEndpoints, fetchOhlcv, fetchCandlesForBacktest, walletConnect, walletDisconnect, walletBalance, walletNetwork,
    updateSettings, updateStrategies, rollbackTo, addWatch, removeWatch, updateWatch, select, exportData, importSettings, resetSettings, resetPortfolio,
    newSession, factoryReset, persistNow, enqueueSecurity, clearFeed: () => { state.feed = []; persist(); },
    _t: { scanOnce, updateSolPrice, applySnapshot, applyAlt, fetchChunk, reconcile, analyzeAll, startScanner, stopScanner, timers, managePositions, closePosition, processQueue, enqueue, checkSecurity, ensureToken, maybeAutoTrade, setBotState }
  };
}

/* ============================== TESTING SYSTEM (Selbsttest & Chaos-Tests) ==============================
   Läuft ausschließlich gegen isolierte Core-Instanzen mit Memory-Storage und Mock-Netzwerk.
   TESTDATEN werden nie im Live-Scanner angezeigt und nie gespeichert. */
function mockResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: k => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) }, text: async () => text };
}
const tMint = n => ('Tst' + n).padEnd(40, 'A');
function makeTestHarness() {
  let offset = 0; let online = true;
  const base = Date.UTC(2026, 0, 5, 12, 0, 0), start = Date.now();
  const H = { market: {}, fail: null, rpcFail: false, rugFail: false, delays: {}, calls: [] };
  const env = {
    now: () => base + (Date.now() - start) + offset, advance: ms => { offset += ms; },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
    random: () => 0.5, online: () => online, setOnline: v => { online = v; }, walletProvider: () => null,
    fetch: async (url, init) => {
      H.calls.push(url);
      if (init && init.signal && init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (H.fail) { const f = H.fail(url, init); if (f) { if (f instanceof Error) throw f; return mockResponse(f.status, f.body, f.headers || {}); } }
      const d = Object.keys(H.delays).find(k => url.includes(k));
      if (d) await new Promise(r => setTimeout(r, H.delays[d]));
      if (url.startsWith(DEX_API + '/tokens/v1/solana/')) {
        const mints = url.split('/').pop().split(',');
        if (mints.length === 1 && mints[0] === WSOL) return mockResponse(200, [{ chainId: 'solana', dexId: 'raydium', pairAddress: tMint(9), baseToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' }, quoteToken: { address: USDC, symbol: 'USDC' }, priceUsd: '150.00', liquidity: { usd: 5e6 }, volume: {}, txns: {}, priceChange: { h1: 0.5, h24: 2 } }]);
        return mockResponse(200, mints.filter(m => H.market[m]).map(m => H.market[m]()));
      }
      if (url.startsWith(DEX_API)) return mockResponse(200, []);
      if (url.startsWith(GT_API)) return mockResponse(200, url.includes('/ohlcv/') ? { data: { attributes: { ohlcv_list: [] } } } : { data: [] });
      if (url.startsWith(RUG_API)) return H.rugFail ? mockResponse(500, 'err') : mockResponse(200, { score: 120, score_normalised: 4, risks: [], lpLockedPct: 100 });
      if (init && init.method === 'POST') {
        if (H.rpcFail) return mockResponse(503, 'down');
        const body = parseJSON(init.body, {});
        if (body.method === 'getAccountInfo') return mockResponse(200, { jsonrpc: '2.0', id: 1, result: { value: { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000', mintAuthority: null, freezeAuthority: null, isInitialized: true } } } } } });
        if (body.method === 'getTokenLargestAccounts') return mockResponse(200, { jsonrpc: '2.0', id: 1, result: { value: Array.from({ length: 10 }, (_, i) => ({ address: tMint(i + 1), amount: '20000000000', decimals: 6 })) } });
        if (body.method === 'getSlot') return mockResponse(200, { jsonrpc: '2.0', id: 1, result: 300000000 });
        if (body.method === 'getBalance') return mockResponse(200, { jsonrpc: '2.0', id: 1, result: { value: 1000000000 } });
        return mockResponse(200, { jsonrpc: '2.0', id: 1, error: { message: 'unbekannte Methode' } });
      }
      return mockResponse(404, 'not found');
    }
  };
  H.env = env;
  H.pair = (mint, o = {}) => () => ({
    chainId: 'solana', dexId: 'raydium', url: 'https://dexscreener.com/solana/test', pairAddress: o.pair || ('Pa' + mint.slice(3)),
    baseToken: { address: mint, name: 'Testtoken ' + mint.slice(3, 5), symbol: o.sym || 'TST' + mint.slice(3, 4) }, quoteToken: { address: WSOL, symbol: 'SOL' },
    priceUsd: o.price === null ? null : String(o.price != null ? o.price : 0.001), priceNative: '0.0000066',
    txns: { m5: { buys: o.b5 != null ? o.b5 : 60, sells: o.s5 != null ? o.s5 : 30 }, h1: { buys: o.b1 != null ? o.b1 : 600, sells: o.s1 != null ? o.s1 : 350 }, h6: { buys: 2000, sells: 1500 }, h24: { buys: 5000, sells: 4000 } },
    volume: { m5: o.v5 != null ? o.v5 : 12000, h1: o.v1 != null ? o.v1 : 80000, h6: 300000, h24: 900000 },
    priceChange: { m5: o.c5 != null ? o.c5 : 6, h1: o.c1 != null ? o.c1 : 12, h6: 20, h24: 40 },
    liquidity: { usd: o.liq != null ? o.liq : 150000 }, fdv: o.mc || 1500000, marketCap: o.mc || 1500000, pairCreatedAt: env.now() - 3 * DAY
  });
  return H;
}
async function testCore(H, settings) {
  const core = createCore({ env: H.env, backend: H.backend || (H.backend = createMemoryBackend()) });
  core.init({ autoStart: false });
  core.updateSettings({ minPairAgeMin: 0, ...(settings || {}) }, 'TEST');
  await core._t.updateSolPrice(true);
  return core;
}
async function prepToken(core, H, n, o) {
  const m = tMint(n); H.market[m] = H.pair(m, o);
  core._t.ensureToken(m, 'Test');
  await core._t.fetchChunk([m], true);
  const t = core.state.markets.get(tokenIdOf(m));
  t.sec = await core._t.checkSecurity(m);
  return t;
}
const codes = r => (r && r.blockers ? r.blockers.map(b => b.code) : []);
function assert(c, msg) { if (!c) throw new Error(msg); }

const SELF_TESTS = [
  ['Grundlagen', 'Token-Identität: solana:<mint>, nie nur Symbol', async () => {
    const a = tMint(1), b = tMint(2);
    assert(tokenIdOf(a) === 'solana:' + a, 'ID-Format falsch');
    assert(tokenIdOf(a) !== tokenIdOf(b), 'unterschiedliche Mints müssen unterschiedliche IDs haben');
    assert(!isMint('0OIl-invalid') && !isMint('SOL'), 'ungültige Mint akzeptiert');
    const H = makeTestHarness(); const core = await testCore(H);
    await prepToken(core, H, 1, { sym: 'SAME' }); await prepToken(core, H, 2, { sym: 'SAME' });
    assert(core.state.markets.size === 2, 'Gleiches Symbol darf Tokens nicht zusammenlegen');
    return 'gleiches Symbol → 2 getrennte Tokens';
  }],
  ['Grundlagen', 'Decimal Precision & SOL/Lamports', async () => {
    assert(fmtPrice(0.00001234) === '$0.0₄1234', 'fmtPrice klein: ' + fmtPrice(0.00001234));
    assert(lamportsToSol(1234567890n) === '1.234567890', 'lamportsToSol');
    assert(solToLamports('0.000005') === 5000n && solToLamports('1.5') === 1500000000n, 'solToLamports');
    assert(rawToUi('1234500', 6) === 1.2345, 'rawToUi');
    return 'Preise, SOL und Token-Decimals exakt';
  }],
  ['Grundlagen', 'Config Validation & harte Grenzen', async () => {
    const { settings: s, errors } = validateSettings({ simCapitalUsd: -5, maxBuysPerCoin: 5, sellCooldownMin: 1, lossStreakLimit: 9, scanIntervalMs: 'abc', minMcap: 1e6, maxMcap: 1e5 });
    assert(s.simCapitalUsd === 10, 'negatives Kapital nicht begrenzt');
    assert(s.maxBuysPerCoin === 2, 'Buy-Limit > 2 akzeptiert');
    assert(s.sellCooldownMin === 15 && s.lossStreakLimit === 3, 'Cooldown/Serie unter Sicherheitsgrenze');
    assert(s.scanIntervalMs === 1000 && errors.some(e => e.key === 'scanIntervalMs'), 'NaN nicht abgelehnt');
    assert(s.minMcap <= s.maxMcap && errors.some(e => /Market Cap/.test(e.msg)), 'Min/Max nicht geprüft');
    assert(Object.isFrozen(HARD_LIMITS) && !Object.keys(TUNING_BOUNDS).some(k => ['maxBuysPerCoin', 'sellCooldownMin', 'lossCooldownMin', 'globalPauseMin', 'maxExposurePct'].includes(k)), 'Auto-Tuning darf harte Limits nicht verändern');
    return `${errors.length} Validierungsfehler korrekt erkannt`;
  }],
  ['Trading', 'Max. 2 Käufe pro Coin (Buy #3 BLOCKED)', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    const r1 = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(r1.ok, 'Buy #1 fehlgeschlagen: ' + codes(r1).join(',') + (r1.error || ''));
    H.market[t.mint] = H.pair(t.mint, { price: 0.0013 }); await core._t.fetchChunk([t.mint], true); await core._t.managePositions();
    const r2 = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(r2.ok, 'Buy #2 fehlgeschlagen: ' + codes(r2).join(','));
    H.market[t.mint] = H.pair(t.mint, { price: 0.002 }); await core._t.fetchChunk([t.mint], true);
    const r3 = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(!r3.ok && codes(r3).includes('BUY_LIMIT_REACHED'), 'Buy #3 nicht blockiert: ' + codes(r3).join(','));
    return 'Buy #1 ✓ · Buy #2 ✓ · Buy #3 BUY_LIMIT_REACHED';
  }],
  ['Trading', 'Coin-Cooldown 15 min nach Verkauf', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    assert((await core.executeBuy(t.id, { sizeUsd: 20 })).ok, 'Buy fehlgeschlagen');
    const s = await core.executeSell(core.state.positions[0].id, 'ALL', 'MANUAL'); assert(s.ok, 'Sell fehlgeschlagen');
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(codes(r).includes('COOLDOWN_ACTIVE'), 'kein Coin-Cooldown: ' + codes(r).join(','));
    H.env.advance(15 * MIN + SEC); await core._t.updateSolPrice(true); t.sec = await core._t.checkSecurity(t.mint);
    const r2 = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(!codes(r2).includes('COOLDOWN_ACTIVE'), 'Cooldown nach 15 min noch aktiv');
    return 'Cooldown aktiv direkt nach Verkauf, frei nach 15 min';
  }],
  ['Trading', 'Loss-Cooldown & globale Pause nach 3 Verlusten', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    for (let i = 1; i <= 3; i++) {
      const t = await prepToken(core, H, i);
      const b = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(b.ok, `Buy ${i} fehlgeschlagen: ` + codes(b).join(','));
      const s = await core.executeSell(core.state.positions[0].id, 'ALL', 'MANUAL'); assert(s.ok, 'Sell fehlgeschlagen');
      if (i < 3) { const blocked = await core.executeBuy((await prepToken(core, H, 7)).id, { sizeUsd: 20 }); assert(codes(blocked).includes('LOSS_COOLDOWN'), 'Loss-Cooldown fehlt'); H.env.advance(10 * MIN + SEC); await core._t.updateSolPrice(true); }
    }
    assert(core.state.risk.lossStreak === 3, 'Verlustserie ' + core.state.risk.lossStreak);
    const t8 = await prepToken(core, H, 8);
    assert(codes(await core.executeBuy(t8.id, { sizeUsd: 20 })).includes('GLOBAL_PAUSE'), 'globale Pause fehlt');
    H.env.advance(5 * MIN + SEC); await core._t.updateSolPrice(true); await core._t.fetchChunk([t8.mint], true); t8.sec = await core._t.checkSecurity(t8.mint);
    const after = await core.executeBuy(t8.id, { sizeUsd: 20 });
    assert(!codes(after).includes('GLOBAL_PAUSE') && codes(after).includes('LOSS_COOLDOWN'), 'Pause/Loss-Cooldown-Zeiten falsch: ' + codes(after).join(','));
    return '3 Verluste → GLOBAL_PAUSE 5 min, Loss-Cooldown 10 min';
  }],
  ['Trading', 'Duplicate Order Protection (Doppelklick, parallele Signale)', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => core.executeBuy(t.id, { sizeUsd: 20 })));
    const ok = rs.filter(r => r.ok).length;
    assert(ok === 1, `${ok} Orders ausgeführt statt 1`);
    assert(rs.filter(r => !r.ok).every(r => codes(r).includes('TRADE_LOCKED')), 'Sperrgrund falsch');
    assert(core.state.positions.length === 1 && core.state.positions[0].entries.length === 1, 'mehr als eine Füllung');
    return '5 parallele Käufe → genau 1 Order';
  }],
  ['Trading', 'Emergency Stop / Kill Switch blockiert Käufe', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    core._t.enqueue(t.id, 'momentum');
    await core.emergencyStop('Test');
    assert(core.state.queue.length === 0, 'Queue nicht geleert');
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(codes(r)[0] === 'EMERGENCY_STOP', 'Kauf trotz Emergency Stop: ' + codes(r).join(','));
    assert(!core.start().ok, 'Start trotz Emergency Stop möglich');
    return 'Käufe blockiert, Queue geleert, Start gesperrt';
  }],
  ['Trading', 'Kein Nachkauf im Verlust (No Martingale / Blind DCA)', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    assert((await core.executeBuy(t.id, { sizeUsd: 20 })).ok, 'Buy #1 fehlgeschlagen');
    H.market[t.mint] = H.pair(t.mint, { price: 0.0009 }); await core._t.fetchChunk([t.mint], true); await core._t.managePositions();
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(codes(r).includes('NO_AVERAGING_DOWN'), 'Nachkauf im Verlust erlaubt: ' + codes(r).join(','));
    return 'Buy #2 bei −10 % → NO_AVERAGING_DOWN';
  }],
  ['Trading', 'Max. Exposure wird eingehalten', async () => {
    const H = makeTestHarness(); const core = await testCore(H, { maxExposurePct: 1, maxPositionPct: 1 });
    const a = await prepToken(core, H, 1), b = await prepToken(core, H, 2);
    assert((await core.executeBuy(a.id, { sizeUsd: 10 })).ok, 'erster Kauf fehlgeschlagen');
    const r = await core.executeBuy(b.id, { sizeUsd: 10 }); assert(codes(r).includes('EXPOSURE_LIMIT'), 'Exposure-Limit ignoriert: ' + codes(r).join(','));
    return 'zweite Position → EXPOSURE_LIMIT';
  }],
  ['Daten', 'Stale Data = No Buy', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    H.fail = url => (url.includes(t.mint) ? { status: 500, body: 'err' } : null);
    H.env.advance(30 * SEC);
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(!r.ok && codes(r).includes('DATA_STALE'), 'Kauf mit veralteten Daten: ' + codes(r).join(','));
    return 'Daten 30 s alt → DATA_STALE';
  }],
  ['Daten', 'No Data / Missing Price = No Buy', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    const t = await prepToken(core, H, 1, { price: null });
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(!r.ok && codes(r).includes('PRICE_MISSING'), 'Kauf ohne Preis: ' + codes(r).join(','));
    const m = tMint(5); core._t.ensureToken(m, 'Test');
    const r2 = await core.executeBuy(tokenIdOf(m), { sizeUsd: 20 }); assert(!r2.ok && codes(r2).includes('PRICE_MISSING'), 'Kauf ohne Daten');
    return 'Preis null / keine Daten → PRICE_MISSING';
  }],
  ['Daten', 'Security Unknown = No Buy (auch manuell)', async () => {
    const H = makeTestHarness(); H.rpcFail = true; H.rugFail = true;
    const core = await testCore(H); const t = await prepToken(core, H, 1);
    assert(t.sec.status === 'UNKNOWN', 'Security sollte UNKNOWN sein: ' + t.sec.status);
    core._t.analyzeAll();
    assert(t.D.decision !== 'APPROVED' && t.D.blockers.some(b => b.code === 'SECURITY_UNKNOWN'), 'Auto-Decision ohne Security');
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(codes(r).includes('SECURITY_UNKNOWN'), 'manueller Kauf ohne Security');
    return 'SECURITY_UNKNOWN blockiert Auto & manuell';
  }],
  ['Daten', 'Security CRITICAL (Freeze Authority) erkannt', async () => {
    const sec = buildSecurity({ exists: true, program: 'spl-token', mintAuthority: null, freezeAuthority: tMint(3), extensions: [] }, null, null, Date.now());
    assert(sec.status === 'CRITICAL' && sec.flags.some(f => f.code === 'FREEZE_AUTHORITY'), 'Freeze Authority nicht erkannt');
    const ok = buildSecurity({ exists: true, program: 'spl-token', mintAuthority: null, freezeAuthority: null, extensions: [] }, null, normRug({ score: 1, risks: [] }), Date.now());
    assert(ok.status === 'VERIFIED', 'saubere Daten nicht VERIFIED');
    return 'CRITICAL / VERIFIED korrekt';
  }],
  ['Daten', 'Pump wird nie als Buy interpretiert', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1, { c5: 75, v5: 60000, v1: 90000, b5: 290, s5: 10 });
    core._t.analyzeAll();
    assert(t.A.pump.detected && t.D.decision !== 'APPROVED' && t.D.blockers.some(b => b.code === 'PUMP_DETECTED'), 'Pump nicht blockiert');
    return 'PUMP_DETECTED: ' + t.A.pump.flags.length + ' Muster';
  }],
  ['Chaos', 'API-Ausfall → OFFLINE, keine Fake-Daten, kein Kauf', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    const priceBefore = t.snap.priceUsd;
    H.fail = () => new TypeError('Failed to fetch');
    for (let i = 0; i < 4; i++) { H.env.advance(70 * SEC); await core._t.scanOnce(); }
    assert(core.http.status('dexPairs') === 'OFFLINE', 'Status nicht OFFLINE: ' + core.http.status('dexPairs'));
    assert(t.snap.priceUsd === priceBefore, 'Snapshot verändert ohne Daten');
    const r = await core.executeBuy(t.id, { sizeUsd: 20 });
    assert(!r.ok && codes(r).some(c => ['SYSTEM_UNHEALTHY', 'DATA_STALE', 'PRICE_MISSING', 'FEE_UNKNOWN'].includes(c)), 'Kauf trotz Ausfall');
    return 'dexPairs OFFLINE, Kauf blockiert (' + codes(r).slice(0, 2).join(', ') + ')';
  }],
  ['Chaos', 'Falsches JSON & Nullwerte werden sicher behandelt', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const m = tMint(1);
    H.fail = url => (url.includes(m) ? { status: 200, body: '{kaputt' } : null);
    core._t.ensureToken(m, 'Test');
    let code = null; try { await core._t.fetchChunk([m], true); } catch (e) { code = e.code; }
    assert(code === 'BAD_JSON', 'BAD_JSON nicht erkannt: ' + code);
    assert(!core.state.markets.get(tokenIdOf(m)).snap, 'Snapshot aus kaputtem JSON');
    const n = normDexPair({ chainId: 'solana', baseToken: { address: m }, priceUsd: null, liquidity: null, volume: null, txns: { m5: null }, priceChange: 'x' }, Date.now());
    assert(n && n.priceUsd === null && n.liquidityUsd === null && n.vol.h1 === null && n.txns.m5 === null, 'Nullwerte falsch normalisiert');
    assert(normDexPair(null) === null && normDexPair({ chainId: 'eth' }) === null, 'ungültige Pairs akzeptiert');
    return 'BAD_JSON erkannt, Nullwerte bleiben null';
  }],
  ['Chaos', 'Rate Limit (429) → Backoff, keine weiteren Requests', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const m = tMint(1);
    H.fail = url => (url.includes(m) ? { status: 429, body: 'slow down' } : null);
    let c1 = null; try { await core._t.fetchChunk([m], true); } catch (e) { c1 = e.code; }
    const calls = H.calls.length; let c2 = null;
    try { await core._t.fetchChunk([m], true); } catch (e) { c2 = e.code; }
    assert(c1 === 'HTTP_429' && c2 === 'BACKOFF' && H.calls.length === calls, `429=${c1}, danach=${c2}, Requests +${H.calls.length - calls}`);
    return 'HTTP 429 → Backoff ≥ 9 s, kein weiterer Request';
  }],
  ['Chaos', 'Doppelter Scan (Scanner Lock)', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    const [a, b] = await Promise.all([core._t.scanOnce(), core._t.scanOnce()]);
    assert((a.skipped ? 1 : 0) + (b.skipped ? 1 : 0) === 1, 'Scans liefen parallel');
    return 'zweiter paralleler Scan übersprungen';
  }],
  ['Chaos', 'Verspätete Response überschreibt keine neueren Daten', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const m = tMint(1), m2 = tMint(2);
    core._t.ensureToken(m, 'Test'); core._t.ensureToken(m2, 'Test');
    H.market[m] = H.pair(m, { price: 0.001 }); H.market[m2] = H.pair(m2);
    H.delays[m + ',' + m2] = 80;
    const slow = core._t.fetchChunk([m, m2], true);
    await new Promise(r => setTimeout(r, 5));
    H.market[m] = H.pair(m, { price: 0.002 });
    await core._t.fetchChunk([m], true);
    await slow;
    const p = core.state.markets.get(tokenIdOf(m)).snap.priceUsd;
    assert(p === 0.002, 'alte Antwort hat neuere überschrieben: ' + p);
    assert(core.state.scanner.lateIgnored >= 1, 'Race nicht erkannt');
    return 'verspätete Antwort verworfen';
  }],
  ['Chaos', 'Reload/Crash Recovery (RECONCILING)', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    assert((await core.executeBuy(t.id, { sizeUsd: 20 })).ok, 'Buy fehlgeschlagen');
    core.state.orders.unshift({ id: 'ORD-STUCK', key: 'stuck', tokenId: t.id, mint: t.mint, symbol: t.symbol, side: 'BUY', state: 'SUBMITTING', history: [{ s: 'SUBMITTING', ts: H.env.now() }], createdAt: H.env.now() });
    core.persistNow();
    const core2 = createCore({ env: H.env, backend: H.backend }); core2.init({ autoStart: false });
    const stuck = core2.state.orders.find(o => o.id === 'ORD-STUCK');
    assert(stuck && stuck.state === 'CANCELLED' && stuck.history.some(h => h.s === 'RECONCILING'), 'hängende Order nicht abgeglichen');
    assert(core2.state.positions.length === 1 && core2.state.risk.buyCount[t.id] === 1, 'Position/Buy-Zähler nicht wiederhergestellt');
    assert(core2.state.orders.filter(o => o.side === 'BUY' && o.state === 'COMPLETED').length === 1, 'abgeschlossene Order verloren');
    return 'Order RECONCILING → CANCELLED, Position & Zähler erhalten';
  }],
  ['Chaos', 'Offline-Modus: UI offen, Trading deaktiviert', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    H.env.setOnline(false);
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(codes(r).includes('OFFLINE'), 'Kauf offline möglich: ' + codes(r).join(','));
    return 'OFFLINE blockiert';
  }],
  ['System', 'LIVE-Modus nicht versehentlich aktivierbar', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    const r = core.setMode('LIVE'); assert(!r.ok && core.state.mode === 'SIMULATION', 'LIVE aktiviert');
    assert(core.setAutoTrading(true).ok, 'Auto-Trading in SIMULATION muss möglich sein');
    core.setMode('READ_ONLY'); assert(!core.setAutoTrading(true).ok, 'Auto-Trading in READ ONLY möglich');
    return 'LIVE verweigert, Modi getrennt';
  }],
  ['System', 'Timer Safety (keine doppelten Timer)', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    assert(core._t.startScanner() === true && core._t.startScanner() === false, 'Scanner doppelt gestartet');
    await new Promise(r => setTimeout(r, 30));
    assert(core._t.timers.size <= 2, 'zu viele Timer: ' + core._t.timers.size);
    core._t.stopScanner(); await new Promise(r => setTimeout(r, 60));
    assert(core._t.timers.size === 0, 'Timer nach Stop aktiv: ' + core._t.timers.size);
    return 'Start idempotent, Stop räumt alle Timer ab';
  }],
  ['System', 'Order State Machine & kein Math.random im Trading', async () => {
    assert(ORDER_TRANSITIONS.DETECTED.indexOf('COMPLETED') === -1 && [...TERMINAL].every(s => ORDER_TRANSITIONS[s].length === 0), 'ungültige Übergänge möglich');
    const fns = [analyzeToken, decideToken, evalStrategies, runBacktest, walkForward, computeRegime, perfStats, createCore, buildSecurity];
    assert(fns.every(f => !String(f).includes('Math.random')), 'Math.random in Handelslogik gefunden');
    return 'Terminalzustände final, keine Zufallslogik';
  }],
  ['Status', 'Normaler Scan liefert Analyse & Entscheidungen', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    for (let i = 1; i <= 4; i++) { const m = tMint(i); H.market[m] = H.pair(m); core._t.ensureToken(m, 'Test'); }
    const r = await core._t.scanOnce();
    assert(!r.error && !r.skipped, 'Scan fehlgeschlagen: ' + (r.error || 'skipped'));
    const toks = [...core.state.markets.values()].filter(t => t.A && t.D);
    assert(toks.length === 4, `${toks.length} statt 4 Tokens analysiert`);
    assert(toks.every(t => core.candidateChain(t).text.includes('FINAL:')), 'Kandidaten-Kette fehlt');
    return '4 Tokens gescannt, Kette pro Kandidat vorhanden';
  }],
  ['Status', 'Kein Kandidat / niedriger Score → WAITING, nicht BLOCKED', async () => {
    const H = makeTestHarness(); const core = await testCore(H, { minScore: 99 });
    const t = await prepToken(core, H, 1);
    core._t.setBotState('STARTING'); core._t.setBotState('RUNNING');
    core._t.analyzeAll();
    const rd = core.readiness();
    assert(t.D.blockers.some(b => b.code === 'SCORE_TOO_LOW'), 'SCORE_TOO_LOW erwartet');
    assert(rd.state === 'WAITING', 'Status ' + rd.state + ': ' + rd.reason);
    assert(core.candidateChain(t).text.includes('SCORE TOO LOW') && core.candidateChain(t).final === 'NO TRADE', 'Kette falsch: ' + core.candidateChain(t).text);
    return 'WAITING · ' + core.candidateChain(t).text.split(' → ').slice(-2).join(' → ');
  }],
  ['Status', 'Kein Konsens → WAITING, nicht BLOCKED', async () => {
    const H = makeTestHarness(); const core = await testCore(H, { consensusMinWeight: 5 });
    const t = await prepToken(core, H, 1);
    core._t.setBotState('STARTING'); core._t.setBotState('RUNNING');
    core._t.analyzeAll();
    assert(t.D.blockers.some(b => b.code === 'NO_CONSENSUS'), 'NO_CONSENSUS erwartet');
    assert(core.readiness().state === 'WAITING', 'Status ' + core.readiness().state);
    return 'NO_CONSENSUS → WAITING';
  }],
  ['Status', 'Kandidat vorhanden → READY; harter Block → BLOCKED', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    await prepToken(core, H, 1);
    core._t.setBotState('STARTING'); core._t.setBotState('RUNNING');
    core._t.analyzeAll();
    const r1 = core.readiness();
    assert(r1.state === 'READY', 'erwartet READY, ist ' + r1.state + ': ' + r1.reason);
    core.setSafeMode(true);
    const r2 = core.readiness(); assert(r2.state === 'BLOCKED' && r2.hard[0].code === 'SAFE_MODE', 'Safe Mode nicht BLOCKED');
    core.setSafeMode(false); core.state.risk.dailyLimitHit = true;
    assert(core.readiness().state === 'BLOCKED', 'Tageslimit nicht BLOCKED');
    core.state.risk.dailyLimitHit = false; await core.emergencyStop('Test');
    assert(core.readiness().state === 'EMERGENCY_STOP', 'Emergency nicht erkannt');
    return 'READY → BLOCKED (Safe Mode, Tageslimit) → EMERGENCY STOP';
  }],
  ['Chaos', 'RPC- & RugCheck-Ausfall → Security Unknown, BLOCKED', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    H.rpcFail = true; H.rugFail = true; core._t.setBotState('STARTING'); core._t.setBotState('RUNNING');
    for (let i = 0; i < 6; i++) { H.env.advance(3.5 * MIN); await core._t.updateSolPrice(true); t.sec = await core._t.checkSecurity(t.mint); await core._t.fetchChunk([t.mint], true); } // > 10 min: RugCheck-Cache abgelaufen
    assert(t.sec.status === 'UNKNOWN', 'Security ' + t.sec.status);
    const rd = core.readiness();
    assert(rd.hard.some(b => b.code === 'SECURITY_SOURCES_DOWN'), 'SECURITY_SOURCES_DOWN fehlt: ' + rd.hard.map(b => b.code).join(','));
    const r = await core.executeBuy(t.id, { sizeUsd: 20 }); assert(!r.ok, 'Kauf trotz RPC-Ausfall');
    return 'RPC OFFLINE → ' + codes(r).slice(0, 2).join(', ');
  }],
  ['Chaos', 'Inkonsistenter Speicher → RECONCILIATION REQUIRED', async () => {
    const H = makeTestHarness(); const core = await testCore(H); const t = await prepToken(core, H, 1);
    assert((await core.executeBuy(t.id, { sizeUsd: 20 })).ok, 'Buy fehlgeschlagen');
    const tr = JSON.parse(H.backend.get(STORAGE_KEYS.trades)); tr.tradeSeq = 999; H.backend.set(STORAGE_KEYS.trades, JSON.stringify(tr));
    const core2 = createCore({ env: H.env, backend: H.backend }); core2.init({ autoStart: false });
    assert(core2.state.reconciliation.required, 'Abgleich nicht angefordert');
    core2._t.setBotState('STARTING'); core2._t.setBotState('RUNNING');
    await core2._t.updateSolPrice(true); const t2 = core2.state.markets.get(t.id); await core2._t.fetchChunk([t.mint], true); t2.sec = await core2._t.checkSecurity(t.mint);
    const b = await core2.executeBuy(t.id, { sizeUsd: 20 });
    assert(codes(b).includes('RECONCILIATION_REQUIRED'), 'Kauf trotz offenem Abgleich: ' + codes(b).join(','));
    assert(core2.readiness().state === 'BLOCKED', 'Status nicht BLOCKED');
    core2.ackReconciliation();
    assert(!core2.state.reconciliation.required && !core2.globalBlockers({}).some(x => x.code === 'RECONCILIATION_REQUIRED'), 'Bestätigung wirkt nicht');
    return 'Seq-Konflikt erkannt, Käufe blockiert bis Bestätigung';
  }],
  ['System', 'Live-Gating: LIVE nur mit allen Voraussetzungen, Auto ≠ Echtgeld', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    const lr = core.liveReadiness();
    assert(!lr.ready && lr.checks.find(c => c.name === 'Wallet verbunden').ok === false && lr.checks.find(c => /Routing/.test(c.name)).ok === false, 'Gating unvollständig');
    const r = core.setMode('LIVE'); assert(!r.ok && Array.isArray(r.checks) && core.state.mode === 'SIMULATION', 'LIVE aktiviert');
    assert(core.setAutoTrading(true).ok && core.state.mode === 'SIMULATION', 'Auto-Trading verändert Modus');
    const sig = await core.requestSignature(); assert(!sig.ok && sig.code === 'SIGNING_DISABLED', 'Signatur nicht blockiert');
    const w = await core.walletConnect(); assert(!w.ok && core.state.wallet.status === 'NO_PROVIDER', 'Wallet ohne Provider verbunden');
    return `${lr.checks.filter(c => !c.ok).length} Gating-Checks offen, Signieren deaktiviert`;
  }],
  ['Daten', 'SOL-Preis-Fallback aus SOL-quotierten Pools', async () => {
    const H = makeTestHarness(); H.fail = url => (url.endsWith('/tokens/v1/solana/' + WSOL) ? { status: 500, body: 'x' } : null);
    const core = await testCore(H);
    assert(!core.state.sol, 'Direktpreis sollte fehlen');
    const ms = [1, 2, 3].map(tMint); ms.forEach(m => { H.market[m] = H.pair(m); core._t.ensureToken(m, 'Test'); });
    await core._t.fetchChunk(ms, true);
    assert(core.state.sol && core.state.sol.derived && Math.abs(core.state.sol.usd - 0.001 / 0.0000066) < 0.01, 'abgeleiteter SOL-Preis falsch: ' + JSON.stringify(core.state.sol));
    return 'SOL ≈ ' + fmtUsd(core.state.sol.usd) + ' aus ' + core.state.sol.n + ' Pools';
  }],
  ['System', 'Storage logisch getrennt (Settings/Runtime/Positionen/Trades/Logs/Stats)', async () => {
    const H = makeTestHarness(); const core = await testCore(H);
    core.persistNow();
    const missing = Object.values(STORAGE_KEYS).filter(k => H.backend.get(k) == null);
    assert(!missing.length, 'fehlende Bereiche: ' + missing.join(', '));
    const before = H.backend.get(STORAGE_KEYS.trades);
    core.updateSettings({ minScore: 70 });
    assert(H.backend.get(STORAGE_KEYS.trades) === before && JSON.parse(H.backend.get(STORAGE_KEYS.settings)).settings.minScore === 70, 'Bereiche nicht getrennt');
    return Object.keys(STORAGE_KEYS).length + ' Bereiche, nur geänderte werden geschrieben';
  }],
  ['System', 'Backtest ohne Look-Ahead', async () => {
    const c = []; let p = 1;
    for (let i = 0; i < 300; i++) { const o = p; p = p * (1 + Math.sin(i / 7) * 0.02 + (i % 50 === 25 ? 0.12 : 0)); c.push({ t: i * MIN, o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p, v: 1000 + (i % 50 === 25 ? 9000 : 0) }); }
    const cfg = { strategy: 'volume', capital: 1000, sizePct: 10, feePct: 0.3, slipPct: 0.5, tpPct: 10, slPct: 8, trailActPct: 8, trailPct: 5, timeBars: 30 };
    const full = runBacktest(c, cfg);
    const cut = runBacktest(c.slice(0, 200), cfg);
    const firstTrades = full.trades.filter(t => t.exitT < 190 * MIN);
    assert(firstTrades.every((t, i) => cut.trades[i] && cut.trades[i].entryT === t.entryT && Math.abs(cut.trades[i].pnl - t.pnl) < 1e-9), 'Ergebnisse hängen von zukünftigen Kerzen ab');
    assert(full.trades.every(t => t.entryT > 0), 'Einstieg auf Signalkerze');
    return `${full.trades.length} Trades, identisch bei abgeschnittener Zukunft`;
  }]
];
async function runSelfTests(onProgress) {
  const results = [];
  for (const [group, name, fn] of SELF_TESTS) {
    const t0 = performance.now(); let ok = false, detail = '';
    try { detail = await fn(); ok = true; } catch (e) { detail = e && e.message ? e.message : String(e); }
    results.push({ group, name, ok, detail, ms: Math.round(performance.now() - t0) });
    if (onProgress) onProgress(results);
  }
  return results;
}

/* ============================== UI LAYER ==============================
   Nur Darstellung & Interaktion. Alle externen Daten werden über html`` escaped, Links über safeUrl validiert. */
const env = {
  now: () => Date.now(),
  fetch: (u, i) => window.fetch(u, i),
  setTimeout: (f, ms) => window.setTimeout(f, ms),
  clearTimeout: id => window.clearTimeout(id),
  random: () => Math.random(), // nur Backoff-Jitter im HTTP-Layer
  online: () => navigator.onLine !== false,
  walletProvider: () => (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null)
};
const core = createCore({ env, backend: createLocalBackend() });
const UI = { alertsSeenAt: 0, view: 'scanner', sort: 'score', dir: -1, q: '', onlyRec: false, safeOnly: false, age: '', maxRisk: 100, minConf: 0, detailTab: 'overview', chartTf: 'live', logCat: 'ALL', logQ: '', logPaused: false, hq: '', hMode: '', hRes: '', rankBy: 'opportunity', kbQ: '', lastTouch: 0, tests: null, testsRunning: false, bt: null, btBusy: false };
const UI_PERSIST = ['alertsSeenAt', 'view', 'sort', 'dir', 'onlyRec', 'safeOnly', 'age', 'maxRisk', 'minConf', 'detailTab', 'chartTf', 'logCat', 'rankBy'];
const $ = id => { const e = document.getElementById(id); if (!e) domMissing(id); return e; };
const missingDom = new Set();
function domMissing(id) { if (!missingDom.has(id)) { missingDom.add(id); core.log.warn('UI', `DOM-Element #${id} nicht gefunden`); } }
function setHTML(el, h) { if (!el) return; el.innerHTML = h && h[RAW] != null ? h[RAW] : esc(h == null ? '' : h); el._sig = null; }
function patch(el, h) { if (!el) return false; const s = h && h[RAW] != null ? h[RAW] : esc(h == null ? '' : h); if (el._sig === s) return false; el.innerHTML = s; el._sig = s; return true; }
function setText(el, s) { if (el && el.textContent !== String(s)) el.textContent = String(s); }
const tok = id => core.state.markets.get(id) || null;
const selTok = () => (core.state.selected ? tok(core.state.selected) : null);
const cls = v => (isNum(v) ? (v >= 0 ? 'up' : 'dn') : '');
const scColor = s => `hsl(${Math.round(clamp(s || 0, 0, 100) * 1.2)},85%,58%)`;
const scoreChip = s => html`<span class="sc" style="background:${scColor(s)}" title="Final Score 0–100">${s}</span>`;
const lvlChip = (level, total) => html`<span class="lvl lvl-${level}" title="Risk Score">${level === 'UNKNOWN' ? 'UNKNOWN' : level} ${total != null ? total : ''}</span>`;
const lbl = l => html`<span class="lbl ${l}" title="Datenstatus">${l}</span>`;
const DEC_LABEL = { APPROVED: 'APPROVED', BUY_CANDIDATE: 'CANDIDATE', WATCH: 'WATCH', REJECTED: 'NO TRADE' };
const decChip = d => html`<span class="dec dec-${d}">${DEC_LABEL[d] || d}</span>`;
const stCls = s => (s === 'ONLINE' || s === 'OK' ? 'ok' : s === 'DEGRADED' || s === 'STALE' ? 'warn' : s === 'OFFLINE' || s === 'ERROR' ? 'bad' : '');
const kv = (k, v, l, title) => html`<div class="kv" title="${title || ''}"><small>${k}</small><b>${v}${l ? html`<em class="lbl ${l}">${l}</em>` : ''}</b></div>`;
const bar = (v, color) => html`<div class="bar"><i style="width:${clamp(v || 0, 0, 100)}%;background:${color || 'var(--cyan)'}"></i></div>`;
const riskColor = v => (v >= 75 ? 'var(--red)' : v >= 55 ? 'var(--orange)' : v >= 30 ? 'var(--yellow)' : 'var(--green)');
function saveUi() { const o = {}; for (const k of UI_PERSIST) o[k] = UI[k]; core.state.ui = o; }
function loadUi() {
  const u = core.state.ui || {};
  const views = new Set(VIEWS.map(v => v[0]));
  if (views.has(u.view)) UI.view = u.view;
  if (SORTS.some(s => s[0] === u.sort)) UI.sort = u.sort;
  if (u.dir === 1 || u.dir === -1) UI.dir = u.dir;
  for (const k of ['onlyRec', 'safeOnly']) if (typeof u[k] === 'boolean') UI[k] = u[k];
  if (['', 'NEW', 'EARLY', 'ESTABLISHED', 'MATURE'].includes(u.age)) UI.age = u.age;
  if (isNum(u.maxRisk)) UI.maxRisk = clamp(u.maxRisk, 0, 100);
  if (isNum(u.minConf)) UI.minConf = clamp(u.minConf, 0, 100);
  if (DETAIL_TABS.some(d => d[0] === u.detailTab)) UI.detailTab = u.detailTab;
  if (['live', '1m', '5m', '15m'].includes(u.chartTf)) UI.chartTf = u.chartTf;
  if (LOG_CATS.some(c => c[0] === u.logCat)) UI.logCat = u.logCat;
  if (['opportunity', 'risk', 'confidence', 'execution'].includes(u.rankBy)) UI.rankBy = u.rankBy;
  if (isNum(u.alertsSeenAt)) UI.alertsSeenAt = u.alertsSeenAt;
}
function spark(t, w = 60, h = 20) {
  const v = t.hist.slice(-90).map(x => x.p); if (v.length < 2) return '';
  const step = Math.max(1, Math.floor(v.length / 30)); const s = v.filter((_, i) => i % step === 0 || i === v.length - 1);
  const lo = Math.min(...s), hi = Math.max(...s), d = hi - lo || hi || 1;
  const pts = s.map((y, i) => (i * w / (s.length - 1)).toFixed(1) + ',' + (h - 2 - (y - lo) / d * (h - 4)).toFixed(1)).join(' ');
  return raw(`<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="${s[s.length - 1] >= s[0] ? '#22e58f' : '#ff5470'}" stroke-width="1.6" points="${pts}"/></svg>`);
}
function tokenLinks(t) {
  const pair = (t.A && t.A.core.pairAddress) || (t.snap && t.snap.pairAddress) || null;
  const L = [['DexScreener', LINKS.dexscreener(pair, t.mint)], ['RugCheck', LINKS.rugcheck(t.mint)], ['Solscan', LINKS.solscanToken(t.mint)]];
  if (pair) L.push(['Axiom', LINKS.axiom(pair)], ['GeckoTerminal', LINKS.gecko(pair)], ['Pool (Solscan)', LINKS.solscanAccount(pair)]);
  L.push(['Birdeye', LINKS.birdeye(t.mint)], ['X-Suche', LINKS.xsearch(t.mint)]);
  for (const l of t.meta.links.slice(0, 6)) {
    let host = ''; try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch (e) { continue; }
    const name = l.type === 'twitter' || host === 'x.com' || host === 'twitter.com' ? '𝕏 ' + host : l.type === 'telegram' || host === 't.me' ? '✈ Telegram' : l.type === 'discord' ? 'Discord' : '🌐 ' + host;
    L.push([name, l.url]);
  }
  return L.filter(x => safeUrl(x[1]));
}
const linkHtml = L => html`${L.map(([n, u]) => html`<a href="${u}" target="_blank" rel="noopener noreferrer">${n}</a>`)}`;

/* ---------- Toasts ---------- */
function toast(level, msg, sub) {
  const box = $('toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (['SUCCESS', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(level) ? level : 'INFO');
  el.setAttribute('role', level === 'ERROR' || level === 'CRITICAL' ? 'alert' : 'status');
  setHTML(el, html`${msg}${sub ? html`<small>${sub}</small>` : ''}`);
  el.addEventListener('click', () => el.remove(), { once: true });
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), level === 'ERROR' || level === 'CRITICAL' ? 7000 : 3800);
}

/* ---------- Sound / Vibration / Browser-Benachrichtigungen (ohne Endlosschleifen) ---------- */
let audioCtx = null, lastBeep = 0;
function unlockAudio() {
  if (!audioCtx) { try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); } catch (e) { audioCtx = null; } }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
function beep(level) {
  if (!core.S().sound || !audioCtx || Date.now() - lastBeep < 2500) return;
  lastBeep = Date.now();
  try { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = level === 'CRITICAL' || level === 'ERROR' ? 440 : 880; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.15); } catch (e) { /* Audio nicht verfügbar */ }
}
function showNotification(title, body) {
  if (!core.S().notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const f = () => { try { new Notification(title, { body }); } catch (e) { /* nicht unterstützt */ } };
  if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) navigator.serviceWorker.getRegistration().then(r => (r ? r.showNotification(title, { body }) : f())).catch(f); else f();
}
function updateNotifyBtn() {
  const b = $('btnNotify'); if (!b) return;
  if (!('Notification' in window)) setText(b, '🔕 nicht unterstützt');
  else setText(b, Notification.permission === 'granted' ? '🔔 Alarme aktiv' : Notification.permission === 'denied' ? '🔕 blockiert' : '🔔 Alarme an');
}
const NOTIFY_TYPES = new Set(['BUY_CANDIDATE', 'X2', 'TP_HIT', 'STOP_HIT', 'RISK', 'SYSTEM', 'WATCH', 'TRADE', 'SECURITY', 'API_FAIL', 'RPC_FAIL']);
core.on('alert', e => {
  if (NOTIFY_TYPES.has(e.type) || e.level === 'CRITICAL') {
    toast(e.level, e.tag + (e.sym ? ' · ' + e.sym : ''), e.detail);
    beep(e.level);
    const activated = navigator.userActivation ? navigator.userActivation.hasBeenActive : UI.lastTouch > 0;
    if (core.S().vibrate && navigator.vibrate && activated) { try { navigator.vibrate(e.level === 'CRITICAL' ? [300, 100, 300] : [150, 80, 150]); } catch (x) { /* */ } }
    showNotification(e.tag, (e.sym ? e.sym + ' · ' : '') + e.detail);
  }
  scheduleRender();
});

/* ---------- Kopieren (mit manuellem Fallback) ---------- */
function copyText(text, label) {
  if (!text) return;
  const ok = () => toast('SUCCESS', (label || 'Kopiert') + ' ✓', text.length > 20 ? shortAddr(text) : text);
  const manual = () => openModal({ title: 'Manuell kopieren', body: html`<input id="copyManual" readonly value="${text}" aria-label="Zu kopierender Text"><p class="note">Automatisches Kopieren wird hier blockiert. Tippe ins Feld, wähle „Alles auswählen“ und dann „Kopieren“.</p>`, onOpen: () => { const i = document.getElementById('copyManual'); if (i) { i.focus(); i.select(); try { i.setSelectionRange(0, text.length); } catch (e) { /* */ } } } });
  let done = false;
  try {
    const e = document.createElement('textarea'); e.value = text; e.readOnly = true; e.style.cssText = 'position:fixed;top:0;left:0;font-size:16px;opacity:0';
    document.body.appendChild(e); e.focus(); e.select(); e.setSelectionRange(0, text.length); done = document.execCommand('copy'); e.remove();
  } catch (x) { done = false; }
  if (done) return ok();
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, manual); else manual();
}
function download(name, mime, data) {
  const blob = new Blob([data], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

/* ---------- Modal & Bestätigungen ---------- */
let modalState = null;
function openModal({ title, body, actions, onOpen, collect }) {
  closeModal(null);
  const m = $('modal');
  setText($('modalTitle'), title);
  setHTML($('modalBody'), body);
  const acts = actions || [{ id: 'close', label: 'Schließen' }];
  setHTML($('modalActions'), html`${acts.map(a => html`<button class="btn ${a.cls || ''}" data-modal="${a.id}" ${a.disabled ? raw('disabled') : ''} id="${'mb-' + a.id}">${a.label}</button>`)}`);
  m.hidden = false;
  const ret = document.activeElement;
  return new Promise(res => {
    modalState = { res, collect, ret };
    setTimeout(() => { const f = m.querySelector('input:not([readonly]),select,button:not([disabled])'); if (f) f.focus(); if (onOpen) onOpen(); }, 30);
  });
}
function closeModal(id) {
  const m = document.getElementById('modal'); const st = modalState; modalState = null;
  let data = null; if (st && st.collect && id) { try { data = st.collect(); } catch (e) { data = null; } }
  if (m && !m.hidden) { m.hidden = true; setHTML(document.getElementById('modalBody'), ''); }
  if (st) { st.res({ id, data }); if (st.ret && st.ret.focus && document.body.contains(st.ret)) { try { st.ret.focus(); } catch (e) { /* */ } } }
}
async function confirmDialog(title, text, o = {}) {
  const r = await openModal({
    title, body: html`<p>${text}</p>${o.extra || ''}${o.requireText ? html`<p class="note">Zur Bestätigung „${o.requireText}“ eingeben:</p><input id="confirmText" autocomplete="off" aria-label="Bestätigungstext">` : ''}`,
    actions: [{ id: 'cancel', label: 'Abbrechen' }, { id: 'ok', label: o.confirmLabel || 'Bestätigen', cls: o.danger ? 'bad' : 'pri' }],
    collect: () => (document.getElementById('confirmText') || {}).value
  });
  if (r.id !== 'ok') return false;
  if (o.requireText && (r.data || '').trim() !== o.requireText) { toast('WARNING', 'Abgebrochen', 'Bestätigungstext stimmt nicht'); return false; }
  return true;
}

/* ---------- Navigation ---------- */
const VIEWS = [
  ['scanner', '📡', 'Scanner'], ['signals', '⚡', 'Signale'], ['markets', '🌐', 'Markt'], ['watchlist', '👁', 'Watchlist'], ['positions', '💼', 'Positionen'],
  ['orders', '🧾', 'Orders'], ['history', '📜', 'History'], ['backtest', '🧪', 'Backtest'], ['analytics', '📊', 'Analytics'], ['risk', '🛡', 'Risiko'],
  ['alerts', '💬', 'Alarm-Chat'], ['diagnostics', '🩺', 'Diagnose'], ['system', '🖥', 'System & API'], ['logs', '📋', 'Logs'], ['settings', '⚙', 'Einstellungen'], ['knowledge', '📚', 'Wissen']
];
const NAV_GROUPS = [['Trading', ['scanner', 'signals', 'positions', 'watchlist', 'orders', 'history', 'markets']], ['Analyse', ['analytics', 'risk', 'backtest', 'alerts']], ['System & Diagnose', ['diagnostics', 'system', 'logs', 'settings', 'knowledge']]];
const BOTTOM = [['scanner', '📡', 'Scanner'], ['signals', '⚡', 'Signale'], ['positions', '💼', 'Positionen'], ['alerts', '💬', 'Alarme'], ['more', '☰', 'Mehr']];
function buildNav() {
  setHTML($('sidebar'), html`${VIEWS.map(([id, ic, name]) => html`<button data-act="view" data-view="${id}" id="nv-${id}" aria-label="${name}"><i aria-hidden="true">${ic}</i><span>${name}</span><span class="cnt" id="nc-${id}"></span></button>`)}
    <div class="sidefoot" id="sideFoot"></div>`);
  setHTML($('bottomnav'), html`${BOTTOM.map(([id, ic, name]) => html`<button data-act="${id === 'more' ? 'more' : 'view'}" data-view="${id}" id="bn-${id}" aria-label="${name}"><i aria-hidden="true">${ic}</i>${name}<span class="bdg" id="bd-${id}"></span></button>`)}`);
}
function showView(v, focus) {
  if (!VIEWS.some(x => x[0] === v)) return;
  UI.view = v; saveUi();
  document.body.classList.toggle('v-home', v === 'scanner');
  for (const [id] of VIEWS) { const s = document.getElementById('v-' + id); if (s) s.classList.toggle('hidden', id !== v); }
  renderNav();
  renderView(true);
  if (v === 'alerts') { UI.alertsSeenAt = Date.now(); saveUi(); }
  if (focus) { const c = document.getElementById('center'); if (c) { c.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'auto' }); } }
}
function renderNav() {
  const st = core.state, ss = st.metrics.scanStats || {};
  for (const [id] of VIEWS) { const b = document.getElementById('nv-' + id); if (b) { b.classList.toggle('on', id === UI.view); b.setAttribute('aria-current', id === UI.view ? 'page' : 'false'); } }
  for (const [id] of BOTTOM) { const b = document.getElementById('bn-' + id); if (b) b.classList.toggle('on', id === UI.view || (id === 'more' && !BOTTOM.some(x => x[0] === UI.view))); }
  const counts = { scanner: st.markets.size, signals: ss.candidates || 0, watchlist: Object.keys(st.watchlist).length, positions: st.positions.length, orders: st.orders.filter(o => !TERMINAL.has(o.state)).length || '', alerts: st.feed.length || '' };
  for (const [id, n] of Object.entries(counts)) setText(document.getElementById('nc-' + id), n === 0 ? '0' : n);
  const unread = st.feed.filter(e => e.ts > UI.alertsSeenAt).length;
  setText(document.getElementById('bd-signals'), ss.candidates ? String(ss.candidates) : '');
  setText(document.getElementById('bd-positions'), st.positions.length ? String(st.positions.length) : '');
  setText(document.getElementById('bd-alerts'), unread && UI.view !== 'alerts' ? (unread > 99 ? '99+' : String(unread)) : '');
  const rd = core.readiness();
  setText(document.getElementById('bd-more'), rd.state === 'BLOCKED' || rd.state === 'ERROR' || core.state.reconciliation.required ? '!' : '');
  setText(document.getElementById('sideFoot'), `Smart Lab v${APP_VERSION} · Strategy ${STRATEGY_VERSION} · Data ${DATA_ENGINE_VERSION}`);
}

/* ---------- Top Bar, Banner, Control Panel, Tiles ---------- */
const MS_TEXT = { READY: 'BOT READY', WAITING: 'BOT WAITING', BLOCKED: 'BOT BLOCKED', ERROR: 'BOT ERROR', EMERGENCY_STOP: 'EMERGENCY STOP', PAUSED: 'BOT PAUSED', STOPPED: 'BOT STOPPED' };
const MS_CLS = { READY: 'ok', WAITING: 'info', BLOCKED: 'warn', ERROR: 'bad', EMERGENCY_STOP: 'bad', PAUSED: 'warn', STOPPED: 'warn' };
function masterStatus() {
  const rd = core.readiness();
  /* Verlustserie/Loss-Cooldown ist eine gewollte, selbstauflösende Schutzpause – nicht dieselbe Kategorie
     wie z.B. SAFE_MODE oder SYSTEM_UNHEALTHY. Anzeige wird ehrlicher/ruhiger, die Sperre selbst bleibt unverändert. */
  if (rd.state === 'BLOCKED' && rd.hard.length && rd.hard.every(x => x.code === 'GLOBAL_PAUSE' || x.code === 'LOSS_COOLDOWN')) {
    const r = core.state.risk, now = Date.now(), until = Math.max(r.globalPauseUntil || 0, r.lossCooldownUntil || 0);
    const label = rd.hard.some(x => x.code === 'GLOBAL_PAUSE') ? 'PAUSIERT · Verlustserie' : 'PAUSIERT · Loss-Cooldown';
    return { state: rd.state, cls: 'pause', text: label + (until > now ? ` (noch ${fmtAge(until - now)})` : ''), why: rd.reason, rd };
  }
  return { state: rd.state, cls: MS_CLS[rd.state] || '', text: MS_TEXT[rd.state] || rd.state, why: rd.reason, rd };
}
const RANKS = { ONLINE: 0, UNKNOWN: 1, DEGRADED: 2, STALE: 3, OFFLINE: 4 };
function bestRpcStatus() { const s = core.rpcEndpoints().map(e => core.http.status(e.name)); return s.length ? s.sort((a, b) => RANKS[a] - RANKS[b])[0] : 'OFFLINE'; }
function renderTop() {
  const st = core.state, b = st.bot, S = core.S(), h = core.systemHealth(), now = Date.now();
  const ms = masterStatus();
  const unreal = st.positions.reduce((a, p) => a + (isNum(p.pnlUsd) ? p.pnlUsd : 0), 0);
  const unknown = st.positions.some(p => !isNum(p.pnlUsd));
  const pnl = st.portfolio.realized + unreal;
  const pr = core.portfolioRisk(); const rpc = bestRpcStatus(); const w = st.wallet;
  const pills = [
    [ms.cls + ' pm', '', ms.text, ms.why],
    ['info pm', 'Modus', st.mode.replace('_', ' '), 'Handelsmodus · LIVE separat & nur mit erfülltem Gating'],
    [b.autoTrading ? 'ok' : '', 'Auto', b.autoTrading ? 'AN' : 'AUS', 'Auto-Trading (nur SIMULATION, nie Echtgeld)'],
    [(w.status === 'CONNECTED' ? 'ok' : '') + ' pm', 'Wallet', w.status === 'CONNECTED' ? shortAddr(w.pubkey) : w.status === 'NO_PROVIDER' ? 'kein Provider' : w.status === 'ERROR' ? 'Fehler' : 'nicht verbunden', 'nur lesend, keine Signaturen'],
    [stCls(rpc), 'RPC', rpc + (st.rpc.latency != null && rpc === 'ONLINE' ? ' ' + st.rpc.latency + 'ms' : ''), st.rpc.slot ? 'Slot ' + st.rpc.slot + ' · ' + (st.rpc.endpoint || '') : 'kein verifizierter Slot'],
    [h.score >= 80 ? 'ok' : h.score >= S.minSystemHealth ? 'warn' : 'bad', 'Health', String(h.score), 'System Health 0–100 (APIs, RPC, Frische, Fehler)'],
    [(pnl > 0.005 ? 'ok' : pnl < -0.005 ? 'bad' : '') + ' pm', 'PnL', fmtSigned(pnl) + (unknown ? '*' : ''), 'SIMULIERT · fee-adjusted' + (unknown ? ' · * Position ohne aktuellen Preis' : '')],
    ['', 'Pos', `${st.positions.length}/${S.maxOpenPositions}`, 'offene Positionen'],
    [pr.score >= 60 ? 'bad' : pr.score >= 35 ? 'warn' : 'ok', 'Risk', String(pr.score), 'Portfolio Risk'],
    ['', '', `${fmtTime(now)} · Scan ${st.scanner.lastAt ? fmtAge(now - st.scanner.lastAt) : '—'}`, 'Uhrzeit · letzter Scan']
  ];
  patch($('tbPills'), html`${pills.map(p => html`<span class="pill ${p[0]}" title="${p[3] || ''}">${p[1] ? p[1] + ' ' : ''}<b>${p[2]}</b></span>`)}`);
  const e = $('btnEstop');
  if (e) { e.classList.toggle('on', b.emergency); setText(e, b.emergency ? '⛔ E-STOP AKTIV · freigeben' : '⛔ EMERGENCY STOP'); e.setAttribute('aria-pressed', b.emergency ? 'true' : 'false'); }
  const ver = $('verBanner'); if (ver) { setText(ver, 'v' + APP_VERSION); ver.title = `App ${APP_VERSION} · Strategy ${STRATEGY_VERSION} · Data Engine ${DATA_ENGINE_VERSION} · Parameter v${st.activeParam}`; }
  renderBanner();
}
function renderBanner() {
  const st = core.state, b = st.bot, now = Date.now(), msgs = [];
  let bad = false;
  if (b.emergency) { msgs.push(`⛔ EMERGENCY STOP aktiv (${b.emergencyReason}) – neue Käufe blockiert. Positionen: ${core.S().estopPositionRule === 'close' ? 'werden geschlossen' : 'werden gehalten & überwacht'}.`); bad = true; }
  if (!navigator.onLine) { msgs.push('📴 OFFLINE – Anzeige möglich, Trading deaktiviert.'); bad = true; }
  const fresh = [...st.markets.values()].some(t => t.snap && now - t.snap.fetchedAt < core.S().staleAfterSec * SEC);
  if (st.scanner.running && !fresh && st.scanner.id > 2) {
    const err = core.http.snapshot('dexPairs');
    msgs.push(`DATA UNAVAILABLE – keine frischen Live-Daten (${(err && err.lastError) || 'keine Antwort'}). Öffne die App im Browser (Safari/Chrome) über deinen Hoster, nicht in einer eingebetteten Vorschau. Es werden nie Fake-Daten angezeigt.`);
    bad = true;
  }
  if (b.state === 'STOPPED' && st.positions.length) msgs.push(`■ Bot gestoppt – ${st.positions.length} offene Position(en) werden NICHT überwacht.`);
  if (b.safeMode) msgs.push('🛡 Safe Mode aktiv – Analyse läuft, keine neuen Käufe.' + (b.safeAuto ? ' Automatisch nach Fehlern aktiviert; nach Prüfung in der Steuerung deaktivieren.' : ''));
  if (st.risk.reviewRequired) msgs.push(`⚠️ Verlustserie (${st.risk.lossStreak}) – kontrollierter Review empfohlen (Analytics/History). Hinweis in Risiko-Ansicht bestätigen.`);
  if (st.reconciliation.required) { msgs.push(html`⚖️ RECONCILIATION REQUIRED – ${st.reconciliation.issues.length} ungeklärte Punkt(e) nach Neustart. Neue Käufe sind blockiert, bis du den Abgleich prüfst. <button class="btn sm warn" data-act="reconcile">Abgleich prüfen</button>`); bad = true; }
  if (!st.storageOk) msgs.push('💾 Speichern fehlgeschlagen – Zustand wird nicht dauerhaft gesichert (privater Modus/Speicher voll?).');
  const el = $('banner'); if (!el) return;
  el.hidden = !msgs.length; el.classList.toggle('bad', bad);
  patch(el, html`${msgs.map(m => html`<div>${m}</div>`)}`);
}
function buildControl() {
  const mobile = window.matchMedia('(max-width:700px)').matches;
  setHTML($('control'), html`
    <div class="ctl-top"><span class="mstat" id="cStatus" role="status">–</span><div class="ctl-why" id="cWhy" aria-live="polite"></div></div>
    <div class="ov" id="cOverview"></div>
    <details class="ctl-more" id="cCtlBox" ${mobile ? '' : raw('open')}><summary>Steuerung: Start · Pause · Stop · Safe Mode · Modus</summary>
    <div class="ctl-row">
      <button class="btn ok" data-act="start" id="cStart">▶ START</button>
      <button class="btn warn" data-act="pause" id="cPause">⏸ PAUSE</button>
      <button class="btn bad" data-act="stop" id="cStop">■ STOP</button>
      <button class="btn" data-act="safe" id="cSafe" aria-pressed="false">🛡 SAFE MODE</button>
      <div class="seg" role="group" aria-label="Handelsmodus">
        <button data-act="mode" data-mode="SIMULATION" id="mSIMULATION">SIMULATION</button>
        <button data-act="mode" data-mode="PAPER" id="mPAPER">PAPER</button>
        <button data-act="mode" data-mode="READ_ONLY" id="mREAD_ONLY">READ ONLY</button>
        <button data-act="live" class="na" id="mLIVE" title="Nur mit erfülltem Live-Gating – derzeit nicht verfügbar">LIVE</button>
      </div>
    </div></details>`);
}
function renderControl() {
  const b = core.state.bot, st = core.state;
  const s = $('cStart'), p = $('cPause'), x = $('cStop'), sf = $('cSafe');
  if (!s) return;
  s.disabled = b.emergency || b.state === 'RUNNING' || b.state === 'RECOVERING' || b.state === 'STARTING';
  p.disabled = !['RUNNING', 'RECOVERING'].includes(b.state);
  x.disabled = b.state === 'STOPPED';
  sf.classList.toggle('on', b.safeMode); sf.setAttribute('aria-pressed', String(b.safeMode));
  for (const m of ['SIMULATION', 'PAPER', 'READ_ONLY']) { const el = $('m' + m); if (el) { el.classList.toggle('on', st.mode === m); el.setAttribute('aria-pressed', String(st.mode === m)); } }
  const ms = masterStatus(), cs = $('cStatus');
  if (cs) { cs.className = 'mstat ' + ms.state; setText(cs, ms.text); }
  const soft = ms.rd.soft.filter(x2 => !['AUTO_TRADING_OFF', 'PAPER_MANUAL', 'BOT_NOT_RUNNING', 'RECOVERING'].includes(x2.code));
  patch($('cWhy'), html`${ms.why}${soft.length ? html` <span class="dim">· Hinweis: ${soft.map(x2 => x2.msg).join(' · ')}</span>` : ''}`);
  const eq = core.equityInfo(), w = st.wallet;
  const unreal = st.positions.reduce((a, q) => a + (isNum(q.pnlUsd) ? q.pnlUsd : 0), 0), pnl = st.portfolio.realized + unreal;
  const walletTxt = w.status === 'CONNECTED' ? shortAddr(w.pubkey) : w.status === 'NO_PROVIDER' ? 'kein Provider' : w.status === 'CONNECTING' ? 'verbinde …' : w.status === 'ERROR' ? 'Fehler' : 'nicht verbunden';
  patch($('cOverview'), html`
    <div class="kv"><small>Modus</small><b>${st.mode.replace('_', ' ')}</b></div>
    <button class="kv" data-act="auto" role="switch" aria-checked="${b.autoTrading}" title="Auto-Trading – nur SIMULATION, nie Echtgeld"><small>Auto-Trading</small><span class="switch ${b.autoTrading ? 'on' : ''}"><span class="tg"></span>${b.autoTrading ? 'AN' : 'AUS'}</span></button>
    <button class="kv" data-act="walletModal"><small>Wallet (lesend)</small><b>${walletTxt}${w.balanceLamports != null ? ' · ' + Number(lamportsToSol(BigInt(w.balanceLamports))).toFixed(3) + ' SOL' : ''}</b></button>
    <div class="kv"><small>Portfolio</small><b>${fmtUsd(eq.equity)}<em class="lbl SIMULATED">SIM</em></b></div>
    <div class="kv"><small>PnL (fee-adj.)</small><b class="${cls(pnl)}">${fmtSigned(pnl)}</b></div>
    <button class="kv" data-act="view" data-view="positions"><small>Positionen</small><b>${st.positions.length}/${core.S().maxOpenPositions} · ${fmtUsd(eq.exposure)}</b></button>`);
}
const TILE_ICONS = {
  t1: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/></svg>',
  t2: '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  t3: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  t4: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 004 0"/></svg>'
};
function buildTiles() {
  setHTML($('tiles'), html`
    <button class="tile t1" data-act="view" data-view="scanner" id="tl-scanner"><span class="tb" id="tb1">–</span>${raw(TILE_ICONS.t1)}<div><b>Scanner</b><small id="k1">–</small><i class="tn" id="kn1"></i></div></button>
    <button class="tile t2" data-act="view" data-view="signals" id="tl-signals"><span class="tb" id="tb2">–</span>${raw(TILE_ICONS.t2)}<div><b>Signale</b><small id="k2">–</small><i class="tn" id="kn2"></i></div></button>
    <button class="tile t3" data-act="view" data-view="watchlist" id="tl-watchlist"><span class="tb">LOKAL</span>${raw(TILE_ICONS.t3)}<div><b>Watchlist</b><small id="k3">–</small><i class="tn" id="kn3"></i></div></button>
    <button class="tile t4" data-act="view" data-view="alerts" id="tl-alerts"><span class="tb" id="tb4">–</span>${raw(TILE_ICONS.t4)}<div><b>Alarm-Chat</b><small id="k4">–</small><i class="tn" id="kn4"></i><div class="bb"><i id="kbar"></i></div></div></button>`);
}
function renderTiles() {
  const st = core.state, ss = st.metrics.scanStats || {}, dex = core.http.status('dexPairs');
  const liveLbl = dex === 'ONLINE' ? 'LIVE' : dex === 'UNKNOWN' ? 'START' : dex;
  for (const id of ['tb1', 'tb2', 'tb4']) setText($(id), liveLbl);
  const toks = [...st.markets.values()].filter(t => t.A);
  setText($('k1'), `${toks.length} Tokens · ${toks.filter(t => t.A.finalScore >= core.S().minScore).length} Empfehlungen`);
  setText($('k2'), `${ss.candidates || 0} Kandidaten · ${ss.withSignals || 0} mit Signal`);
  const top = toks.length ? Math.max(...toks.map(t => t.A.finalScore)) : 0;
  setText($('k3'), `${Object.keys(st.watchlist).length} ★ · Top ${top}`);
  let tb = 0, tsl = 0; for (const t of toks) { if (isNum(t.A.tx.b1)) tb += t.A.tx.b1; if (isNum(t.A.tx.s1)) tsl += t.A.tx.s1; }
  const br = tb + tsl ? tb / (tb + tsl) * 100 : null;
  setText($('k4'), br == null ? 'Käufer — (keine Daten)' : `Käufer ${br.toFixed(0)} % (1h)`);
  const kb = $('kbar'); if (kb) kb.style.width = (br == null ? 50 : br) + '%';
  setText($('kn1'), String(toks.length)); setText($('kn2'), String(ss.candidates || 0)); setText($('kn3'), Object.keys(st.watchlist).length + ' ★'); setText($('kn4'), br == null ? '—' : br.toFixed(0) + '%');
  for (const [v, id] of [['scanner', 'tl-scanner'], ['signals', 'tl-signals'], ['watchlist', 'tl-watchlist'], ['alerts', 'tl-alerts']]) { const el = document.getElementById(id); if (el) el.classList.toggle('on', UI.view === v); }
}

/* ---------- Scanner-Ansicht (Live Market Table, keyed Rows) ---------- */
const SORTS = [['score', 'Score', t => t.A.finalScore], ['mom', '5m 🚀', t => t.A.price.chg.m5], ['chg', '1h %', t => t.A.price.chg.h1], ['vol', 'Volumen', t => t.A.vol.h1], ['liq', 'Liquidität', t => t.A.liq.usd], ['momentum', 'Momentum', t => t.A.price.momentum], ['risk', 'Risiko', t => t.A.risk.total], ['conf', 'Confidence', t => t.A.confidence.total], ['opp', 'Opportunity', t => t.A.opportunity], ['age', 'Neu', t => t.A.core.pairAge]];
const HEAD = [['', null], ['Token', null], ['Preis', null, 'r'], ['5m', 'mom', 'r'], ['1h', 'chg', 'r'], ['Liq', 'liq', 'r'], ['Vol 1h', 'vol', 'r c-vol'], ['K/V 1h', null, 'r c-bs'], ['Mom.', 'momentum', 'r c-mom'], ['Risk', 'risk'], ['Conf', 'conf', 'r'], ['Score', 'score'], ['Status', null], ['Trend', null, 'c-spark'], ['', null]];
function passesFilter(t, q, S) {
  const A = t.A, D = t.D;
  if (q && !(t.symbol.toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q) || t.mint.toLowerCase().includes(q))) return false;
  if (UI.onlyRec && !(A.finalScore >= S.minScore || D.decision === 'APPROVED' || D.decision === 'BUY_CANDIDATE')) return false;
  if (UI.safeOnly && (['HIGH', 'CRITICAL', 'UNKNOWN'].includes(A.risk.level) || A.flags.some(f => ['DÜNNE LIQ', 'VERKÄUFER', 'DUMP', 'PUMP'].includes(f)))) return false;
  if (UI.age && A.ageClass !== UI.age) return false;
  if (A.risk.total > UI.maxRisk) return false;
  if (A.confidence.total < UI.minConf) return false;
  return true;
}
function rowHtml(t) {
  const A = t.A, D = t.D, c = A.price.chg, w = !!core.state.watchlist[t.id];
  return html`<button class="star ${w ? 'on' : ''}" data-act="star" data-id="${t.id}" aria-label="${w ? 'Von Watchlist entfernen' : 'Zur Watchlist hinzufügen'}">${w ? '★' : '☆'}</button>
<div class="tok"><b>${t.symbol}</b><small>${t.name}</small><span class="flags">${A.flags.map(f => html`<span class="f ${f === 'BOOST' ? 'B' : f === 'PUMP' || f === 'DUMP' ? 'X' : ''}">${f}</span>`)}</span>${A.label !== 'LIVE' ? html` ${lbl(A.label)}` : ''}</div>
<div class="cell num r" title="${A.core.priceRaw || ''}">${fmtPrice(A.core.price)}</div>
<div class="cell num r ${cls(c.m5)}">${fmtPct(c.m5, 0)}</div>
<div class="cell num r ${cls(c.h1)}">${fmtPct(c.h1, 0)}</div>
<div class="cell num r">${fmtUsd(A.liq.usd)}</div>
<div class="cell num r c-vol">${fmtUsd(A.vol.h1)}</div>
<div class="cell num r c-bs">${A.tx.b1 != null ? A.tx.b1 : '—'}/${A.tx.s1 != null ? A.tx.s1 : '—'}</div>
<div class="cell num r c-mom">${A.price.momentum}</div>
<div class="cell">${lvlChip(A.risk.level, A.risk.total)}</div>
<div class="cell num r">${A.confidence.total}%</div>
<div class="c-score">${scoreChip(A.finalScore)}</div>
<div class="c-status">${decChip(D.decision)}</div>
<div class="cell c-spark">${spark(t)}</div>
<button class="more" data-act="ctx" data-id="${t.id}" aria-label="Aktionen für ${t.symbol}">⋯</button>
<div class="cal"><div><small>Preis</small>${fmtPrice(A.core.price)}</div><div class="${cls(c.m5)}"><small>5m</small>${fmtPct(c.m5, 0)}</div><div class="${cls(c.h1)}"><small>1h</small>${fmtPct(c.h1, 0)}</div><div><small>Liq</small>${fmtUsd(A.liq.usd)}</div><div><small>Vol 1h</small>${fmtUsd(A.vol.h1)}</div><div><small>MCap</small>${fmtUsd(A.core.mc)}</div><div><small>Risk</small>${A.risk.level === 'UNKNOWN' ? '?' : A.risk.total}</div><div><small>Käufer</small>${A.tx.ratio1 != null ? (A.tx.ratio1 * 100).toFixed(0) + '%' : '—'}</div></div>
<button class="ca" data-act="copy" data-v="${t.mint}" data-l="Mint" aria-label="Mint-Adresse kopieren"><code>${t.mint}</code><span>⧉ kopieren</span></button>`;
}
function hotCard(t) {
  return html`<div class="hc" data-act="select" data-id="${t.id}" role="button" tabindex="0"><small>🔥 Top Score · ${DEC_LABEL[t.D.decision]}</small><br><b>${t.symbol}</b> ${scoreChip(t.A.finalScore)}<br><small>${fmtUsd(t.A.core.mc)} · 5m ${fmtPct(t.A.price.chg.m5, 0)} · ${t.A.risk.level}</small><br>${spark(t, 110, 22)}</div>`;
}
function renderScanner() {
  const st = core.state, S = core.S(), now = Date.now();
  patch($('sortChips'), html`${SORTS.map(([k, n]) => html`<button data-act="sort" data-k="${k}" class="${k === UI.sort ? 'on' : ''}" aria-pressed="${k === UI.sort}">${n}${k === UI.sort ? (UI.dir < 0 ? ' ▼' : ' ▲') : ''}</button>`)}`);
  patch($('mkHead'), html`${HEAD.map(([n, k, c]) => (k ? html`<button class="${(c || '') + (UI.sort === k ? ' on' : '')}" data-act="sort" data-k="${k}">${n}${UI.sort === k ? (UI.dir < 0 ? ' ▼' : ' ▲') : ''}</button>` : html`<span class="${c || ''}">${n}</span>`))}`);
  for (const [id, v] of [['swRec', UI.onlyRec], ['swSafe', UI.safeOnly]]) { const el = document.getElementById(id); if (el) { el.classList.toggle('on', v); el.setAttribute('aria-checked', String(v)); } }
  const all = [...st.markets.values()].filter(t => t.A && t.D);
  const q = UI.q.trim().toLowerCase();
  const getter = (SORTS.find(s => s[0] === UI.sort) || SORTS[0])[2];
  const list = all.filter(t => passesFilter(t, q, S)).sort((a, b) => {
    const x = getter(a), y = getter(b);
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * UI.dir;
  }).slice(0, 150);
  const hot = all.filter(t => t.D.decision !== 'REJECTED').sort((a, b) => b.A.finalScore - a.A.finalScore).slice(0, 3);
  patch($('hot'), html`${hot.map(hotCard)}`);
  const dex = core.http.snapshot('dexPairs');
  patch($('mkInfo'), html`${all.length} gescannt · ${list.length} angezeigt · sortiert nach ${(SORTS.find(s => s[0] === UI.sort) || SORTS[0])[1]} · DexScreener ${dex ? dex.status : '—'}${dex && dex.latency ? ' · ' + Math.round(dex.latency) + ' ms' : ''} · ${core.state.regime.tags.join(' · ')}`);
  const box = $('mkList'); if (!box) return;
  if (!box._rows) box._rows = new Map();
  const rows = box._rows, keep = new Set();
  if (!list.length) {
    for (const el of rows.values()) el.remove(); rows.clear();
    const msg = !st.markets.size ? (st.scanner.running ? 'Warte auf Live-Daten … (keine Demo- oder Fake-Daten)' : 'Scanner gestoppt – START drücken.') : all.length ? 'Keine Tokens passen zu Suche/Filter. Das ist normal, wenn die Filter streng sind.' : 'Tokens entdeckt, warte auf Marktdaten …';
    patch(box, html`<div class="empty">${msg}</div>`);
    return;
  }
  if (box._sig) { box.innerHTML = ''; box._sig = null; }
  list.forEach((t, i) => {
    let el = rows.get(t.id);
    if (!el) { el = document.createElement('div'); el.dataset.id = t.id; el.setAttribute('role', 'row'); el.tabIndex = 0; rows.set(t.id, el); }
    keep.add(t.id);
    const c = 'mrow' + (t.D.decision === 'APPROVED' || t.D.decision === 'BUY_CANDIDATE' ? ' hit' : '') + (t.id === st.selected ? ' sel' : '') + (now - t.meta.discoveredAt < 6000 ? ' nw' : '');
    if (el.className !== c) el.className = c;
    patch(el, rowHtml(t));
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
  for (const [id, el] of rows) if (!keep.has(id)) { el.remove(); rows.delete(id); }
}
function renderFilterForm() {
  const S = core.S();
  const f = [['minLiq', 'Min. Liquidität $'], ['minVol1h', 'Min. Vol 1h $'], ['minMcap', 'Min. MCap $'], ['maxMcap', 'Max. MCap $'], ['minBuyRatio', 'Min. Käuferanteil (0–1)'], ['minScore', 'Min. Final Score']];
  patch($('filterForm'), html`<div class="row" style="margin-bottom:10px"><b class="mut">Profil:</b>${Object.keys(PROFILES).map(p => html`<button class="btn sm" data-act="profile" data-p="${p}">${p}</button>`)}</div>
    <div class="form">${f.map(([k, n]) => html`<label class="fld">${n}<input type="number" step="any" data-set="${k}" value="${S[k]}"></label>`)}
    <label class="fld">Ansicht: max. Risk Score<input type="number" min="0" max="100" data-ui="maxRisk" value="${UI.maxRisk}"></label>
    <label class="fld">Ansicht: min. Confidence<input type="number" min="0" max="100" data-ui="minConf" value="${UI.minConf}"></label></div>
    <p class="note">Filter- und Profilwerte gelten auch für die Kaufentscheidung (Decision Engine). „Ansicht“-Filter betreffen nur die Anzeige. Harte Sicherheitsgrenzen bleiben immer aktiv.</p>`);
}

/* Kandidaten-Kette: SECURITY PASS → LIQUIDITY PASS → SCORE TOO LOW → FINAL: NO TRADE */
function chainHtml(ch) {
  if (!ch) return '';
  return html`<div class="chain" aria-label="Entscheidungskette">${ch.steps.map(x => html`<span class="${x.ok ? 'p' : x.na ? 'n' : 'x'}" title="${x.value || ''}${x.msg ? ' · ' + x.msg : ''}">${x.k} ${x.ok ? 'PASS' : x.na ? '—' : x.code.replace(/_/g, ' ')}${x.value ? html` <small class="dim">${x.value}</small>` : ''}</span><i>→</i>`)}<span class="fin ${ch.decision === 'APPROVED' || ch.decision === 'BUY_CANDIDATE' ? 'buy' : ''}">FINAL: ${ch.final}</span></div>`;
}
/* ---------- Signale (Buy Candidates, Watch, Rejection Engine) ---------- */
function signalCard(t) {
  const A = t.A, D = t.D;
  const votes = (A.strat ? A.strat.votes : []).filter(v => v.vote === 'BUY' || v.strength > 0);
  return html`<div class="card ${D.decision === 'APPROVED' || D.decision === 'BUY_CANDIDATE' ? 'hit' : ''}">
    <div class="ch"><button class="star ${core.state.watchlist[t.id] ? 'on' : ''}" data-act="star" data-id="${t.id}" aria-label="Watchlist">${core.state.watchlist[t.id] ? '★' : '☆'}</button><b>${t.symbol}</b>${decChip(D.decision)}${scoreChip(A.finalScore)}<span class="ag">${fmtAge(A.core.pairAge)} · ${A.ageClass}</span></div>
    <div class="grid4" style="margin-top:8px">${kv('Opportunity', A.opportunity)}${kv('Risk', A.risk.total + ' ' + A.risk.level)}${kv('Confidence', A.confidence.total + '%')}${kv('Execution', A.executionScore)}</div>
    <div style="margin-top:8px">${A.signals.length ? A.signals.map(s => html`<span class="sig" title="${s.reason}">${SIGNAL_NAMES[s.type]} <i>${s.strength}</i></span>`) : html`<span class="mut">Keine Signale</span>`}</div>
    ${votes.length ? html`<div class="note">Strategien: ${votes.map(v => html`<span class="chip ${v.vote === 'BUY' ? 'ok' : ''} ${v.shadow ? 'vio' : ''}" title="${v.reasons.join('; ')}">${v.name}${v.shadow ? ' (Shadow)' : ''}: ${v.vote === 'BUY' ? 'BUY' : '—'} ${v.strength}</span> `)} · Konsens ${A.strat.weightSum}</div>` : ''}
    <div style="margin-top:6px">${D.blockers.slice(0, 5).map(b => html`<span class="blk p${b.prio}" title="${b.cat} · Priorität ${b.prio}">${b.code}</span>`)}</div>
    ${chainHtml(core.candidateChain(t))}
    <div class="note">${D.reason}</div>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-act="select" data-id="${t.id}">Details & Trace</button><button class="btn sm pri" data-act="buy" data-id="${t.id}">💱 Simulate Buy</button></div></div>`;
}
function renderSignals(sec) {
  const toks = [...core.state.markets.values()].filter(t => t.A && t.D);
  const cand = toks.filter(t => t.D.decision === 'APPROVED' || t.D.decision === 'BUY_CANDIDATE').sort((a, b) => b.A.finalScore - a.A.finalScore);
  const watch = toks.filter(t => t.D.decision === 'WATCH').sort((a, b) => b.A.finalScore - a.A.finalScore).slice(0, 12);
  const rr = Object.entries(core.state.metrics.rejectReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const pre = Object.entries(core.state.metrics.preTradeRejects || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const ms = masterStatus();
  patch(sec, html`<h2>⚡ Signale & Kandidaten</h2>
    <div class="panel tight"><div class="ctl-top"><span class="mstat ${ms.state}">${ms.text}</span><div class="ctl-why">${ms.why}</div></div></div>
    <p class="note">APPROVED = alle Prüfungen bestanden · CANDIDATE = Analyse positiv, Ausführung wartet (z. B. Auto-Trading aus) · WATCH = Filter & Security ok, aber kein Konsens/Score. Kein Kandidat ist kein Fehler (WAITING), sondern eine valide NO-TRADE-Entscheidung.</p>
    <h3>Buy Candidates (${cand.length})</h3>
    ${cand.length ? html`<div class="cards2">${cand.map(signalCard)}</div>` : html`<div class="empty">Keine validen Kandidaten. NO TRADE ist eine vollwertige Entscheidung.</div>`}
    <h3>Watch (${watch.length})</h3>
    ${watch.length ? html`<div class="cards2">${watch.map(signalCard)}</div>` : html`<div class="empty">Keine Tokens auf Watch-Level.</div>`}
    <div class="grid2" style="margin-top:12px"><div class="panel"><h3 style="margin-top:0">Häufigste Ablehnungsgründe (aktueller Scan)</h3>${rr.length ? html`<table class="tbl">${rr.map(([c, n]) => html`<tr><td><span class="blk">${c}</span></td><td class="mut">${(BLOCKER_DEFS[c] || [])[2] || ''}</td><td class="r num">${n}</td></tr>`)}</table>` : html`<div class="empty">—</div>`}</div>
    <div class="panel"><h3 style="margin-top:0">Pre-Trade-Ablehnungen (kumuliert)</h3>${pre.length ? html`<table class="tbl">${pre.map(([c, n]) => html`<tr><td><span class="blk">${c}</span></td><td class="r num">${n}</td></tr>`)}</table>` : html`<div class="empty">Noch keine</div>`}</div></div>`);
}

/* ---------- Markt: Regime & Ranking ---------- */
function renderMarkets(sec) {
  const st = core.state, rg = st.regime || { tags: [] };
  const toks = [...st.markets.values()].filter(t => t.A && t.D && t.D.decision !== 'REJECTED' || (t.A && t.A.finalScore >= 40));
  const key = { opportunity: t => t.A.opportunity, risk: t => -t.A.risk.total, confidence: t => t.A.confidence.total, execution: t => t.A.executionScore }[UI.rankBy];
  const top = toks.filter(t => t.A).sort((a, b) => key(b) - key(a)).slice(0, 25);
  patch(sec, html`<h2>🌐 Markt</h2>
    <div class="panel"><div class="row">${rg.tags.map(x => html`<span class="chip ${x === 'RISK_ON' ? 'ok' : x === 'RISK_OFF' ? 'bad' : x === 'HIGH_VOLATILITY' ? 'warn' : 'info'}">${x}</span>`)}</div>
      <div class="grid4" style="margin-top:10px">${kv('Breadth (1h > 0)', rg.breadth != null ? (rg.breadth * 100).toFixed(0) + '%' : '—')}${kv('Median 1h', fmtPct(rg.medH1))}${kv('Median |5m|', rg.medM5 != null ? rg.medM5.toFixed(1) + '%' : '—')}${kv('SOL', st.sol ? fmtUsd(st.sol.usd) : '—', st.sol ? (Date.now() - st.sol.at < 60000 ? 'LIVE' : 'STALE') : 'UNKNOWN')}</div>
      <p class="note">Regime aus ${rg.n || 0} Tokens mit Daten. Bei Risk-Off erhöht sich die Vorsicht nicht automatisch aggressiver – keine Revenge-Logik.</p></div>
    <div class="seg" role="group" aria-label="Ranking">${[['opportunity', 'Opportunity'], ['risk', 'Niedrigstes Risiko'], ['confidence', 'Data Confidence'], ['execution', 'Execution Score']].map(([k, n]) => html`<button data-act="rank" data-k="${k}" class="${UI.rankBy === k ? 'on' : ''}">${n}</button>`)}</div>
    <div class="panel tw" style="margin-top:10px"><table class="tbl"><thead><tr><th>#</th><th>Token</th><th class="r">Opportunity</th><th class="r">Risk</th><th class="r">Confidence</th><th class="r">Execution</th><th class="r">Score</th><th>Status</th></tr></thead><tbody>
    ${top.map((t, i) => html`<tr class="click" data-act="select" data-id="${t.id}"><td class="num">${i + 1}</td><td><b>${t.symbol}</b></td><td class="r num">${t.A.opportunity}</td><td class="r">${lvlChip(t.A.risk.level, t.A.risk.total)}</td><td class="r num">${t.A.confidence.total}%</td><td class="r num">${t.A.executionScore}</td><td class="r">${scoreChip(t.A.finalScore)}</td><td>${decChip(t.D.decision)}</td></tr>`)}
    </tbody></table>${top.length ? '' : html`<div class="empty">Noch keine analysierten Tokens.</div>`}</div>`);
}

/* ---------- Watchlist ---------- */
function renderWatchlist(sec) {
  const st = core.state, ids = Object.keys(st.watchlist).sort((a, b) => (st.watchlist[a].priority - st.watchlist[b].priority) || (st.watchlist[b].addedAt - st.watchlist[a].addedAt));
  patch(sec, html`<h2>👁 Watchlist</h2>
    <div class="toolbar"><input id="wlAdd" placeholder="Mint-Adresse hinzufügen" aria-label="Mint-Adresse" autocomplete="off"><button class="btn" data-act="wlAdd">＋ Hinzufügen</button></div>
    ${ids.length ? html`<div class="cards2">${ids.map(id => {
      const w = st.watchlist[id], t = tok(id), A = t && t.A;
      return html`<div class="card"><div class="ch"><button class="star on" data-act="star" data-id="${id}" aria-label="Entfernen">★</button><b>${(t && t.symbol !== '?' ? t.symbol : w.symbol) || shortAddr(mintOfId(id))}</b>${A ? html`${scoreChip(A.finalScore)}${lvlChip(A.risk.level, A.risk.total)}${lbl(A.label)}` : html`<span class="lbl UNKNOWN">KEINE DATEN</span>`}<span class="ag">P${w.priority}</span></div>
        ${A ? html`<div class="grid4" style="margin-top:8px">${kv('Preis', fmtPrice(A.core.price))}${kv('5m', fmtPct(A.price.chg.m5, 0))}${kv('Liq', fmtUsd(A.liq.usd))}${kv('MCap', fmtUsd(A.core.mc))}</div>` : html`<p class="note">Noch keine Marktdaten (Token wird priorisiert abgefragt).</p>`}
        <div class="form" style="margin-top:8px">
          <label class="fld">Notiz<input data-wl="${id}" data-f="note" value="${w.note}" maxlength="200"></label>
          <label class="fld">Priorität<select data-wl="${id}" data-f="priority">${[1, 2, 3].map(p => html`<option value="${p}" ${w.priority === p ? raw('selected') : ''}>${p === 1 ? '1 – hoch' : p === 2 ? '2 – normal' : '3 – niedrig'}</option>`)}</select></label>
          <label class="fld">Alarm Preis ≥<input type="number" step="any" data-wl="${id}" data-f="priceAbove" value="${w.priceAbove != null ? w.priceAbove : ''}"></label>
          <label class="fld">Alarm Preis ≤<input type="number" step="any" data-wl="${id}" data-f="priceBelow" value="${w.priceBelow != null ? w.priceBelow : ''}"></label>
          <label class="fld">Alarm Score ≥<input type="number" data-wl="${id}" data-f="scoreAbove" value="${w.scoreAbove != null ? w.scoreAbove : ''}"></label>
          <label class="fld inl">Alerts aktiv<input type="checkbox" data-wl="${id}" data-f="alerts" ${w.alerts ? raw('checked') : ''}></label>
        </div>
        <button class="ca" data-act="copy" data-v="${mintOfId(id)}" data-l="Mint"><code>${mintOfId(id)}</code><span>⧉ kopieren</span></button>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-act="select" data-id="${id}">Details</button><button class="btn sm bad" data-act="wlRemove" data-id="${id}">Entfernen</button></div></div>`;
    })}</div>` : html`<div class="empty">Watchlist ist leer. Tippe im Scanner auf ☆, um Tokens zu beobachten.</div>`}`);
}

/* ---------- Positionen ---------- */
function positionCard(p) {
  const S = core.S(), t = tok(p.tokenId), now = Date.now();
  const pnlOk = isNum(p.pnlUsd);
  const eq = core.equityInfo();
  const tpTxt = (i) => html`${fmtPrice(p.tps[i])} ${p.tpHit[i] ? '✓' : ''}`;
  return html`<div class="card"><div class="ch"><b>${p.symbol}</b><span class="chip vio">${p.mode}</span><span class="chip">${p.strategy || 'manuell'}</span>${lbl(p.priceLabel || 'UNKNOWN')}<span class="ag">Haltedauer ${fmtAge(now - p.openedAt)}</span></div>
    <div class="grid4" style="margin-top:8px">
      ${kv('Entry (Ø Fill)', fmtPrice(p.entryPrice))}${kv('Aktuell', fmtPrice(p.lastPrice), p.priceLabel)}
      ${kv('PnL (fee-adj.)', pnlOk ? fmtSigned(p.pnlUsd) : 'nicht verfügbar', pnlOk ? 'SIMULATED' : 'UNKNOWN')}${kv('PnL %', pnlOk ? fmtPct(p.pnlPct) : '—')}
      ${kv('Größe (Kosten)', fmtUsd(p.costUsd))}${kv('Exposure', eq.equity > 0 ? (p.costUsd / eq.equity * 100).toFixed(1) + '%' : '—')}
      ${kv('Stop (' + p.stopType + ')', fmtPrice(p.stop))}${kv('Trailing', p.trailing ? 'aktiv' : 'ab +' + S.trailActivatePct + '%')}
      ${kv('TP1', tpTxt(0))}${kv('TP2', tpTxt(1))}${kv('TP3', fmtPrice(p.tps[2]))}${kv('Risk', t && t.A ? t.A.risk.level + ' ' + t.A.risk.total : '—')}
      ${kv('Realisiert', fmtSigned(p.realizedUsd), 'SIMULATED')}${kv('Fees', fmtUsd(p.feesUsd, 4))}${kv('Exit-Impact (voll)', isNum(p.exitImpactPct) ? p.exitImpactPct.toFixed(2) + '%' : '—', 'ESTIMATED')}${kv('Buys', p.entries.length + '/' + Math.min(S.maxBuysPerCoin, 2))}
    </div>
    ${p.timeExitFlag ? html`<p class="note warn">⏱ Time Exit Candidate – erwartete Bewegung blieb aus.</p>` : ''}
    ${p.exitPending ? html`<p class="note bad">Exit ausgesetzt (${p.exitPending.code}): ${p.exitPending.blocker}</p>` : ''}
    <div class="row" style="margin-top:8px"><button class="btn sm" data-act="select" data-id="${p.tokenId}">Details</button><button class="btn sm warn" data-act="sell" data-id="${p.id}" data-frac="0.25">Verkaufen 25 %</button><button class="btn sm warn" data-act="sell" data-id="${p.id}" data-frac="0.5">50 %</button><button class="btn sm bad" data-act="sell" data-id="${p.id}" data-frac="ALL">100 %</button></div></div>`;
}
function renderPositions(sec) {
  const st = core.state, eq = core.equityInfo(), pf = st.portfolio;
  const unreal = st.positions.reduce((a, p) => a + (isNum(p.pnlUsd) ? p.pnlUsd : 0), 0);
  patch(sec, html`<h2>💼 Positionen <span class="lbl SIMULATED">SIMULATED</span></h2>
    <div class="grid4">${kv('Equity', fmtUsd(eq.equity), eq.estimated ? 'ESTIMATED' : 'SIMULATED')}${kv('Cash', fmtUsd(pf.cash))}${kv('Exposure', fmtUsd(eq.exposure) + ' · ' + eq.exposurePct.toFixed(1) + '%')}${kv('Unrealisiert', fmtSigned(unreal))}${kv('Realisiert', fmtSigned(pf.realized))}${kv('Fees gesamt', fmtUsd(pf.fees, 2))}${kv('Startkapital', fmtUsd(pf.startCapital))}${kv('Max Drawdown', (pf.maxDD || 0).toFixed(2) + '%')}</div>
    <p class="note">Alle Positionen sind virtuell (SIMULATION/PAPER) mit echten Marktdaten, geschätzter Slippage und Gebühren. Es gibt keine echten Orders.</p>
    ${st.positions.length ? html`<div class="cards2">${st.positions.map(positionCard)}</div>` : html`<div class="empty">Keine offenen Positionen.</div>`}`);
}

/* ---------- Orders ---------- */
function renderOrders(sec) {
  const os = core.state.orders.slice(0, 120);
  patch(sec, html`<h2>🧾 Orders</h2><p class="note">Jede Order hat eine eindeutige ID und Idempotency-Key. Tx: nur echte Signaturen würden verlinkt – im Simulationsmodus existiert keine Transaktion.</p>
    <div class="panel tw">${os.length ? html`<table class="tbl"><thead><tr><th>Zeit</th><th>Token</th><th>Typ</th><th class="r">Größe</th><th class="r">Preis</th><th>Status</th><th>Tx</th><th>Grund</th></tr></thead><tbody>
    ${os.map(o => html`<tr class="click" data-act="order" data-id="${o.id}"><td class="num">${fmtTime(o.createdAt)}</td><td><b>${o.symbol}</b></td><td>${o.side} <small class="mut">${o.auto ? 'Bot' : 'manuell'} · ${o.mode}</small></td><td class="r num">${o.sizeUsd != null ? fmtUsd(o.sizeUsd) : '—'}</td><td class="r num">${o.fillPrice != null ? fmtPrice(o.fillPrice) : '—'}</td><td><span class="chip ${o.state === 'COMPLETED' ? 'ok' : o.state === 'REJECTED' || o.state === 'FAILED' ? 'bad' : o.state === 'CANCELLED' ? '' : 'info'}">${o.state}</span></td><td class="mut">${o.txSig ? 'Tx' : 'SIMULIERT'}</td><td class="mut">${(o.blockers && o.blockers[0] ? o.blockers[0].code + ': ' : '') + (o.reason || '').slice(0, 80)}</td></tr>`)}
    </tbody></table>` : html`<div class="empty">Noch keine Orders.</div>`}</div>`);
}
function orderModal(id) {
  const o = core.state.orders.find(x => x.id === id); if (!o) return;
  openModal({ title: 'Order Receipt · ' + o.id, body: html`
    <div class="grid2">${kv('Token', o.symbol)}${kv('Seite', o.side + (o.buyNo ? ' #' + o.buyNo : ''))}${kv('Status', o.state)}${kv('Modus', o.mode)}${kv('Größe', o.sizeUsd != null ? fmtUsd(o.sizeUsd) : '—')}${kv('Menge', o.qty != null ? fmtNum(o.qty, 2) : '—')}${kv('Referenzpreis', fmtPrice(o.estPrice))}${kv('Füllpreis', fmtPrice(o.fillPrice), o.fillPrice ? 'SIMULATED' : null)}${kv('Price Impact', isNum(o.expSlipPct) ? o.expSlipPct.toFixed(3) + '%' : '—', 'ESTIMATED')}${kv('Fees', o.fees ? fmtUsd(o.fees.total, 4) : '—', 'ESTIMATED')}${kv('Latenz', o.latencyMs != null ? o.latencyMs + ' ms' : '—')}${kv('Transaktion', 'keine (Simulation)')}</div>
    <p class="note mono">Mint: ${o.mint} · Key: ${o.key || '—'}</p>
    ${o.blockers ? html`<h3>Blocker</h3>${o.blockers.map(b => html`<div class="check"><span class="ic fail">P${b.prio}</span><div><b>${b.code}</b><small>${b.msg}</small></div></div>`)}` : ''}
    <h3>State Machine</h3><ul class="trace">${o.history.map(h => html`<li><b>${fmtTime(h.ts)}</b><span>${h.s}${h.note ? ' – ' + h.note : ''}</span></li>`)}</ul>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-act="copy" data-v="${o.mint}" data-l="Mint">⧉ Copy Mint</button>${o.fillPrice ? html`<button class="btn sm" data-act="copy" data-v="${String(o.fillPrice)}" data-l="Preis">⧉ Copy Price</button>` : ''}</div>` });
}

/* ---------- History & Trade Replay ---------- */
function renderHistory() {
  const q = UI.hq.trim().toLowerCase();
  const list = core.state.journal.filter(j => (!UI.hMode || j.mode === UI.hMode) && (!UI.hRes || (UI.hRes === 'open' ? j.status !== 'CLOSED' : j.result && (UI.hRes === 'win' ? j.result.win : !j.result.win))) && (!q || (j.symbol + ' ' + j.mint + ' ' + (j.reason || '') + ' ' + (j.exitReason || '') + ' ' + (j.strategy || '')).toLowerCase().includes(q))).slice(0, 200);
  patch($('hList'), list.length ? html`<div class="panel tw"><table class="tbl"><thead><tr><th>Eröffnet</th><th>Token</th><th>Modus</th><th>Strategie</th><th class="r">Größe</th><th class="r">PnL</th><th>Exit</th><th class="r">Halten</th><th class="r">Score</th></tr></thead><tbody>
    ${list.map(j => html`<tr class="click" data-act="trade" data-id="${j.id}"><td class="num">${fmtDateTime(j.openedAt)}</td><td><b>${j.symbol}</b></td><td>${j.mode}</td><td>${j.strategy || 'manuell'}</td><td class="r num">${fmtUsd(j.sizeUsd)}</td><td class="r num ${j.result ? cls(j.result.pnlUsd) : ''}">${j.result ? fmtSigned(j.result.pnlUsd) + ' (' + fmtPct(j.result.pnlPct) + ')' : j.status}</td><td>${j.exitReason || '—'}</td><td class="r num">${j.holdMs ? fmtAge(j.holdMs) : '—'}</td><td class="r">${scoreChip(j.score)}</td></tr>`)}
    </tbody></table></div>` : html`<div class="empty">Keine Trades${q || UI.hMode || UI.hRes ? ' für diesen Filter' : ''}. Alle Trades sind simuliert und klar gekennzeichnet.</div>`);
}
function tradeModal(id) {
  const j = core.state.journal.find(x => x.id === id); if (!j) return;
  const d = j.decision || {}, sn = d.snapshot || {};
  openModal({ title: `Trade Replay · ${j.symbol} (${j.mode})`, body: html`
    <div class="grid2">${kv('Trade ID', j.id)}${kv('Status', j.status)}${kv('Eröffnet', fmtDateTime(j.openedAt))}${kv('Geschlossen', fmtDateTime(j.closedAt))}${kv('Investiert', fmtUsd(j.sizeUsd))}${kv('Ergebnis', j.result ? fmtSigned(j.result.pnlUsd) : '—', 'SIMULATED')}${kv('Fees', fmtUsd(j.feesUsd, 4))}${kv('Slippage', fmtUsd(j.slippageUsd, 4), 'ESTIMATED')}${kv('Exit-Grund', j.exitReason || '—')}${kv('MAE 2 min', isNum(j.mae2m) ? fmtPct(j.mae2m) : '—')}${kv('Ø Exec-Latenz', j.execLatencyMs != null ? Math.round(j.execLatencyMs) + ' ms' : '—')}${kv('Param-Version', 'v' + j.paramVersion)}</div>
    <h3>Market Snapshot bei Entscheidung (unveränderlich)</h3>
    <div class="grid2">${kv('Preis', fmtPrice(sn.priceUsd))}${kv('Liquidität', fmtUsd(sn.liquidityUsd))}${kv('MCap', fmtUsd(sn.marketCap))}${kv('Vol 1h', fmtUsd(sn.vol && sn.vol.h1))}${kv('Quelle', sn.source || '—')}${kv('Zeit', fmtTime(sn.fetchedAt))}${kv('Security', d.security ? d.security.status : '—')}${kv('SOL', d.sol ? fmtUsd(d.sol) : '—')}</div>
    <h3>Entscheidung</h3><p>Score <b>${j.score}</b> · Confidence <b>${j.confidence}</b> · Risk <b>${j.risk ? j.risk.total + ' ' + j.risk.level : '—'}</b> · Strategie <b>${j.strategy || 'manuell'}</b> · Regime ${(j.regime || []).join(', ')}</p>
    <p class="note">${j.reason}</p>
    <div>${j.signals.map(s => html`<span class="sig" title="${s.reason}">${SIGNAL_NAMES[s.type] || s.type} <i>${s.strength}</i></span>`)}</div>
    <div>${(j.tags || []).map(x => html`<span class="chip info">${x}</span> `)}</div>
    ${d.trace ? html`<h3>Decision Trace</h3><ul class="trace">${d.trace.map(x => html`<li><span class="ic">${x.ok === true ? '✅' : x.ok === false ? '❌' : '·'}</span><b>${x.stage}</b><span>${x.detail}</span></li>`)}</ul>` : ''}
    <h3>Ausführungen</h3><table class="tbl"><tr><th>Zeit</th><th>Typ</th><th class="r">Preis</th><th class="r">USD</th><th class="r">Fees</th><th>Grund</th></tr>
    ${j.entries.map(e => html`<tr><td class="num">${fmtTime(e.ts)}</td><td>BUY</td><td class="r num">${fmtPrice(e.price)}</td><td class="r num">${fmtUsd(e.usd)}</td><td class="r num">${fmtUsd(e.fees, 4)}</td><td>—</td></tr>`)}
    ${j.exits.map(e => html`<tr><td class="num">${fmtTime(e.ts)}</td><td>SELL</td><td class="r num">${fmtPrice(e.price)}</td><td class="r num">${fmtUsd(e.usd)}</td><td class="r num">${fmtUsd(e.fees, 4)}</td><td>${e.reason} (${fmtSigned(e.realized)})</td></tr>`)}</table>` });
}

/* ---------- Backtest Lab ---------- */
function renderBacktest(sec) {
  const st = core.state;
  const opts = [...st.markets.values()].filter(t => (t.snap && t.snap.pairAddress) || (t.alt && t.alt.pairAddress)).sort((a, b) => (b.id === st.selected) - (a.id === st.selected) || ((b.A ? b.A.finalScore : 0) - (a.A ? a.A.finalScore : 0))).slice(0, 80);
  const S = core.S();
  setHTML(sec, html`<h2>🧪 Backtest Lab</h2>
    <p class="note">Historische OHLCV-Kerzen von GeckoTerminal (max. 1000). Signal auf geschlossener Kerze → Einstieg zum Open der nächsten Kerze (kein Look-Ahead). Stops werden vor Take Profits geprüft. Historische Liquidität/Käuferdaten sind nicht verfügbar – Slippage ist eine Schätzung. Vergangene Performance ist keine Garantie.</p>
    <div class="panel"><div class="form">
      <label class="fld">Token / Pool<select id="btTok">${opts.map(t => html`<option value="${t.id}">${t.symbol} · ${shortAddr((t.snap && t.snap.pairAddress) || t.alt.pairAddress)}</option>`)}</select></label>
      <label class="fld">Timeframe<select id="btTf"><option value="1m">1 Minute</option><option value="5m" selected>5 Minuten</option><option value="15m">15 Minuten</option></select></label>
      <label class="fld">Strategie<select id="btStrat">${Object.entries(BT_STRATEGIES).map(([k, v]) => html`<option value="${k}">${v.name}</option>`)}</select></label>
      <label class="fld">Positionsgröße % Kapital<input id="btSize" type="number" value="10" min="1" max="100"></label>
      <label class="fld">Take Profit %<input id="btTp" type="number" value="${S.tp1Pct}" min="1"></label>
      <label class="fld">Stop Loss %<input id="btSl" type="number" value="${S.stopLossPct}" min="1" max="90"></label>
      <label class="fld">Trailing ab %<input id="btTa" type="number" value="${S.trailActivatePct}" min="1"></label>
      <label class="fld">Trailing Abstand %<input id="btTr" type="number" value="${S.trailPct}" min="1" max="90"></label>
      <label class="fld">Time Exit (Kerzen)<input id="btTime" type="number" value="24" min="1"></label>
      <label class="fld">Fee % je Seite<input id="btFee" type="number" step="0.01" value="${S.dexFeePct + 0.05}"></label>
      <label class="fld">Slippage % je Seite (Schätzung)<input id="btSlip" type="number" step="0.1" value="1"></label>
      <label class="fld inl">Walk-Forward (Train/Validation/Test)<input type="checkbox" id="btWf" checked></label>
    </div><div class="row" style="margin-top:10px"><button class="btn pri" data-act="btRun" id="btRunBtn" ${opts.length ? '' : raw('disabled')}>${UI.btBusy ? '⏳ läuft …' : '▶ Backtest starten'}</button>${opts.length ? '' : html`<span class="mut">Keine Pools mit Adresse im Scanner.</span>`}</div></div>
    <div id="btRes"></div>`);
  renderBtResult();
}
function metricGrid(m) {
  return html`<div class="grid4">${kv('Trades', m.trades)}${kv('Win Rate', m.winRate != null ? (m.winRate * 100).toFixed(1) + '%' : '—')}${kv('Ø Gewinn', fmtUsd(m.avgWin))}${kv('Ø Verlust', fmtUsd(m.avgLoss))}${kv('Profit Factor', m.profitFactor == null ? '—' : m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2))}${kv('Max Drawdown', isNum(m.maxDD) ? m.maxDD.toFixed(2) + '%' : '—')}${kv('Expectancy', fmtUsd(m.expectancy))}${kv('Fees', fmtUsd(m.fees))}${kv('Slippage', fmtUsd(m.slippage), 'ESTIMATED')}${kv('Exposure', isNum(m.exposure) ? m.exposure.toFixed(1) + '%' : '—')}${kv('Ø Haltedauer', m.avgHoldBars != null ? m.avgHoldBars.toFixed(1) + ' Kerzen' : '—')}${kv('Netto', fmtSigned(m.netPnl) + (isNum(m.returnPct) ? ' (' + fmtPct(m.returnPct) + ')' : ''))}</div>`;
}
function renderBtResult() {
  const el = document.getElementById('btRes'); if (!el) return;
  const r = UI.bt;
  if (!r) { patch(el, html`<div class="empty">Noch kein Backtest ausgeführt.</div>`); return; }
  if (r.error) { patch(el, html`<div class="panel bad">Backtest nicht möglich: ${r.error}</div>`); return; }
  patch(el, html`<div class="panel"><h3 style="margin-top:0">${r.symbol} · ${BT_STRATEGIES[r.cfg.strategy].name} · ${r.tf} · ${r.n} Kerzen (${fmtDateTime(r.from)} – ${fmtDateTime(r.to)})</h3>
    ${r.wf ? html`<p class="note">Walk-Forward: Parameter <b>${BT_STRATEGIES[r.cfg.strategy].param} = ${r.wf.chosen}</b> nur auf Training (50 %) gewählt${r.wf.lowSample ? ' – Achtung: zu wenige Trades im Training (&lt; 3), Aussagekraft gering' : ''}.</p>
      <table class="tbl"><tr><th>${BT_STRATEGIES[r.cfg.strategy].param}</th><th class="r">Train Trades</th><th class="r">Train Expectancy</th><th class="r">Train Win Rate</th></tr>${r.wf.grid.map(g => html`<tr><td>${g.param}${g.param === r.wf.chosen ? ' ✓' : ''}</td><td class="r num">${g.train.trades}</td><td class="r num">${fmtUsd(g.train.expectancy)}</td><td class="r num">${g.train.winRate != null ? (g.train.winRate * 100).toFixed(0) + '%' : '—'}</td></tr>`)}</table>
      <h3>Validation (25 %)</h3>${metricGrid(r.wf.validation)}<h3>Test (25 %, out-of-sample)</h3>${metricGrid(r.wf.test)}` : html`${metricGrid(r.res.metrics)}`}
    <h3>Equity-Kurve ${r.wf ? '(Test)' : ''}</h3><div class="chartbox small"><canvas data-chart="bt" aria-label="Backtest Equity"></canvas></div>
    <h3>Trades</h3><div class="tw"><table class="tbl"><tr><th>Einstieg</th><th>Ausstieg</th><th class="r">Entry</th><th class="r">Exit</th><th class="r">PnL</th><th>Grund</th></tr>${(r.wf ? r.wf.testTrades : r.res.trades).slice(-60).map(t => html`<tr><td class="num">${fmtDateTime(t.entryT)}</td><td class="num">${fmtDateTime(t.exitT)}</td><td class="r num">${fmtPrice(t.entry)}</td><td class="r num">${fmtPrice(t.exit)}</td><td class="r num ${cls(t.pnl)}">${fmtSigned(t.pnl)}</td><td>${t.reason}</td></tr>`)}</table></div>
    <p class="note">Keine Aussage über zukünftige Ergebnisse. Keine Optimierung auf die gesamte Historie.</p></div>`);
  drawCharts(el);
}
async function runBacktestUi() {
  if (UI.btBusy) return;
  const v = id => (document.getElementById(id) || {}).value;
  const id = v('btTok'), tf = v('btTf');
  const nums = { sizePct: [+v('btSize'), 1, 100], tpPct: [+v('btTp'), 0.5, 5000], slPct: [+v('btSl'), 0.5, 90], trailActPct: [+v('btTa'), 0.5, 5000], trailPct: [+v('btTr'), 0.5, 90], timeBars: [+v('btTime'), 1, 1000], feePct: [+v('btFee'), 0, 10], slipPct: [+v('btSlip'), 0, 20] };
  const cfg = { strategy: v('btStrat'), capital: 1000 };
  for (const [k, [x, lo, hi]] of Object.entries(nums)) { if (!Number.isFinite(x) || x < lo || x > hi) { toast('WARNING', 'Ungültige Eingabe', `${k}: ${lo}–${hi}`); return; } cfg[k] = x; }
  if (!BT_STRATEGIES[cfg.strategy] || !tok(id)) { toast('WARNING', 'Bitte Token und Strategie wählen'); return; }
  UI.btBusy = true; setText(document.getElementById('btRunBtn'), '⏳ lädt Kerzen …');
  try {
    const d = await core.fetchCandlesForBacktest(id, tf);
    if (d.candles.length < 60) throw new Error(`Zu wenige Kerzen (${d.candles.length}) – mindestens 60 nötig`);
    const wf = document.getElementById('btWf') && document.getElementById('btWf').checked;
    UI.bt = { symbol: tok(id).symbol, tf, cfg, n: d.candles.length, from: d.candles[0].t, to: d.candles[d.candles.length - 1].t, res: wf ? null : runBacktest(d.candles, cfg), wf: wf ? walkForward(d.candles, cfg) : null };
    core.log.info('SYSTEM', `Backtest ${UI.bt.symbol} ${cfg.strategy} ${tf}: ${d.candles.length} Kerzen`);
  } catch (e) { UI.bt = { error: e.message }; }
  finally { UI.btBusy = false; setText(document.getElementById('btRunBtn'), '▶ Backtest starten'); renderBtResult(); }
}

/* ---------- Analytics ---------- */
function renderAnalytics(sec) {
  const st = core.state, trades = st.journal, perf = perfStats(trades), closed = trades.filter(j => j.status === 'CLOSED' && j.result);
  const exitR = {}; for (const j of closed) exitR[j.exitReason || '—'] = (exitR[j.exitReason || '—'] || 0) + 1;
  const pnlDist = bucketize(closed.map(j => j.result.pnlPct), [-20, -10, -5, 0, 5, 10, 25, 50], ['< −20%', '−20…−10', '−10…−5', '−5…0', '0…5', '5…10', '10…25', '25…50', '> 50%']);
  const holdDist = bucketize(closed.map(j => (j.holdMs || 0) / MIN), [2, 5, 15, 30, 60, 240], ['< 2m', '2–5m', '5–15m', '15–30m', '30–60m', '1–4h', '> 4h']);
  const scoreDist = bucketize(closed.map(j => j.score), [50, 60, 70, 80, 90], ['< 50', '50–60', '60–70', '70–80', '80–90', '≥ 90']);
  const riskDist = bucketize(closed.map(j => j.risk && j.risk.total), [20, 35, 50, 65], ['< 20', '20–35', '35–50', '50–65', '≥ 65']);
  const byStrat = {}; for (const j of closed) { const k = j.strategy || 'manuell'; (byStrat[k] = byStrat[k] || []).push(j); }
  const sigPerf = {}; for (const j of closed) for (const s of j.signals) { const x = sigPerf[s.type] || (sigPerf[s.type] = { n: 0, w: 0, pnl: 0 }); x.n++; if (j.result.win) x.w++; x.pnl += j.result.pnlUsd; }
  const dist = (title, rows) => html`<div class="panel"><h3 style="margin-top:0">${title}</h3>${rows.map(r => html`<div class="meter"><span>${r.label}</span>${bar(closed.length ? r.n / closed.length * 100 : 0, 'var(--violet)')}<span class="num r">${r.n}</span></div>`)}</div>`;
  patch(sec, html`<h2>📊 Analytics <span class="lbl SIMULATED">SIMULATED</span></h2>
    <p class="note">Kennzahlen aus simulierten/Paper-Trades. Historische Performance ist keine Garantie oder sichere Zukunftsaussage.</p>
    <div class="grid4">${kv('Trades gesamt', perf.trades)}${kv('Gewinner / Verlierer', perf.wins + ' / ' + perf.losses)}${kv('Win Rate', perf.winRate != null ? (perf.winRate * 100).toFixed(1) + '%' : '—')}${kv('Profit Factor', perf.profitFactor == null ? '—' : perf.profitFactor === Infinity ? '∞' : perf.profitFactor.toFixed(2))}${kv('Ø Gewinn', fmtUsd(perf.avgWin))}${kv('Ø Verlust', fmtUsd(perf.avgLoss))}${kv('Expectancy', fmtUsd(perf.expectancy))}${kv('Max Drawdown', fmtUsd(perf.maxDD))}${kv('Ø Haltedauer', fmtAge(perf.avgHold))}${kv('Fees', fmtUsd(perf.fees))}${kv('Brutto / Netto', fmtSigned(perf.gross) + ' / ' + fmtSigned(perf.net))}${kv('Bester / Schlechtester', fmtSigned(perf.best) + ' / ' + fmtSigned(perf.worst))}</div>
    <h3>PnL-Graph (Equity, simuliert)</h3><div class="chartbox small"><canvas data-chart="equity" aria-label="Equity-Verlauf"></canvas></div>
    <div class="grid2" style="margin-top:12px">${dist('PnL-Verteilung', pnlDist)}${dist('Haltedauer', holdDist)}${dist('Score-Verteilung (Entry)', scoreDist)}${dist('Risk-Verteilung (Entry)', riskDist)}</div>
    <div class="panel"><h3 style="margin-top:0">Exit-Gründe</h3>${Object.keys(exitR).length ? Object.entries(exitR).sort((a, b) => b[1] - a[1]).map(([k, n]) => html`<span class="chip">${k}: ${n}</span> `) : html`<span class="mut">—</span>`}</div>
    <div class="panel tw"><h3 style="margin-top:0">Strategie-Vergleich & Diagnose</h3><table class="tbl"><thead><tr><th>Strategie</th><th class="r">Signale</th><th class="r">Akzeptiert</th><th class="r">Abgelehnt</th><th class="r">Ausgeführt</th><th class="r">Profitabel</th><th class="r">Unprofitabel</th><th class="r">Trades</th><th class="r">Ø PnL</th><th class="r">Max DD</th><th class="r">Ø Größe</th></tr></thead><tbody>
      ${[...STRATEGY_DEFS.map(d => d.id), 'manuell'].map(id => { const s = st.stratStats[id] || {}; const tr = byStrat[id] || []; const p = perfStats(tr); return html`<tr><td>${(STRATEGY_DEFS.find(d => d.id === id) || { name: 'Manuell' }).name}${st.strategies[id] && !st.strategies[id].enabled ? html` <span class="chip vio">aus/Shadow</span>` : ''}</td><td class="r num">${s.signals || 0}</td><td class="r num">${s.accepted || 0}</td><td class="r num">${s.rejected || 0}</td><td class="r num">${s.executed || 0}</td><td class="r num">${s.profitable || 0}</td><td class="r num">${s.unprofitable || 0}</td><td class="r num">${tr.length}</td><td class="r num">${fmtUsd(p.expectancy)}</td><td class="r num">${fmtUsd(p.maxDD)}</td><td class="r num">${tr.length ? fmtUsd(avg(tr.map(j => j.sizeUsd))) : '—'}</td></tr>`; })}
    </tbody></table><p class="note">Transparente Gegenüberstellung – kein „Gewinner“-Ranking bei zu kleiner Stichprobe.</p></div>
    <div class="grid2"><div class="panel"><h3 style="margin-top:0">Signal-Qualität (in Trades)</h3>${Object.keys(sigPerf).length ? html`<table class="tbl"><tr><th>Signal</th><th class="r">Trades</th><th class="r">Win Rate</th><th class="r">Σ PnL</th></tr>${Object.entries(sigPerf).sort((a, b) => b[1].n - a[1].n).map(([k, x]) => html`<tr><td>${SIGNAL_NAMES[k] || k}</td><td class="r num">${x.n}</td><td class="r num">${(x.w / x.n * 100).toFixed(0)}%</td><td class="r num ${cls(x.pnl)}">${fmtSigned(x.pnl)}</td></tr>`)}</table>` : html`<div class="empty">Noch keine abgeschlossenen Trades.</div>`}</div>
    <div class="panel"><h3 style="margin-top:0">False Signals (starke Signale, sofortige Gegenbewegung)</h3>${st.falseSignals.length ? html`<table class="tbl">${st.falseSignals.slice(0, 12).map(f => html`<tr><td class="num">${fmtTime(f.ts)}</td><td>${f.symbol}</td><td>${f.signals.join(', ')}</td><td class="r num dn">${fmtPct(f.mae2m)}</td></tr>`)}</table>` : html`<div class="empty">Keine erfasst.</div>`}</div></div>
    <div class="panel tw"><h3 style="margin-top:0">Parameter-Versionen (Self-Optimization ${core.S().ffAutoTuning ? 'AN' : 'AUS'})</h3><table class="tbl"><tr><th>Version</th><th>Zeit</th><th>Status</th><th>Parameter</th><th class="r">Trades</th><th class="r">Expectancy</th><th>Notiz</th><th></th></tr>
      ${[...st.paramVersions].reverse().map(p => html`<tr><td>v${p.version}${p.version === st.activeParam ? ' (aktiv)' : ''}</td><td class="num">${fmtDateTime(p.ts)}</td><td><span class="chip ${p.status === 'STABLE' ? 'ok' : p.status === 'ROLLED_BACK' ? 'bad' : 'info'}">${p.status}</span></td><td class="mut">${Object.entries(p.params).map(([k, v]) => k + '=' + v).join(', ')}</td><td class="r num">${p.tradeCount || 0}</td><td class="r num">${p.perf ? fmtUsd(p.perf.expectancy) : '—'}</td><td class="mut">${p.note || ''}</td><td>${p.version !== st.activeParam ? html`<button class="btn sm" data-act="rollback" data-v="${p.version}">Aktivieren</button>` : ''}</td></tr>`)}</table>
      <p class="note">Optimierung erst ab ${Math.max(core.S().minTradesForTuning, HARD_LIMITS.MIN_TRADES_FOR_TUNING)} abgeschlossenen Trades, nur in SIMULATION, nur innerhalb fester Grenzen (${Object.entries(TUNING_BOUNDS).map(([k, v]) => k + ' ' + v[0] + '–' + v[1]).join(', ')}). Buy-Limit, Exposure, Kill Switch, Security- und Stale-Data-Blocks sind unveränderbar. Schlechtere Versionen werden automatisch zurückgerollt.</p></div>
    <div class="panel"><h3 style="margin-top:0">Trading Session</h3><div class="grid4">${kv('Session', st.session ? st.session.id : '—')}${kv('Start', st.session ? fmtDateTime(st.session.startedAt) : '—')}${kv('Trades', st.session ? st.session.trades : 0)}${kv('Wins / Losses', st.session ? st.session.wins + ' / ' + st.session.losses : '—')}${kv('Session PnL', st.session ? fmtSigned(st.session.pnl) : '—', 'SIMULATED')}${kv('Heute PnL', fmtSigned(st.risk.dailyPnl))}${kv('Käufe heute', st.risk.dailyTrades)}${kv('Tag', st.risk.dayKey)}</div>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="newSession">↻ Neue Session</button><button class="btn sm" data-act="export" data-kind="analytics-json">⬇ Analytics JSON</button><button class="btn sm" data-act="export" data-kind="journal-csv">⬇ Journal CSV</button></div>
      ${st.sessions.length ? html`<table class="tbl" style="margin-top:10px"><tr><th>Session</th><th>Start</th><th>Ende</th><th class="r">Trades</th><th class="r">PnL</th></tr>${st.sessions.slice(0, 8).map(s => html`<tr><td>${s.id}</td><td class="num">${fmtDateTime(s.startedAt)}</td><td class="num">${fmtDateTime(s.endedAt)}</td><td class="r num">${s.trades}</td><td class="r num">${fmtSigned(s.pnl)}</td></tr>`)}</table>` : ''}</div>`);
  drawCharts(sec);
}

/* ---------- Risiko-Dashboard ---------- */
function renderRisk(sec) {
  const st = core.state, S = core.S(), r = st.risk, now = Date.now(), eq = core.equityInfo(), pr = core.portfolioRisk(), pf = st.portfolio;
  const cool = Object.entries(r.coinCooldown).filter(([, v]) => v > now).map(([id, v]) => [id, v, 'Coin']).concat(Object.entries(r.stratCooldown).filter(([, v]) => v > now).map(([id, v]) => [id, v, 'Strategie']));
  const corr = core.positionCorrelations();
  const posT = st.positions.map(p => tok(p.tokenId)).filter(t => t && t.A);
  const w = st.wallet;
  const dd = pf.peakEquity > 0 ? (pf.peakEquity - eq.equity) / pf.peakEquity * 100 : 0;
  patch(sec, html`<h2>🛡 Risiko</h2>
    <div class="grid4">${kv('Portfolio Risk', pr.score)}${kv('Open Exposure', fmtUsd(eq.exposure) + ' (' + eq.exposurePct.toFixed(1) + '%)')}${kv('Max. Exposure', S.maxExposurePct + '%')}${kv('Max. Position', S.maxPositionPct + '% = ' + fmtUsd(eq.equity * S.maxPositionPct / 100))}${kv('Drawdown aktuell', dd.toFixed(2) + '%')}${kv('Max Drawdown', (pf.maxDD || 0).toFixed(2) + '%')}${kv('Verlustserie', r.lossStreak + ' / ' + S.lossStreakLimit)}${kv('Globale Pause', r.globalPauseUntil > now ? 'noch ' + fmtAge(r.globalPauseUntil - now) : 'nein')}${kv('Loss-Cooldown', r.lossCooldownUntil > now ? 'noch ' + fmtAge(r.lossCooldownUntil - now) : 'frei')}${kv('Tages-PnL / Limit', fmtSigned(r.dailyPnl) + ' / −' + S.dailyLossLimitPct + '%')}${kv('Execution Risk (Ø Exit-Impact)', isNum(avg(st.positions.map(p => p.exitImpactPct).filter(isNum))) ? avg(st.positions.map(p => p.exitImpactPct).filter(isNum)).toFixed(2) + '%' : '—', 'ESTIMATED')}${kv('Data Risk (Ø Confidence)', posT.length ? Math.round(avg(posT.map(t => t.A.confidence.total))) + '%' : '—')}${kv('Security Risk', posT.length ? posT.filter(t => t.A.sec.status !== 'VERIFIED').length + ' nicht VERIFIED' : '—')}${kv('Käufe letzte Stunde', r.buyTimes.filter(x => now - x < HOUR).length + ' / ' + S.maxTradesPerHour)}${kv('Offene Positionen', st.positions.length + ' / ' + S.maxOpenPositions)}${kv('Tageslimit erreicht', r.dailyLimitHit ? 'JA – Auto-Trading aus' : 'nein')}</div>
    ${r.reviewRequired ? html`<div class="panel" style="margin-top:12px"><b class="warn">Review nach Verlustserie empfohlen.</b> <span class="mut">Prüfe History & Analytics. Der Bot wird nach Verlusten nicht aggressiver (keine Revenge-Logik, kein Martingale).</span> <button class="btn sm" data-act="ackReview">Review erledigt</button></div>` : ''}
    <h3>Risk-Graph: Exposure, Drawdown, Portfolio Risk</h3><div class="chartbox small"><canvas data-chart="risk" aria-label="Risikoverlauf"></canvas></div>
    <div class="grid2" style="margin-top:12px"><div class="panel"><h3 style="margin-top:0">Critical Limits (unveränderlich)</h3><table class="tbl">
      <tr><td>MAX_BUYS_PER_COIN</td><td class="r num">${Math.min(S.maxBuysPerCoin, 2)} (hart ≤ ${HARD_LIMITS.MAX_BUYS_PER_COIN})</td></tr><tr><td>SELL_COOLDOWN</td><td class="r num">${S.sellCooldownMin} min (≥ ${HARD_LIMITS.MIN_SELL_COOLDOWN_MIN})</td></tr><tr><td>LOSS_COOLDOWN</td><td class="r num">${S.lossCooldownMin} min (≥ ${HARD_LIMITS.MIN_LOSS_COOLDOWN_MIN})</td></tr><tr><td>LOSS_STREAK_LIMIT</td><td class="r num">${S.lossStreakLimit} (≤ ${HARD_LIMITS.MAX_LOSS_STREAK_LIMIT})</td></tr><tr><td>GLOBAL_PAUSE</td><td class="r num">${S.globalPauseMin} min (≥ ${HARD_LIMITS.MIN_GLOBAL_PAUSE_MIN})</td></tr><tr><td>Nachkauf nur im Gewinn</td><td class="r num">≥ +${PYRAMID_MIN_PNL_PCT}%</td></tr><tr><td>Min. Trades für Optimierung</td><td class="r num">${HARD_LIMITS.MIN_TRADES_FOR_TUNING}</td></tr></table></div>
    <div class="panel"><h3 style="margin-top:0">Aktive Cooldowns</h3>${cool.length ? html`<table class="tbl">${cool.map(([id, v, k]) => html`<tr><td>${(tok(id) || { symbol: shortAddr(mintOfId(id)) }).symbol}</td><td>${k}</td><td class="r num">${fmtAge(v - now)}</td></tr>`)}</table>` : html`<div class="empty">Keine Coin-Cooldowns.</div>`}
      <h3>Korrelation offener Positionen</h3>${corr.length ? html`<table class="tbl">${corr.map(c => html`<tr><td>${c.a} ↔ ${c.b}</td><td class="r num ${c.r != null && c.r >= S.correlationLimit ? 'bad' : ''}">${c.r == null ? 'zu wenig Daten' : c.r.toFixed(2)}</td></tr>`)}</table>` : html`<div class="empty">Weniger als 2 Positionen.</div>`}</div></div>
    ${walletPanel()}`);
  drawCharts(sec);
}

/* Wallet-Panel (gekapselter Adapter): Provider, Status, Public Key, Netzwerk, Balance, Signatur-Workflow */
function walletPanel() {
  const w = core.state.wallet;
  return html`<div class="panel"><h3 style="margin-top:0">Wallet (nur lesend · vorbereitet für später)</h3><p class="note">Nur Public Key, Netzwerk und SOL-Balance (per RPC verifiziert). Private Keys, Seed Phrases und Secret Keys werden nie abgefragt, gespeichert oder geloggt. Signieren ist deaktiviert.</p>
    <div class="grid4">${kv('Status', w.status)}${kv('Provider', w.provider || '—')}${kv('Adresse', w.pubkey ? shortAddr(w.pubkey) : '—')}${kv('Netzwerk (RPC)', w.network || '—', w.network ? 'LIVE' : 'UNKNOWN')}${kv('Balance', w.balanceLamports != null ? lamportsToSol(BigInt(w.balanceLamports)) + ' SOL' : '—', w.balanceLamports != null ? 'LIVE' : 'UNKNOWN')}${kv('Stand', w.balanceAt ? fmtTime(w.balanceAt) : '—')}${kv('Signatur-Workflow', 'deaktiviert')}${kv('Live-Gating', core.liveReadiness().ready ? 'erfüllt' : 'nicht erfüllt')}</div>
    ${w.error ? html`<p class="note bad">${w.error}</p>` : ''}
    <div class="row" style="margin-top:8px">${w.status === 'CONNECTED' ? html`<button class="btn sm" data-act="walletBal">↻ Balance & Netzwerk</button><button class="btn sm bad" data-act="walletOff">Trennen</button>` : html`<button class="btn sm" data-act="wallet">Wallet verbinden (lesend)</button>`}<button class="btn sm" data-act="live">LIVE-Gating ansehen</button></div></div>`;
}
/* ---------- Alarm-Chat ---------- */
function renderAlerts(sec) {
  const f = core.state.feed;
  patch(sec, html`<h2>💬 Alarm-Chat</h2><div class="toolbar"><button class="btn" data-act="notify">🔔 Browser-Benachrichtigungen</button><button class="btn sm" data-act="clearFeed">Verlauf leeren</button></div>
    ${f.length ? f.slice(0, 80).map(e => html`<div class="bub ${e.level}"><small>${fmtTime(e.ts)} · ${e.tag}${e.label ? ' · Daten ' + e.label : ''}${isNum(e.dataAge) ? ' (' + fmtAge(e.dataAge) + ' alt)' : ''}</small>${e.sym ? html`<b>${e.sym}</b> · ` : ''}${e.detail}
      ${e.mint ? html`<div class="note">${isNum(e.mc) ? 'MC ' + fmtUsd(e.mc) + ' · ' : ''}${isNum(e.score) ? 'Score ' + e.score + ' · ' : ''}${e.risk ? 'Risk ' + e.risk + (isNum(e.riskScore) ? ' ' + e.riskScore : '') + ' · ' : ''}${isNum(e.conf) ? 'Confidence ' + e.conf + '%' : ''}${isNum(e.strength) ? ' · Stärke ' + e.strength : ''}</div>
      <button class="ca" data-act="copy" data-v="${e.mint}" data-l="Mint"><code>${e.mint}</code><span>⧉ kopieren</span></button>
      <div class="lk"><a href="#" data-act="select" data-id="${e.tokenId}">🔍 Details</a>${linkHtml([['DexScreener', LINKS.dexscreener(null, e.mint)], ['RugCheck', LINKS.rugcheck(e.mint)], ['Solscan', LINKS.solscanToken(e.mint)]])}</div>` : ''}</div>`) : html`<div class="empty">Noch keine Alarme. Sie erscheinen hier wie in einem Chat.</div>`}`);
}

/* ---------- Diagnose: Warum kauft der Bot nicht? (global vs. je Kandidat getrennt) ---------- */
const CHECK_LABEL = { pass: 'OK', fail: 'BLOCK', warn: 'HINWEIS', info: 'INFO', na: 'N/A' };
const checkRows = list => html`${list.map(x => html`<div class="check"><span class="ic ${x.status}">${CHECK_LABEL[x.status]}</span><div><b>${x.name}</b><small>${x.detail}</small></div></div>`)}`;
function renderDiagnostics(sec) {
  const d = core.diagnostics(), rd = d.readiness, ms = masterStatus();
  const rr = Object.entries(d.rejectReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  patch(sec, html`<h2>🩺 Diagnose – Warum kauft der Bot nicht?</h2>
    <div class="panel"><div class="ctl-top"><span class="mstat ${ms.state}">${ms.text}</span><div class="ctl-why">${rd.reason}</div></div>
      ${rd.hard.length ? html`<h3>Harte Blocker (global)</h3>${rd.hard.map(b => html`<div class="check"><span class="ic fail">P${b.prio}</span><div><b>${b.code}</b><small>${b.msg}</small></div></div>`)}` : ''}
      ${rd.soft.length ? html`<h3>Hinweise (kein Block)</h3>${rd.soft.map(b => html`<div class="check"><span class="ic warn">INFO</span><div><b>${b.code}</b><small>${b.msg}</small></div></div>`)}` : ''}
      <p class="note">READY = System gesund und Kandidat vorhanden · WAITING = System gesund, aktuell kein geeignetes Setup (kein Fehler) · BLOCKED = echte harte Sicherheits-/Systemblockade · ERROR = technischer Fehler · EMERGENCY STOP = Not-Aus. Niedriger Score, kein Konsens oder kein Kandidat lösen nie BLOCKED aus.</p></div>
    <div class="grid2"><div class="panel"><h3 style="margin-top:0">System & Sicherheit (global)</h3>${checkRows(d.system)}</div>
      <div><div class="panel"><h3 style="margin-top:0">Trading-Einstellungen</h3>${checkRows(d.trading)}</div><div class="panel"><h3 style="margin-top:0">Markt (informativ)</h3>${checkRows(d.market)}</div></div></div>
    <div class="panel"><h3 style="margin-top:0">Kandidaten im Detail (je Token, kein globaler Block)</h3>
      <p class="note">Je Stufe: PASS · Ablehnungsgrund · „—“ = nicht erreicht. Werte stehen klein daneben (Security, Liquidität, MCap, Volumen, Momentum, Risk, Score, Confidence, Konsens).</p>
      ${d.chains.length ? d.chains.map(c => html`<div class="card" style="margin-bottom:8px;padding:10px"><div class="ch"><a href="#" data-act="select" data-id="${c.id}"><b>${c.symbol}</b></a>${decChip(c.chain.decision)}${scoreChip(c.score)}${c.chain.reason ? html`<span class="ag">${c.chain.reason}</span>` : ''}</div>
        ${chainHtml(c.chain)}</div>`) : html`<div class="empty">Noch keine analysierten Kandidaten.</div>`}</div>
    <div class="grid2"><div class="panel"><h3 style="margin-top:0">Candidate Pipeline (aktueller Scan)</h3>${PIPELINE.map((p, i) => { const n = d.funnel[p] || 0, first = d.funnel.DISCOVERY || 1; return html`<div class="meter"><span>${i + 1}. ${p.replace('_', ' ')}</span>${bar(n / first * 100, 'var(--pink)')}<span class="num r">${n}</span></div>`; })}</div>
      <div class="panel"><h3 style="margin-top:0">Häufigste NO-TRADE-Gründe</h3>${rr.length ? html`<div class="tw"><table class="tbl">${rr.map(([c, n]) => html`<tr><td><span class="blk">${c}</span></td><td class="mut">${(BLOCKER_DEFS[c] || [])[2] || ''}</td><td class="r num">${n}</td></tr>`)}</table></div>` : html`<div class="empty">—</div>`}</div></div>
    <p><button class="btn" data-act="view" data-view="system">🖥 System & API Health, Metriken, Selbsttest →</button></p>`);
}
/* ---------- System & API Health (tiefe Diagnose, Metriken, Tests) ---------- */
function renderSystem(sec) {
  const st = core.state, h = core.systemHealth(), now = Date.now(), perf = st.metrics.perf, c = st.metrics.counters;
  const names = core.http.names().map(n => core.http.snapshot(n));
  const closed = st.journal.filter(j => j.status === 'CLOSED' && j.result);
  const wr = closed.length ? closed.filter(j => j.result.win).length / closed.length : null;
  const selT = selTok();
  const optional = new Set(['gecko', 'rugcheck', 'dexDisc', 'dexSol']);
  patch(sec, html`<h2>🖥 System & API Health</h2>
    <div class="grid2"><div class="panel"><h3 style="margin-top:0">Bot Health</h3>${core.botHealth().map(x => html`<div class="check"><span class="ic ${x.status === 'OK' ? 'pass' : x.status === 'DEGRADED' ? 'warn' : 'fail'}">${x.status}</span><div><b>${x.name}</b><small>${x.detail}</small></div></div>`)}</div>
    <div class="panel"><h3 style="margin-top:0">System Health ${h.score}/100</h3>${Object.entries(h.parts).map(([k, v]) => html`<div class="meter"><span>${k}</span>${bar(v == null ? 0 : v, v >= 80 ? 'var(--green)' : v >= 50 ? 'var(--yellow)' : 'var(--red)')}<span class="num r">${v == null ? '—' : v}</span></div>`)}
      <p class="note">Zählt nur kritische Quellen (DexScreener Pairs, RPC, Datenfrische, Fehlerrate). Optionale Quellen (GeckoTerminal, RugCheck, Discovery) senken die Health nicht, werden unten aber als DEGRADED/OFFLINE angezeigt.</p>
      <h3>Network Health (Solana RPC)</h3><div class="grid2">${kv('Status', bestRpcStatus())}${kv('Slot', st.rpc.slot != null ? fmtNum(st.rpc.slot) : '—', st.rpc.slot ? (now - st.rpc.slotAt < 30000 ? 'LIVE' : 'STALE') : 'UNKNOWN')}${kv('Latenz', st.rpc.latency != null ? st.rpc.latency + ' ms' : '—')}${kv('Endpoint', st.rpc.endpoint || '—')}${kv('Slot-Fortschritt', st.rpc.prevSlot != null && st.rpc.slot != null ? '+' + (st.rpc.slot - st.rpc.prevSlot) : '—')}${kv('Verbindung', navigator.onLine ? 'online' : 'offline')}</div></div></div>
    <div class="panel tw"><h3 style="margin-top:0">API Health Center</h3><table class="tbl"><thead><tr><th>Quelle</th><th>Status</th><th class="r">Latenz</th><th>Letzter Erfolg</th><th>Letzter Fehler</th><th class="r">Fehlerrate</th><th class="r">Rate Limit</th><th>Backoff / Reset</th><th class="r">Datenalter</th><th>Letzte Meldung</th></tr></thead><tbody>
      ${names.map(x => html`<tr><td>${x.label}${optional.has(x.name) ? html` <span class="chip">optional</span>` : ''}</td><td class="st-${x.status}"><b>${x.status}</b></td><td class="r num">${x.latency != null ? Math.round(x.latency) + ' ms' : '—'}</td><td class="num">${x.lastSuccess ? fmtTime(x.lastSuccess) : '—'}</td><td class="num">${x.lastFailure ? fmtTime(x.lastFailure) : '—'}</td><td class="r num">${x.errorRate != null ? (x.errorRate * 100).toFixed(0) + '%' : '—'}</td><td class="r num">${x.used}/${x.limitPerMin}/min${x.rateLimited ? ' · ' + x.rateLimited + '× limitiert' : ''}</td><td class="num">${x.backoffUntil > now ? 'noch ' + fmtAge(x.backoffUntil - now) : x.resetAt ? fmtTime(x.resetAt) : '—'}</td><td class="r num">${x.dataAge != null ? fmtAge(x.dataAge) : '—'}</td><td class="mut">${x.lastError || ''}</td></tr>`)}
    </tbody></table><p class="note">SOL-Preis: ${st.sol ? fmtUsd(st.sol.usd) + ' · ' + fmtAge(now - st.sol.at) + ' alt · ' + (st.sol.derived ? 'abgeleitet aus ' + st.sol.n + ' SOL-Pools (priceUsd / priceNative)' : 'SOL/USDC-Pool') : 'unbekannt'}</p></div>
    <div class="grid2"><div class="panel"><h3 style="margin-top:0">API-Latenz (ms)</h3><div class="chartbox small"><canvas data-chart="apiLat"></canvas></div><h3>API-Fehlerrate (%)</h3><div class="chartbox small"><canvas data-chart="apiFail"></canvas></div></div>
    <div class="panel"><h3 style="margin-top:0">Scanner-Graph (Ø je Scan / Minute)</h3><div class="chartbox small"><canvas data-chart="scanner"></canvas></div>
      <h3>Metriken</h3><div class="grid3">${kv('Scans/s', (st.scanner.scansWindow.length / 10).toFixed(2))}${kv('Scans gesamt', c.scans)}${kv('Tokens gescannt', st.markets.size)}${kv('Kandidaten', (st.metrics.scanStats || {}).fastPass || 0)}${kv('Buy-Signale', c.buySignals)}${kv('Abgelehnt (Pre-Trade)', c.rejected)}${kv('Ausgeführt', c.executed)}${kv('Win Rate', wr != null ? (wr * 100).toFixed(0) + '%' : '—')}${kv('PnL realisiert', fmtSigned(st.portfolio.realized), 'SIMULATED')}${kv('Drawdown max', (st.portfolio.maxDD || 0).toFixed(2) + '%')}${kv('Offene Positionen', st.positions.length)}${kv('API-Fehler', c.apiErrors)}${kv('Verspätete Antworten verworfen', st.scanner.lateIgnored)}${kv('Übersprungene Scans', st.scanner.skipped)}${kv('Security-Queue', st.secQueue.length)}</div>
      <h3>Performance</h3><div class="grid3">${kv('Scan', perf.scan != null ? perf.scan + ' ms' : '—')}${kv('Analyse', perf.analysis != null ? perf.analysis + ' ms' : '—')}${kv('Decision/Exec', perf.exec != null ? perf.exec + ' ms' : '—')}${kv('Render', perf.render != null ? perf.render + ' ms' : '—')}${kv('API Ø', names.length ? Math.round(avg(names.map(x => x.latency).filter(isNum)) || 0) + ' ms' : '—')}${kv('Requests aktiv', core.http.inflightCount())}</div></div></div>
    <div class="panel"><h3 style="margin-top:0">Selbsttest & Chaos-Tests</h3><p class="note">Laufen gegen isolierte Instanzen mit Mock-Netzwerk (Testdaten werden nie im Scanner angezeigt): normaler Scan, kein Kandidat, niedriger Score, kein Konsens, harter Block, API-/RPC-Ausfall, Stale Data, Duplicate Scan/Order, 2-Buy-Limit, Cooldown, Verlustserie, Emergency Stop, Reload-Recovery, Abgleich, Simulation und Live-Gating.</p>
      <button class="btn pri" data-act="runTests" ${UI.testsRunning ? raw('disabled') : ''}>${UI.testsRunning ? '⏳ läuft …' : '▶ Selbsttest starten'}</button>
      ${UI.tests ? html`<p><b class="${UI.tests.every(x => x.ok) ? 'ok' : 'bad'}">${UI.tests.filter(x => x.ok).length}/${UI.tests.length} bestanden</b></p>${UI.tests.map(x => html`<div class="check"><span class="ic ${x.ok ? 'pass' : 'fail'}">${x.ok ? 'PASS' : 'FAIL'}</span><div><b>[${x.group}] ${x.name}</b><small>${x.detail} · ${x.ms} ms</small></div></div>`)}` : ''}</div>
    ${core.S().debugMode ? html`<div class="panel"><h3 style="margin-top:0">Debug: Decision Trace ${selT ? '· ' + selT.symbol : ''}</h3>${selT && selT.D ? html`<pre class="raw">${JSON.stringify({ decision: selT.D.decision, blockers: selT.D.blockers, trace: selT.D.trace, components: selT.A.components, risk: selT.A.risk, confidence: selT.A.confidence }, null, 2)}</pre>` : html`<p class="mut">Token auswählen.</p>`}
      <h3>Rohdaten (letzte API-Antworten)</h3>${core.S().rawApiLog ? names.filter(x => x.lastRaw).map(x => html`<details><summary>${x.label} · ${fmtTime(x.lastRaw.ts)}</summary><pre class="raw">${x.lastRaw.sample}</pre></details>`) : html`<p class="mut">„Rohdaten speichern“ in den Einstellungen aktivieren.</p>`}</div>` : ''}`);
  drawCharts(sec);
}

/* ---------- Logs ---------- */
const LOG_CATS = [['ALL', 'Alle'], ['API', 'API'], ['SCANNER', 'Scanner'], ['TRADE', 'Trade'], ['RISK', 'Risk'], ['SECURITY', 'Security'], ['ERROR', 'Fehler'], ['DEBUG', 'Debug'], ['SYSTEM', 'System']];
function renderLogs() {
  patch($('logCats'), html`${LOG_CATS.map(([k, n]) => html`<button data-act="logCat" data-k="${k}" class="${UI.logCat === k ? 'on' : ''}">${n}</button>`)}`);
  setText($('btnLogPause'), UI.logPaused ? '▶ Fortsetzen' : '⏸ Anhalten');
  if (UI.logPaused) return;
  const q = UI.logQ.trim().toLowerCase();
  const list = core.log.entries.filter(e => {
    if (UI.logCat === 'ERROR' && !['ERROR', 'CRITICAL'].includes(e.level)) return false;
    if (UI.logCat === 'DEBUG' && e.level !== 'DEBUG') return false;
    if (!['ALL', 'ERROR', 'DEBUG'].includes(UI.logCat) && e.category !== UI.logCat && e.level !== UI.logCat) return false;
    return !q || (e.message + ' ' + e.category).toLowerCase().includes(q);
  }).slice(-300).reverse();
  patch($('logList'), list.length ? html`${list.map(e => html`<div class="logrow"><span class="dim">${fmtTime(e.ts)}${e.restored ? '*' : ''}</span><span class="lv-${e.level}">${e.level}</span><span class="cat mut">${e.category}</span><span class="m">${e.message}${e.meta ? html` <span class="dim">${JSON.stringify(e.meta).slice(0, 200)}</span>` : ''}</span></div>`)}` : html`<div class="empty">Keine Logs für diesen Filter.</div>`);
}

/* ---------- Einstellungen ---------- */
function settingField(d, S) {
  const v = S[d.k];
  if (d.t === 'bool') return html`<label class="fld inl">${d.l}${d.hard ? html` <span class="hard">HART</span>` : ''}<input type="checkbox" data-set="${d.k}" ${v ? raw('checked') : ''}></label>`;
  if (d.t === 'select') return html`<label class="fld">${d.l}<select data-set="${d.k}">${d.opts.map(o => html`<option value="${o[0]}" ${o[0] === v ? raw('selected') : ''}>${o[1]}</option>`)}</select></label>`;
  if (d.t === 'text') return html`<label class="fld" style="grid-column:1/-1">${d.l}<input data-set="${d.k}" value="${v}" autocomplete="off" spellcheck="false"><small class="dim">Keine API-Keys in öffentliche Geräte eingeben; Keys werden nur lokal gespeichert und in Logs maskiert.</small></label>`;
  return html`<label class="fld">${d.l}${d.u ? ' (' + d.u + ')' : ''}${d.hard ? html` <span class="hard" title="Sicherheitsgrenze: nur verschärfbar">HART ${d.min}–${d.max}</span>` : ''}<input type="number" data-set="${d.k}" value="${v}" min="${d.min}" max="${d.max}" step="${d.step || (d.t === 'int' ? 1 : 'any')}"></label>`;
}
function renderSettings(sec) {
  const S = core.S(), st = core.state;
  const sections = [...new Set(SETTINGS_SCHEMA.map(d => d.s))];
  setHTML(sec, html`<h2>⚙ Einstellungen</h2>
    <p class="note">Alle Werte werden validiert (endliche Zahlen, Min/Max, Prozente, keine negativen Kapitalwerte). Sichere Defaults: SIMULATION, Auto-Trading AUS. Änderungen werden versioniert protokolliert.</p>
    <div class="row" style="margin-bottom:10px"><b class="mut">Profil:</b>${Object.keys(PROFILES).map(p => html`<button class="btn sm" data-act="profile" data-p="${p}">${p}</button>`)}</div>
    ${sections.map(s => html`<details class="panel" ${s === 'Filter' || s === 'Risiko' ? raw('open') : ''}><summary><b>${s}</b></summary><div class="form" style="margin-top:10px">${SETTINGS_SCHEMA.filter(d => d.s === s).map(d => settingField(d, S))}</div></details>`)}
    <details class="panel" open><summary><b>Strategien</b></summary><div class="tw" style="margin-top:10px"><table class="tbl"><thead><tr><th>Strategie</th><th>Aktiv</th><th>Gewicht</th><th>Min Score</th><th>Risk Limit</th><th>Min Liq $</th><th>Min Conf</th><th>Cooldown min</th><th>Größe %</th></tr></thead><tbody>
      ${STRATEGY_DEFS.map(def => { const c = st.strategies[def.id]; return html`<tr><td><b>${def.name}</b><br><small class="mut">${def.desc}</small></td><td><input type="checkbox" data-strat="${def.id}" data-f="enabled" ${c.enabled ? raw('checked') : ''} aria-label="${def.name} aktiv"></td>${Object.keys(STRATEGY_FIELDS).map(f => html`<td><input type="number" step="any" style="width:84px" data-strat="${def.id}" data-f="${f}" value="${c[f]}" aria-label="${def.name} ${f}"></td>`)}</tr>`; })}
    </tbody></table></div><p class="note">Mehrere Strategien stimmen ab (Konsens ≥ ${S.consensusMinWeight}). Die Risk Engine hat immer Vorrang: mehrere BUY-Signale + Risk-Block ⇒ NO BUY. Deaktivierte Strategien laufen im Shadow Mode mit (keine Orders).</p></details>
    <details class="panel"><summary><b>Export / Import / Reset</b></summary><div class="row" style="margin-top:10px">
      <button class="btn sm" data-act="export" data-kind="settings-json">⬇ Settings JSON</button><button class="btn sm" data-act="export" data-kind="journal-json">⬇ Journal JSON</button><button class="btn sm" data-act="export" data-kind="journal-csv">⬇ Journal CSV</button><button class="btn sm" data-act="export" data-kind="analytics-json">⬇ Analytics JSON</button><button class="btn sm" data-act="export" data-kind="logs-json">⬇ Logs JSON</button>
      <button class="btn sm" data-act="importSettings">⬆ Settings/Watchlist importieren</button></div>
      <div class="row" style="margin-top:10px"><button class="btn sm warn" data-act="resetSettings">Einstellungen zurücksetzen</button><button class="btn sm warn" data-act="resetPortfolio">Sim-Portfolio zurücksetzen</button><button class="btn sm bad" data-act="factoryReset">Factory Reset</button></div></details>
    <details class="panel"><summary><b>Config Change Log & Audit Trail</b></summary>
      <h3>Konfigurationsänderungen</h3>${st.configLog.length ? html`<div class="tw"><table class="tbl">${st.configLog.slice(0, 40).map(c => html`<tr><td class="num">${fmtDateTime(c.ts)}</td><td>${c.who}</td><td>${c.kind}</td><td class="mut">${c.changes.map(x => x.key + ': ' + x.from + ' → ' + x.to).join(' · ')}</td></tr>`)}</table></div>` : html`<p class="mut">Keine Änderungen.</p>`}
      <h3>Audit Trail (wer/was/wann/warum)</h3>${st.auditLog.length ? html`<div class="tw"><table class="tbl">${st.auditLog.slice(0, 60).map(a => html`<tr><td class="num">${fmtDateTime(a.ts)}</td><td>${a.who}</td><td>${a.what}</td><td class="mut">${a.detail}${a.why ? ' · ' + a.why : ''}</td></tr>`)}</table></div>` : html`<p class="mut">Noch keine Einträge.</p>`}</details>
    <div class="panel"><h3 style="margin-top:0">Über</h3><p class="mut">Smart Lab v${APP_VERSION} · Strategy Engine ${STRATEGY_VERSION} · Data Engine ${DATA_ENGINE_VERSION} · Storage v${STORAGE_VERSION} · Parameter v${st.activeParam}. Datenquellen: DexScreener, GeckoTerminal, RugCheck, Solana JSON-RPC. LIVE-Trading ist nicht verfügbar (REQUIRES EXTERNAL PROVIDER) – es werden keine Private Keys verarbeitet.</p></div>`);
}

/* ---------- Wissensbasis (lokal) ---------- */
const KB = [
  ['Trading', 'NO TRADE ist eine valide Entscheidung', 'Ein entdeckter Token ist kein Kaufgrund. Der Bot handelt nur, wenn Datenqualität, Sicherheit, Risiko, Portfolio-Limits, Cooldowns und Strategie-Konsens gleichzeitig passen.'],
  ['Risk Management', 'Positionsgröße', 'Größe = Kapital × Strategie-% × Risiko-, Confidence- und Volatilitätsfaktor, begrenzt durch Liquidität (Impact ≤ halbe max. Slippage), freie Exposure, max. Positionsgröße und Cash. Bei zu geringer Datenqualität ist die Größe 0.'],
  ['Risk Management', 'Stops & Take Profits', 'Prozent-Stop, optional ATR-Stop (aus 1m-OHLCV), Trailing ab definiertem Gewinn, Break-even nach TP1, TP1–TP3 als Teilverkäufe, Time Exit, Liquiditätsabfluss- und Risiko-Exit.'],
  ['Risk Management', 'Buy-Limit & Cooldowns', 'Pro Mint maximal 2 Käufe. Nachkauf nur im Gewinn (≥ +10 %), nie im Verlust (kein Martingale/Blind DCA). Nach jedem Verkauf 15 min Coin-Cooldown, nach Verlust 10 min globaler Loss-Cooldown, nach 3 Verlusten in Folge globale Pause.'],
  ['Market Structure', 'Käufer/Verkäufer-Verhältnis', 'DexScreener liefert Transaktionszahlen (nicht Buy-/Sell-Volumen). Das Verhältnis zeigt Druck, sagt aber nichts über Trade-Größen – deshalb wird zusätzlich die Ø-Trade-Größe relativ zur Liquidität betrachtet.'],
  ['Market Structure', 'Pump- & Manipulationsmuster', 'Vertikaler Anstieg, extreme Kaufquote, Volumen- oder Liquiditäts-Spikes und Whale-dominierte Bewegungen erhöhen das Risiko. Ein Pump wird nie automatisch als Kaufsignal gewertet.'],
  ['Solana', 'Mint Authority', 'Ist die Mint Authority aktiv, kann jederzeit neue Supply erzeugt werden. Der Bot prüft das per Solana RPC (getAccountInfo, jsonParsed) und blockiert aktive Mint Authorities.'],
  ['Solana', 'Freeze Authority', 'Eine aktive Freeze Authority kann Token-Konten einfrieren – Verkauf wäre dann unmöglich. Status CRITICAL, Käufe blockiert.'],
  ['Solana', 'Token-2022-Extensions', 'Permanent Delegate, Transfer Hook, Transfer Fee oder Non-Transferable können Verkäufe verhindern oder verteuern. Sie werden aus den Mint-Daten erkannt und als Risiko markiert.'],
  ['Solana', 'Lamports & Gebühren', '1 SOL = 1.000.000.000 Lamports. Gebühren = Basisgebühr (5000 Lamports) + Priority Fee + DEX-Gebühr. Umrechnung erfolgt exakt über BigInt; ohne aktuellen SOL-Preis wird nicht gehandelt.'],
  ['Liquidity', 'Liquidität / Market Cap', 'Ein niedriges Verhältnis (< 3 %) bedeutet dünne Exit-Liquidität: Schon kleine Verkäufe bewegen den Preis stark.'],
  ['Slippage', 'Price Impact (AMM)', 'Geschätzt über die Konstantprodukt-Formel: Impact ≈ Größe / (Liquidität/2 + Größe). Das ist eine Schätzung (ESTIMATED); echte Pools, Gebührenstufen und MEV können abweichen.'],
  ['Memecoin Risks', 'Rug Pull & Holder-Konzentration', 'Hohe Konzentration bei wenigen Wallets, ungesperrte LP und aktive Authorities sind typische Rug-Risiken. Holder-Daten via RPC enthalten Pool-/LP-Konten und sind daher Beobachtungen mit begrenzter Confidence – keine Insider-Behauptungen.'],
  ['Memecoin Risks', 'Boosts sind Werbung', 'DexScreener-Boosts sind bezahlte Promotion. Sie werden als Flag angezeigt, erhöhen aber nicht den Score.'],
  ['Technical Indicators', 'EMA, RSI, ATR, VWAP', 'EMA glättet den Preis (Trend), RSI misst Überkauft/Überverkauft, ATR die typische Schwankung (für Stops), VWAP den volumengewichteten Durchschnittspreis. Indikatoren unterstützen Entscheidungen, ersetzen aber keine Risikoanalyse.'],
  ['Strategy Logic', 'Strategie-Konsens', 'Mehrere Strategien stimmen gewichtet ab. Nur wenn die Summe der Gewichte der BUY-Stimmen die Schwelle erreicht und die Risk Engine nicht blockiert, entsteht ein Kandidat.'],
  ['Strategy Logic', 'Backtest ohne Look-Ahead', 'Signale werden auf geschlossenen Kerzen berechnet, der Einstieg erfolgt zum Open der nächsten Kerze. Walk-Forward trennt Training, Validierung und Test. Vergangene Ergebnisse sind keine Garantie.'],
  ['Diagnostics', 'Datenlabels', 'LIVE = frisch von der API, CACHED = aus kurzem Request-Cache, STALE = zu alt (blockiert Käufe), FALLBACK = nur Zweitquelle, ESTIMATED = berechnete Schätzung, SIMULATED = virtuell, UNKNOWN = keine Daten.'],
  ['Diagnostics', 'Data Confidence', 'Gesamtwert aus Preis-, Liquiditäts-, Volumen-, Security-, Marktstruktur- und On-Chain-Confidence. Cross-Checks mit GeckoTerminal erhöhen, Konflikte senken den Wert. Unter der Mindest-Confidence gibt es keine Käufe.'],
  ['Diagnostics', 'System Health', 'Kombiniert Status der APIs und RPCs, Datenfrische und Fehlerraten. Liegt der Wert unter der Mindestschwelle, wird Trading eingeschränkt; nach Ausfällen geht der Bot in RECOVERING, bis die Datenqualität reicht.'],
  ['Diagnostics', 'Warum ist LIVE nicht verfügbar?', 'Echte Orders erfordern einen verifizierten Wallet-Adapter mit Signatur-Freigabe, einen Swap-/Routing-Provider sowie echte Bestätigungen und Reconciliation. Das ist in dieser Datei nicht sicher umsetzbar – daher REQUIRES EXTERNAL PROVIDER statt vorgetäuschter Funktion.'],
  ['Diagnostics', 'RPC 403 & DexScreener-Timeouts', 'Der offizielle öffentliche Solana-RPC (api.mainnet-beta.solana.com) ist auf ~100 Requests/10s pro IP begrenzt und blockt Browser-/Bot-Traffic gezielt mit 403 – das ist keine Fehlfunktion dieser App, sondern Absicht des Betreibers. Gleiches gilt für die kostenlose DexScreener-API unter Last. Abhilfe: unter Scanner → Solana RPC-URLs einen eigenen Key-Provider (Helius, QuickNode, Triton, Ankr) als ersten Eintrag setzen; die App nutzt automatisch bis zu 4 Endpoints mit Ranking/Failover. Bei DexScreener-Ausfällen springt die Cross-Check-Funktion für die Top-Kandidaten automatisch auf GeckoTerminal.'],
  ['Risk Management', 'Warum die globale Pause nach Verlustserie nicht abschaltbar ist', 'lossStreakLimit (max. 3) und globalPauseMin (min. 5) sind bewusst als HARD_LIMITS gesetzt und lassen sich weder über Settings noch über Auto-Tuning umgehen – auch nicht bei manuellen Trades. Grund: Genau nach mehreren Verlusten in Folge steigt die Versuchung, Verluste "zurückzuholen" (Revenge Trading), was historisch die häufigste Ursache für Kapitalverlust bei automatisierten Strategien ist. Die Pause läuft nach Ablauf automatisch weiter, verändert also nichts an Score/Strategie – sie erzwingt nur eine kurze Pause zur Kontrolle.']
];
function renderKnowledge(sec) {
  const q = UI.kbQ.trim().toLowerCase();
  const list = KB.filter(k => !q || k.join(' ').toLowerCase().includes(q));
  const topics = [...new Set(list.map(k => k[0]))];
  const body = html`${topics.map(tp => html`<h3>${tp}</h3>${list.filter(k => k[0] === tp).map(k => html`<div class="kb"><b>${k[1]}</b><p>${k[2]}</p></div>`)}`)}${list.length ? '' : html`<div class="empty">Kein Eintrag gefunden.</div>`}`;
  if (!document.getElementById('kbq')) setHTML(sec, html`<h2>📚 Wissensbasis</h2><div class="toolbar"><input type="search" id="kbq" placeholder="Wissensbasis durchsuchen" aria-label="Wissensbasis durchsuchen"></div><div class="panel" id="kbList"></div>`);
  patch(document.getElementById('kbList'), body);
}

/* ---------- Token-Detail (Right Panel) ---------- */
const DETAIL_TABS = [['overview', 'Übersicht'], ['chart', 'Chart'], ['risk', 'Risiko & Security'], ['plan', 'Trade Plan'], ['why', 'Warum?']];
function detailHead(t) {
  const A = t.A, D = t.D, w = !!core.state.watchlist[t.id];
  if (!A) return html`<div class="dhead"><h2>${t.symbol}</h2><button class="dclose" data-act="closeDetail" aria-label="Details schließen">✕</button></div><p class="mut">Warte auf Marktdaten … (keine Platzhalterwerte)</p>`;
  const c = A.price.chg;
  return html`<div class="dhead"><div style="min-width:0"><h2>${t.symbol} <small class="mut">${t.name}</small></h2>
    <div class="row" style="margin-top:4px">${decChip(D.decision)}${scoreChip(A.finalScore)}${lvlChip(A.risk.level, A.risk.total)}<span class="chip info" title="Data Confidence">Conf ${A.confidence.total}%</span><span class="chip">${A.ageClass}</span>${lbl(A.label)}</div></div>
    <button class="dclose" data-act="closeDetail" aria-label="Details schließen">✕</button></div>
    <div class="row" style="margin-top:8px"><b class="num" style="font-size:21px" title="${A.core.priceRaw || ''}">${fmtPrice(A.core.price)}</b><span class="num ${cls(c.m5)}">5m ${fmtPct(c.m5)}</span><span class="num ${cls(c.h1)}">1h ${fmtPct(c.h1)}</span><span class="num ${cls(c.h24)}">24h ${fmtPct(c.h24)}</span><span class="mut">· ${A.dataAge != null ? fmtAge(A.dataAge) + ' alt' : ''} · ${A.core.source || '—'}</span></div>
    <button class="ca" data-act="copy" data-v="${t.mint}" data-l="Mint"><code>${t.mint}</code><span>⧉ Mint</span></button>
    <div class="row" style="margin-top:8px"><button class="btn sm ${w ? 'on' : ''}" data-act="star" data-id="${t.id}">${w ? '★ Watchlist' : '☆ Watchlist'}</button><button class="btn sm pri" data-act="buy" data-id="${t.id}">💱 Simulate Buy</button><button class="btn sm" data-act="analyze" data-id="${t.id}">🔍 Neu analysieren</button><button class="btn sm" data-act="ctx" data-id="${t.id}" aria-label="Weitere Aktionen">⋯</button></div>`;
}
function meterRow(name, v, color, label) { return html`<div class="meter"><span>${name}</span>${bar(v, color)}<span class="num r">${v == null ? '—' : v}${label ? '' : ''}</span></div>`; }
function tabOverview(t) {
  const A = t.A; if (!A) return '';
  const tx = A.tx, v = A.vol;
  return html`<div class="grid3">${kv('Market Cap', fmtUsd(A.core.mc), A.labels.price)}${kv('FDV', fmtUsd(A.core.fdv))}${kv('Liquidität', fmtUsd(A.liq.usd), A.labels.liquidity)}
    ${kv('Liq/MCap', A.liq.ratioMc != null ? (A.liq.ratioMc * 100).toFixed(1) + '%' : '—')}${kv('Vol 5m', fmtUsd(v.m5))}${kv('Vol 1h', fmtUsd(v.h1), A.labels.volume)}
    ${kv('Vol 24h', fmtUsd(v.h24))}${kv('Txns 5m K/V', (tx.b5 != null ? tx.b5 : '—') + '/' + (tx.s5 != null ? tx.s5 : '—'))}${kv('Txns 1h K/V', (tx.b1 != null ? tx.b1 : '—') + '/' + (tx.s1 != null ? tx.s1 : '—'))}
    ${kv('Käufer 5m', tx.ratio5 != null ? (tx.ratio5 * 100).toFixed(0) + '%' : '—')}${kv('Käufer 1h', tx.ratio1 != null ? (tx.ratio1 * 100).toFixed(0) + '%' : '—')}${kv('Ø Trade 5m', fmtUsd(tx.avgTrade5))}
    ${kv('Run-Rate 5m', v.runRate5 != null ? v.runRate5.toFixed(2) + '×' : '—')}${kv('Volatilität/min', A.price.volPct != null ? A.price.volPct.toFixed(2) + '%' : '—', A.price.volLabel)}${kv('Drawdown 30m', fmtPct(A.price.drawdown))}
    ${kv('Pair-Alter', fmtAge(A.core.pairAge))}${kv('DEX', A.core.dexId || '—')}${kv('Top-10 Holder', A.sec.top10Pct != null ? A.sec.top10Pct.toFixed(1) + '%' : '—', A.labels.holders)}</div>
    <h3>Opportunity vs. Risk vs. Confidence</h3>
    ${meterRow('Opportunity', A.opportunity, 'var(--green)')}${meterRow('Risk', A.risk.total, riskColor(A.risk.total))}${meterRow('Confidence', A.confidence.total, 'var(--cyan)')}${meterRow('Execution', A.executionScore, 'var(--violet)')}
    <h3>Technische Analyse ${A.ta ? lbl(A.ta.label) : ''}</h3>${A.ta ? html`<div class="grid3">${kv('EMA 9', fmtPrice(A.ta.ema9))}${kv('EMA 21', fmtPrice(A.ta.ema21))}${kv('SMA 20', fmtPrice(A.ta.sma20))}${kv('RSI 14', A.ta.rsi != null ? A.ta.rsi.toFixed(0) : '—')}${kv('ATR %', A.ta.atrPct != null ? A.ta.atrPct.toFixed(2) + '%' : '—')}${kv('ROC 10', fmtPct(A.ta.roc))}${kv('VWAP', fmtPrice(A.ta.vwap))}${kv('Momentum', A.price.momentum)}${kv('Trend', A.price.trend)}</div><p class="note">Quelle: ${A.ta.source}. Indikatoren unterstützen Entscheidungen, ersetzen aber keine Risikoanalyse.</p>` : html`<p class="mut">Nicht genug Datenpunkte (mind. 15 Live-Samples oder frische 1m-OHLCV via Chart-Tab).</p>`}
    <h3>Signale</h3>${A.signals.length ? A.signals.map(s => html`<div class="check"><span class="ic ${CONTEXT_SIGNALS.has(s.type) ? 'na' : 'pass'}">${s.strength}</span><div><b>${SIGNAL_NAMES[s.type]}</b><small>${s.reason} · Confidence ${s.confidence}</small></div></div>`) : html`<p class="mut">Keine Signale aktiv.</p>`}
    ${A.flags.length ? html`<h3>Flags</h3><div class="row">${A.flags.map(f => html`<span class="f ${f === 'BOOST' ? 'B' : f === 'PUMP' || f === 'DUMP' ? 'X' : ''}">${f}</span>`)}</div>` : ''}
    <h3>Links</h3><div class="lk">${linkHtml(tokenLinks(t))}</div>
    <p class="note">Entdeckt ${fmtAge(Date.now() - t.meta.discoveredAt)} her via ${t.meta.via.join(', ')}${core.state.seen[t.id] ? ` · seit Fund ${fmtPct((A.core.mc / core.state.seen[t.id].mc - 1) * 100)}` : ''}</p>`;
}
function tabRisk(t) {
  const A = t.A; if (!A) return '';
  const sec = t.sec, now = Date.now();
  const q = [['Preis', A.labels.price, A.dataAge, A.core.source], ['Liquidität', A.labels.liquidity, A.dataAge, A.core.source], ['Volumen', A.labels.volume, A.dataAge, A.core.source], ['Security', A.labels.security, sec ? now - sec.checkedAt : null, sec ? Object.entries(sec.sources).filter(x => x[1]).map(x => x[0]).join('+') || 'keine' : '—'], ['Holders', A.labels.holders, sec ? now - sec.checkedAt : null, sec ? sec.holderSrc || '—' : '—'], ['Social', 'UNKNOWN', null, 'keine Datenquelle']];
  return html`<h3 style="margin-top:0">Scorecard</h3>${Object.entries(A.components).map(([k, v]) => meterRow(COMP_NAMES[k], v, v >= 65 ? 'var(--green)' : v >= 40 ? 'var(--yellow)' : 'var(--red)'))}${meterRow('RISK (gesamt)', A.risk.total, riskColor(A.risk.total))}
    <h3>Risk Factors</h3>${Object.entries(A.risk.factors).map(([k, v]) => html`<div class="meter"><span>${RISK_NAMES[k].replace(' Risk', '')}</span>${bar(v, riskColor(v || 0))}<span class="num r">${v == null ? '?' : v}</span></div>`)}
    <p class="note">Gesamt ${A.risk.total} → ${A.risk.level}. „?“ = keine Daten (fließt neutral ein, keine Annahme).</p>
    <h3>Token Security ${sec ? html`<span class="lvl lvl-${sec.status === 'VERIFIED' ? 'LOW' : sec.status === 'PARTIAL' ? 'MODERATE' : sec.status === 'CRITICAL' ? 'CRITICAL' : 'UNKNOWN'}">${sec.status}</span>` : html`<span class="lvl lvl-UNKNOWN">${t.secPending ? 'PRÜFUNG LÄUFT' : 'UNKNOWN'}</span>`}</h3>
    ${sec ? html`<div class="grid2">${kv('Mint Authority', sec.mintAuthority)}${kv('Freeze Authority', sec.freezeAuthority)}${kv('Programm', sec.program || '—')}${kv('Decimals', sec.decimals != null ? sec.decimals : '—')}${kv('Top-10', sec.top10Pct != null ? sec.top10Pct.toFixed(1) + '%' : '—')}${kv('RugCheck (norm.)', sec.rugScoreNorm != null ? sec.rugScoreNorm : '—')}${kv('LP gesperrt', sec.lpLockedPct != null ? sec.lpLockedPct.toFixed(0) + '%' : '—')}${kv('Geprüft', fmtAge(now - sec.checkedAt) + ' her')}</div>
      ${sec.flags.length ? sec.flags.map(f => html`<div class="check"><span class="ic ${f.level === 'CRITICAL' ? 'fail' : 'warn'}">${f.level}</span><div><b>${f.code}</b><small>${f.msg}</small></div></div>`) : html`<p class="ok">Keine Risk Flags gefunden.</p>`}` : html`<p class="mut">Noch nicht geprüft. Käufe bleiben blockiert (Security Unknown = No Buy).</p>`}
    <p class="note">Beobachtungen, keine Sicherheitsgarantie. Holder-Daten via RPC enthalten Pool-Konten.</p><button class="btn sm" data-act="secRecheck" data-id="${t.id}">🛡 Security neu prüfen</button>
    ${A.pump.flags.length ? html`<h3>Pump / Manipulation</h3>${A.pump.flags.map(f => html`<div class="check"><span class="ic warn">!</span><div>${f}</div></div>`)}` : ''}
    ${A.vol.anomalies.length ? html`<h3>Volumen-Anomalien</h3>${A.vol.anomalies.map(f => html`<div class="check"><span class="ic warn">!</span><div>${f}</div></div>`)}` : ''}
    <h3>Datenkonflikte</h3>${A.conflicts.length ? A.conflicts.map(c => html`<div class="check"><span class="ic fail">KONFLIKT</span><div><b>${c.field}</b><small>DexScreener ${c.field === 'Preis' ? fmtPrice(c.a) : fmtUsd(c.a)} vs. GeckoTerminal ${c.field === 'Preis' ? fmtPrice(c.b) : fmtUsd(c.b)} (${c.diffPct.toFixed(1)} %)</small></div></div>`) : html`<p class="mut">${A.crossChecked ? 'Cross-Check mit GeckoTerminal: keine Konflikte' + (A.crossPriceDiff != null ? ` (Δ Preis ${A.crossPriceDiff.toFixed(2)} %)` : '') : 'Kein Cross-Check verfügbar (Zweitquelle fehlt/nicht zeitgleich).'}</p>`}
    <h3>Data Quality</h3><table class="tbl">${q.map(r => html`<tr><td>${r[0]}</td><td>${lbl(r[1])}</td><td class="num">${r[2] != null ? fmtAge(r[2]) : '—'}</td><td class="mut">${r[3]}</td></tr>`)}</table>`;
}
function tabPlan(t) {
  const A = t.A, S = core.S(); if (!A) return '';
  const ex = core.execCheck(t, { auto: false, preTrade: false });
  const sz = ex.sizing, p = A.core.price;
  const oh = t.ohlcv && t.ohlcv['1m']; const a14 = oh && oh.candles.length >= 20 ? atr(oh.candles, 14) : null;
  const pos = core.state.positions.find(x => x.tokenId === t.id);
  const exitImp = sz && sz.size > 0 ? core.estImpact(sz.size, A.liq.usd) : null;
  const autoB = t.D.blockers;
  return html`<h3 style="margin-top:0">Execution Preview <span class="lbl SIMULATED">${core.state.mode}</span></h3>
    <div class="grid2">${kv('Token', t.symbol)}${kv('Seite', 'BUY')}${kv('Vorgeschlagene Größe', sz && sz.size > 0 ? fmtUsd(sz.size) : '0', 'ESTIMATED')}${kv('begrenzt durch', (sz && sz.capBy) || '—')}${kv('Geschätzter Preis', fmtPrice(p), A.label)}${kv('Erw. Price Impact', sz && isNum(sz.impactPct) ? sz.impactPct.toFixed(3) + '%' : '—', 'ESTIMATED')}${kv('Gebühren gesamt', sz && sz.fees ? fmtUsd(sz.fees.total, 4) : '—', 'ESTIMATED')}${kv('Max. Price Impact', S.maxSlippagePct + '%')}</div>
    ${sz && sz.fees ? html`<p class="note">Fees: Netzwerk ${fmtUsd(sz.fees.network, 5)} + Priority ${fmtUsd(sz.fees.priority, 5)} (${sz.fees.lamports} Lamports @ SOL ${fmtUsd(sz.fees.solUsd)}) + DEX ${fmtUsd(sz.fees.dex, 4)}</p>` : ''}
    ${sz && sz.factors && sz.factors.caps ? html`<p class="note">Sizing: Basis ${sz.factors.basePct}% · Risk-Faktor ${sz.factors.fRisk} · Confidence-Faktor ${sz.factors.fConf} · Volatilitäts-Faktor ${sz.factors.fVol} · Limits: ${Object.entries(sz.factors.caps).map(([k, v]) => k + ' ' + fmtUsd(v)).join(', ')}</p>` : sz && sz.reason ? html`<p class="note warn">${sz.reason}</p>` : ''}
    <h3>Trade Plan</h3><div class="grid2">${kv('Stop Loss (' + S.stopLossPct + '%)', fmtPrice(p ? p * (1 - S.stopLossPct / 100) : null))}${kv('ATR-Stop (' + S.atrMult + '× ATR)', a14 && p ? fmtPrice(p - S.atrMult * a14) : 'ATR n/v', a14 ? 'LIVE' : 'UNKNOWN')}${kv('TP1 +' + S.tp1Pct + '% (' + Math.round(S.tp1Frac * 100) + '%)', fmtPrice(p ? p * (1 + S.tp1Pct / 100) : null))}${kv('TP2 +' + S.tp2Pct + '% (' + Math.round(S.tp2Frac * 100) + '%)', fmtPrice(p ? p * (1 + S.tp2Pct / 100) : null))}${kv('TP3 +' + S.tp3Pct + '% (Rest)', fmtPrice(p ? p * (1 + S.tp3Pct / 100) : null))}${kv('Trailing', 'ab +' + S.trailActivatePct + '%, Abstand ' + S.trailPct + '%')}${kv('Time Exit', S.timeExitMin + ' min < ' + S.timeExitMinPnlPct + '%')}${kv('Break-even nach TP1', S.breakEvenAfterTp1 ? 'ja' : 'nein')}</div>
    <h3>Liquidity Exit Test</h3><div class="grid2">${kv('Verfügbare Liquidität', fmtUsd(A.liq.usd))}${kv('Exit-Liquidität (Quote-Seite)', fmtUsd(A.liq.exitLiqUsd), 'ESTIMATED')}${kv('Erw. Exit-Slippage', exitImp != null ? (exitImp * 100).toFixed(3) + '%' : '—', 'ESTIMATED')}${kv('Exit Risk', A.liq.slipRisk)}</div>
    ${pos ? html`<p class="note info">Offene Position: ${fmtUsd(pos.costUsd)} · Entry ${fmtPrice(pos.entryPrice)} · PnL ${isNum(pos.pnlUsd) ? fmtSigned(pos.pnlUsd) : 'n/v'}</p>` : ''}
    <h3>Blocker (manuell)</h3>${ex.blockers.length ? ex.blockers.map(b => html`<div class="check"><span class="ic fail">P${b.prio}</span><div><b>${b.code}</b><small>${b.msg}</small></div></div>`) : html`<p class="ok">Keine Ausführungs-Blocker für einen manuellen Sim-Kauf (harte Regeln werden beim Kauf erneut geprüft).</p>`}
    <h3>Blocker (Auto-Bot)</h3>${autoB.length ? autoB.slice(0, 8).map(b => html`<span class="blk p${b.prio}" title="${b.msg}">${b.code}</span>`) : html`<p class="ok">Keine – Token wäre für den Bot freigegeben.</p>`}
    <div class="row" style="margin-top:10px"><button class="btn pri" data-act="buy" data-id="${t.id}">💱 Sim-Kauf vorbereiten</button></div>
    <h3>Live-Order-Precheck (Vorbereitung, derzeit nicht ausführbar)</h3>${core.preLiveChecks(t, sz && sz.size > 0 ? sz.size : 20).map(c => html`<div class="check"><span class="ic ${c.ok ? 'pass' : 'fail'}">${c.ok ? 'OK' : 'NEIN'}</span><div><b>${c.name}</b><small>${c.detail}</small></div></div>`)}
    <p class="note">Vor einer echten Order müssten alle Punkte bestehen. Route/Provider fehlt → NO TRADE im Live-Modus. Simulation bleibt davon unberührt.</p>`;
}
function tabWhy(t) {
  const A = t.A, D = t.D; if (!A) return '';
  const facts = [['Preis', fmtPrice(A.core.price), A.labels.price], ['Market Cap', fmtUsd(A.core.mc), A.labels.price], ['Liquidität', fmtUsd(A.liq.usd), A.labels.liquidity], ['Volumen 1h', fmtUsd(A.vol.h1), A.labels.volume], ['Käufer 1h', A.tx.ratio1 != null ? (A.tx.ratio1 * 100).toFixed(0) + '%' : '—', A.labels.volume], ['Security', A.sec.status, A.labels.security], ['Pair-Alter', fmtAge(A.core.pairAge), A.core.pairAge != null ? 'LIVE' : 'UNKNOWN']];
  const risks = [...(t.sec ? t.sec.flags.map(f => f.msg) : []), ...A.pump.flags, ...A.vol.anomalies, ...A.conflicts.map(c => `Datenkonflikt ${c.field} (${c.diffPct.toFixed(1)} %)`), ...Object.entries(A.risk.factors).filter(([, v]) => v != null && v >= 60).map(([k, v]) => `${RISK_NAMES[k]} ${v}`)];
  const sentence = D.decision === 'APPROVED' ? `Der Bot würde ${t.symbol} kaufen: ${D.reason}.` : D.decision === 'BUY_CANDIDATE' ? `Die Analyse für ${t.symbol} ist positiv, aber die Ausführung ist blockiert: ${D.execBlockers.slice(0, 2).map(b => b.msg).join('; ')}.` : `Der Bot handelt ${t.symbol} nicht. Wichtigste Gründe: ${D.blockers.slice(0, 3).map(b => b.msg).join('; ')}.`;
  return html`<div class="panel tight"><b>${sentence}</b>${chainHtml(core.candidateChain(t))}<p class="note">Regelbasierte Erklärung aus gemessenen Daten – keine externe KI, keine erfundenen Werte. Dies ist eine Entscheidung für diesen Token, kein globaler Bot-Block.</p></div>
    <h3>Fakten</h3><table class="tbl">${facts.map(f => html`<tr><td>${f[0]}</td><td class="num">${f[1]}</td><td>${lbl(f[2])}</td></tr>`)}</table>
    <h3>Signale</h3>${A.signals.length ? A.signals.map(s => html`<span class="sig" title="${s.reason}">${SIGNAL_NAMES[s.type]} <i>${s.strength}</i></span>`) : html`<p class="mut">keine</p>`}
    <h3>Risiken</h3>${risks.length ? html`<ul class="list-plain">${risks.map(r => html`<li>${r}</li>`)}</ul>` : html`<p class="mut">Keine auffälligen Risiken gemessen (keine Garantie).</p>`}
    <h3>Unbekannt / nicht genug Daten</h3><ul class="list-plain">${A.unknowns.map(u => html`<li class="mut">${u}</li>`)}</ul>
    <h3>Blocker (nach Priorität)</h3>${D.blockers.length ? D.blockers.map(b => html`<div class="check"><span class="ic fail">P${b.prio}</span><div><b>${b.code}</b> <span class="chip">${b.cat}</span><small>${b.msg}</small></div></div>`) : html`<p class="ok">Keine Blocker.</p>`}
    <h3>Decision Trace</h3><ul class="trace">${D.trace.map(x => html`<li><span class="ic">${x.ok === true ? '✅' : x.ok === false ? '❌' : '·'}</span><b>${x.stage}</b><span>${x.detail}</span></li>`)}</ul>
    <h3>Strategie-Stimmen</h3><div class="tw"><table class="tbl"><tr><th>Strategie</th><th>Stimme</th><th class="r">Stärke</th><th class="r">Gewicht</th><th>Begründung</th></tr>${(A.strat ? A.strat.votes : []).map(v => html`<tr><td>${v.name}${v.shadow ? html` <span class="chip vio">Shadow</span>` : ''}</td><td class="${v.vote === 'BUY' ? 'ok' : 'mut'}">${v.vote}</td><td class="r num">${v.strength}</td><td class="r num">${v.weight}</td><td class="mut">${v.why || ''}${v.reasons.length ? ' – ' + v.reasons.join('; ') : ''}</td></tr>`)}</table></div>`;
}
const TAB_RENDER = { overview: tabOverview, risk: tabRisk, plan: tabPlan, why: tabWhy };
function emptyDetail() {
  const st = core.state, pos = st.positions;
  return html`<h2>Token-Details</h2><p class="mut">Wähle einen Token im Scanner, um Chart, Scorecard, Security, Trade Plan und Decision Trace zu sehen.</p>
    <div class="grid2" style="margin-top:12px">${kv('Tokens', st.markets.size)}${kv('Kandidaten', (st.metrics.scanStats || {}).candidates || 0)}${kv('Positionen', pos.length)}${kv('Health', core.systemHealth().score)}</div>
    <h3>Letzte Alarme</h3>${st.feed.slice(0, 5).map(e => html`<div class="check"><span class="ic ${e.level === 'CRITICAL' || e.level === 'ERROR' ? 'fail' : e.level === 'WARNING' ? 'warn' : 'pass'}">${fmtTime(e.ts).slice(0, 5)}</span><div><b>${e.tag}${e.sym ? ' · ' + e.sym : ''}</b><small>${e.detail}</small></div></div>`)}${st.feed.length ? '' : html`<p class="mut">Noch keine.</p>`}`;
}
function renderDetail() {
  const box = $('detail'); if (!box) return;
  const t = selTok();
  if (!t) {
    if (box._tokenId) { box._tokenId = null; box._tab = null; box._sig = null; }
    patch(box, emptyDetail());
    box.classList.remove('open'); const bd = $('backdrop'); if (bd) bd.classList.remove('open');
    return;
  }
  if (box._tokenId !== t.id || box._tab !== UI.detailTab) {
    box._tokenId = t.id; box._tab = UI.detailTab;
    setHTML(box, html`<div id="dHead"></div><div class="tabs" role="tablist">${DETAIL_TABS.map(([k, n]) => html`<button role="tab" data-act="dtab" data-k="${k}" class="${UI.detailTab === k ? 'on' : ''}" aria-selected="${UI.detailTab === k}">${n}</button>`)}</div><div id="dBody"></div>`);
    if (UI.detailTab === 'chart') buildChartTab(t);
  }
  patch(document.getElementById('dHead'), detailHead(t));
  if (UI.detailTab === 'chart') { renderChartInfo(t); drawChart(); }
  else patch(document.getElementById('dBody'), TAB_RENDER[UI.detailTab](t));
}
function selectToken(id, openTab) {
  if (!tok(id)) { toast('WARNING', 'Token nicht mehr im Scanner', 'Er wurde evtl. aus dem Universe entfernt'); return; }
  core.select(id);
  if (openTab) UI.detailTab = openTab;
  chartState.i0 = chartState.i1 = null;
  const box = $('detail'); box._tokenId = null;
  if (window.matchMedia('(max-width:1100px)').matches) { box.classList.add('open'); $('backdrop').classList.add('open'); }
  renderDetail(); renderView();
  if (UI.chartTf !== 'live') loadOhlcv(id, UI.chartTf);
}
function closeDetail() {
  const box = $('detail'); box.classList.remove('open'); $('backdrop').classList.remove('open');
  core.select(null); renderDetail(); renderView();
}

/* ---------- Charts (Canvas, keine erfundenen Datenpunkte) ---------- */
const chartState = { i0: null, i1: null, hover: null, drag: null, loading: false, err: '' };
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }
function buildChartTab(t) {
  setHTML(document.getElementById('dBody'), html`<div class="chartctl" role="toolbar" aria-label="Chart-Steuerung">${[['live', 'Live'], ['1m', '1m'], ['5m', '5m'], ['15m', '15m']].map(([k, n]) => html`<button class="btn sm ${UI.chartTf === k ? 'on' : ''}" data-act="tf" data-k="${k}">${n}</button>`)}<span style="flex:1"></span><button class="btn sm" data-act="zoomIn" aria-label="Zoom in">＋</button><button class="btn sm" data-act="zoomOut" aria-label="Zoom out">－</button><button class="btn sm" data-act="zoomReset">Reset</button></div>
    <div class="chartbox" id="chartBox"><canvas id="chartCv" aria-label="Preischart ${t.symbol}"></canvas><div class="charttip" id="chartTip"></div></div><div class="note" id="chartInfo"></div>`);
  const cv = document.getElementById('chartCv');
  cv.addEventListener('wheel', e => { e.preventDefault(); zoomChart(e.deltaY < 0 ? 0.8 : 1.25); }, { passive: false });
  cv.addEventListener('pointerdown', e => { chartState.drag = { x: e.clientX, i0: chartState.i0, i1: chartState.i1 }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(); chartState.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (chartState.drag && e.pointerType === 'mouse' ? e.buttons === 1 : chartState.drag) {
      const d = chartData(selTok()); const n = d.pts.length; if (n > 2 && chartState.lastVis) {
        const per = (r.width - 70) / chartState.lastVis.len; const shift = Math.round((chartState.drag.x - e.clientX) / per);
        const len = chartState.lastVis.len; let i1 = (chartState.drag.i1 == null ? n - 1 : chartState.drag.i1) + shift; i1 = clamp(i1, len - 1, n - 1);
        chartState.i1 = i1 >= n - 1 ? null : i1; chartState.i0 = i1 - len + 1;
      }
    }
    drawChart();
  });
  const end = () => { chartState.drag = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { chartState.hover = null; chartState.drag = null; drawChart(); });
}
function chartData(t) {
  if (!t) return { kind: 'line', pts: [] };
  if (UI.chartTf === 'live') return { kind: 'line', pts: t.hist.map(h => ({ t: h.t, o: h.p, h: h.p, l: h.p, c: h.p, v: null })), src: 'Live-Samples aus DexScreener (~5 s, nur während die App läuft)', label: 'LIVE' };
  const oh = t.ohlcv[UI.chartTf];
  if (!oh) return { kind: 'candle', pts: [], src: chartState.loading ? 'GeckoTerminal OHLCV wird geladen …' : chartState.err || 'Keine OHLCV-Daten geladen' };
  return { kind: 'candle', pts: oh.candles, src: `GeckoTerminal OHLCV ${UI.chartTf} · Stand ${fmtTime(oh.fetchedAt)}`, label: Date.now() - oh.fetchedAt < 2 * MIN ? 'LIVE' : 'STALE' };
}
function positionLines(t) {
  const p = core.state.positions.find(x => x.tokenId === t.id); if (!p) return [];
  const L = [{ v: p.entryPrice, label: 'Entry', c: cssVar('--cyan') }, { v: p.stop, label: p.stopType === 'TRAILING' ? 'Trailing' : 'Stop', c: cssVar('--red') }];
  p.tps.forEach((v, i) => { if (!p.tpHit[i]) L.push({ v, label: 'TP' + (i + 1), c: cssVar('--green') }); });
  return L.filter(x => isNum(x.v));
}
async function loadOhlcv(id, tf) {
  chartState.loading = true; chartState.err = '';
  try { await core.fetchOhlcv(id, tf); } catch (e) { chartState.err = 'OHLCV nicht verfügbar: ' + e.message; }
  finally { chartState.loading = false; if (core.state.selected === id) { renderChartInfo(tok(id)); drawChart(); } }
}
function renderChartInfo(t) {
  const d = chartData(t);
  patch(document.getElementById('chartInfo'), html`${d.label ? lbl(d.label) : ''} ${d.src || ''} · ${d.pts.length} Punkte${d.kind === 'candle' ? ' · EMA 9/21, Volumen' : ' · EMA 9/21'}${positionLines(t).length ? ' · Entry/Stop/TP-Linien' : ''} · Mausrad/＋－ zoomen, ziehen verschiebt.`);
}
function zoomChart(f) {
  const d = chartData(selTok()); const n = d.pts.length; if (n < 3) return;
  const i1 = chartState.i1 == null ? n - 1 : chartState.i1; const i0 = chartState.i0 == null ? Math.max(0, n - 120) : chartState.i0;
  const len = clamp(Math.round((i1 - i0 + 1) * f), 8, n);
  chartState.i0 = Math.max(0, i1 - len + 1); chartState.i1 = chartState.i1 == null ? null : i1;
  drawChart();
}
function drawChart() {
  const cv = document.getElementById('chartCv'), t = selTok(); if (!cv || !t) return;
  const d = chartData(t), n = d.pts.length;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const muted = cssVar('--muted'), grid = '#ffffff12', tip = document.getElementById('chartTip');
  if (n < 2) { c.fillStyle = muted; c.font = '13px system-ui,sans-serif'; c.textAlign = 'center'; c.fillText(n ? 'Zu wenige Datenpunkte' : 'Keine Chartdaten – es werden keine Punkte erfunden', w / 2, h / 2); if (tip) tip.style.display = 'none'; return; }
  let i1 = chartState.i1 == null ? n - 1 : Math.min(chartState.i1, n - 1);
  let i0 = chartState.i0 == null ? Math.max(0, n - 120) : clamp(chartState.i0, 0, i1);
  if (i1 - i0 < 4) i0 = Math.max(0, i1 - 4);
  const vis = d.pts.slice(i0, i1 + 1); chartState.lastVis = { len: vis.length };
  const closes = d.pts.map(p => p.c), e9 = emaSeries(closes, 9).slice(i0, i1 + 1), e21 = emaSeries(closes, 21).slice(i0, i1 + 1);
  const padR = 66, volH = d.kind === 'candle' ? 36 : 0, padT = 8, padB = 16 + volH;
  const plotW = w - padR - 4, plotH = h - padT - padB;
  let lo = Math.min(...vis.map(p => p.l)), hi = Math.max(...vis.map(p => p.h));
  const lines = positionLines(t);
  for (const L of lines) if (L.v > lo / 2 && L.v < hi * 2) { lo = Math.min(lo, L.v); hi = Math.max(hi, L.v); }
  const pv = (hi - lo) * 0.06 || hi * 0.01 || 1e-12; lo -= pv; hi += pv;
  const step = plotW / vis.length;
  const X = i => 4 + (i + 0.5) * step, Y = v => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  c.font = '10px ui-monospace,monospace'; c.textAlign = 'left'; c.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4, y = Y(v); c.strokeStyle = grid; c.beginPath(); c.moveTo(4, y); c.lineTo(4 + plotW, y); c.stroke(); c.fillStyle = muted; c.fillText(fmtPrice(v), 8 + plotW, y); }
  if (volH) { const vm = Math.max(...vis.map(p => p.v || 0)) || 1; vis.forEach((p, i) => { const bh = (p.v || 0) / vm * (volH - 6); c.fillStyle = p.c >= p.o ? '#22e58f44' : '#ff547044'; c.fillRect(X(i) - step * 0.35, h - 14 - bh, Math.max(1, step * 0.7), bh); }); }
  if (d.kind === 'candle') {
    vis.forEach((p, i) => { const up = p.c >= p.o; c.strokeStyle = c.fillStyle = up ? '#22e58f' : '#ff5470'; c.beginPath(); c.moveTo(X(i), Y(p.h)); c.lineTo(X(i), Y(p.l)); c.stroke(); const y1 = Y(Math.max(p.o, p.c)), y2 = Y(Math.min(p.o, p.c)); c.fillRect(X(i) - Math.max(1, step * 0.33), y1, Math.max(2, step * 0.66), Math.max(1, y2 - y1)); });
  } else {
    c.strokeStyle = cssVar('--cyan'); c.lineWidth = 1.6; c.beginPath(); vis.forEach((p, i) => (i ? c.lineTo(X(i), Y(p.c)) : c.moveTo(X(i), Y(p.c)))); c.stroke(); c.lineWidth = 1;
  }
  const drawEma = (arrE, col) => { c.strokeStyle = col; c.beginPath(); let s = false; arrE.forEach((v, i) => { if (v == null) return; if (!s) { c.moveTo(X(i), Y(v)); s = true; } else c.lineTo(X(i), Y(v)); }); c.stroke(); };
  drawEma(e9, '#fbbf24aa'); drawEma(e21, '#a78bfaaa');
  c.setLineDash([5, 4]);
  for (const L of lines) { if (L.v < lo || L.v > hi) continue; const y = Y(L.v); c.strokeStyle = L.c; c.beginPath(); c.moveTo(4, y); c.lineTo(4 + plotW, y); c.stroke(); c.fillStyle = L.c; c.fillText(L.label, 6, y - 7); }
  c.setLineDash([]);
  c.fillStyle = muted; c.textAlign = 'left'; c.fillText(fmtTime(vis[0].t), 4, h - 6); c.textAlign = 'right'; c.fillText(fmtTime(vis[vis.length - 1].t), 4 + plotW, h - 6);
  const hv = chartState.hover;
  if (hv && hv.x >= 4 && hv.x <= 4 + plotW && tip) {
    const i = clamp(Math.floor((hv.x - 4) / step), 0, vis.length - 1), p = vis[i];
    c.strokeStyle = '#ffffff44'; c.beginPath(); c.moveTo(X(i), padT); c.lineTo(X(i), h - 14); c.stroke();
    tip.style.display = 'block';
    setHTML(tip, d.kind === 'candle' ? html`${fmtDateTime(p.t)}<br>O ${fmtPrice(p.o)} H ${fmtPrice(p.h)}<br>L ${fmtPrice(p.l)} C ${fmtPrice(p.c)}<br>Vol ${fmtUsd(p.v)}` : html`${fmtTime(p.t)}<br>${fmtPrice(p.c)}`);
    tip.style.left = Math.min(w - 150, Math.max(4, X(i) + 10)) + 'px'; tip.style.top = '8px';
  } else if (tip) tip.style.display = 'none';
}
/* Kleine Linien-Charts (Analytics, Risk, API, Scanner, Backtest) */
function drawSeries(cv, series, o = {}) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const muted = cssVar('--muted'); c.font = '10px ui-monospace,monospace';
  const pts = series.flatMap(s => s.pts).filter(p => isNum(p.v) && isNum(p.t));
  if (pts.length < 2) { c.fillStyle = muted; c.font = '12px system-ui,sans-serif'; c.textAlign = 'center'; c.fillText(o.empty || 'Noch nicht genug Daten', w / 2, h / 2); return; }
  const t0 = Math.min(...pts.map(p => p.t)), t1 = Math.max(...pts.map(p => p.t));
  let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
  if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi === lo) { hi += Math.abs(hi) * 0.05 || 1; lo -= Math.abs(lo) * 0.05 || 1; }
  const pl = 4, pr = 62, pt = 16, pb = 16, W = w - pl - pr, Hh = h - pt - pb;
  const X = t => pl + (t1 === t0 ? W / 2 : (t - t0) / (t1 - t0) * W), Y = v => pt + (1 - (v - lo) / (hi - lo)) * Hh;
  c.textBaseline = 'middle';
  for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3, y = Y(v); c.strokeStyle = '#ffffff10'; c.beginPath(); c.moveTo(pl, y); c.lineTo(pl + W, y); c.stroke(); c.fillStyle = muted; c.textAlign = 'left'; c.fillText((o.fmt || (x => x.toFixed(1)))(v), pl + W + 4, y); }
  if (o.zero && lo < 0 && hi > 0) { c.strokeStyle = '#ffffff40'; c.beginPath(); c.moveTo(pl, Y(0)); c.lineTo(pl + W, Y(0)); c.stroke(); }
  let lx = pl;
  for (const s of series) {
    const p = s.pts.filter(q => isNum(q.v)); c.strokeStyle = s.color; c.lineWidth = 1.6; c.beginPath();
    p.forEach((q, i) => (i ? c.lineTo(X(q.t), Y(q.v)) : c.moveTo(X(q.t), Y(q.v)))); c.stroke(); c.lineWidth = 1;
    c.fillStyle = s.color; c.textAlign = 'left'; c.fillText('● ' + s.label, lx, 7); lx += c.measureText('● ' + s.label).width + 12;
  }
  c.fillStyle = muted; c.textAlign = 'left'; c.fillText(fmtTime(t0), pl, h - 6); c.textAlign = 'right'; c.fillText(fmtTime(t1), pl + W, h - 6);
}
const PALETTE = ['#38bdf8', '#f472b6', '#22e58f', '#fbbf24', '#a78bfa', '#fb923c', '#60a5fa'];
const CHARTS = {
  equity: () => [[{ label: 'Equity (SIMULATED)', color: '#38bdf8', pts: core.state.hist.equity.map(p => ({ t: p.t, v: p.v })) }], { fmt: v => fmtUsd(v, 0), empty: 'Noch keine Equity-Historie' }],
  risk: () => [[{ label: 'Exposure %', color: '#38bdf8', pts: core.state.hist.risk.map(p => ({ t: p.t, v: p.exposurePct })) }, { label: 'Drawdown %', color: '#ff5470', pts: core.state.hist.risk.map(p => ({ t: p.t, v: p.ddPct })) }, { label: 'Portfolio Risk', color: '#fbbf24', pts: core.state.hist.risk.map(p => ({ t: p.t, v: p.risk })) }], { zero: true }],
  apiLat: () => { const names = [...new Set(core.state.hist.api.flatMap(p => Object.keys(p.apis)))]; return [names.map((n, i) => ({ label: (core.http.sources[n] ? core.http.sources[n].cfg.label : n).replace('DexScreener', 'Dex'), color: PALETTE[i % PALETTE.length], pts: core.state.hist.api.map(p => ({ t: p.t, v: p.apis[n] ? p.apis[n].lat : null })) })), { fmt: v => Math.round(v) + 'ms', empty: 'Daten nach ~1 Minute' }]; },
  apiFail: () => { const names = [...new Set(core.state.hist.api.flatMap(p => Object.keys(p.apis)))]; return [names.map((n, i) => ({ label: (core.http.sources[n] ? core.http.sources[n].cfg.label : n).replace('DexScreener', 'Dex'), color: PALETTE[i % PALETTE.length], pts: core.state.hist.api.map(p => ({ t: p.t, v: p.apis[n] && p.apis[n].fail != null ? p.apis[n].fail * 100 : null })) })), { zero: true, fmt: v => v.toFixed(0) + '%', empty: 'Daten nach ~1 Minute' }]; },
  scanner: () => [[['candidates', 'Kandidaten', '#38bdf8'], ['accepted', 'Approved', '#22e58f'], ['rejected', 'Rejected', '#ff5470'], ['executed', 'Executed', '#fbbf24']].map(([k, l, col]) => ({ label: l, color: col, pts: core.state.hist.scanner.map(p => ({ t: p.t, v: p[k] })) })), { zero: true, empty: 'Daten nach ~1 Minute' }],
  bt: () => { const r = UI.bt; const curve = r && (r.wf ? r.wf.testCurve : r.res && r.res.curve) || []; return [[{ label: 'Equity (Backtest)', color: '#a78bfa', pts: curve.map(p => ({ t: p.t, v: p.v })) }], { fmt: v => fmtUsd(v, 0) }]; }
};
function drawCharts(root) { (root || document).querySelectorAll('canvas[data-chart]').forEach(cv => { const f = CHARTS[cv.dataset.chart]; if (f) { try { const [s, o] = f(); drawSeries(cv, s, o); } catch (e) { core.log.warn('UI', 'Chart-Fehler: ' + e.message); } } }); }

/* ---------- Render-Steuerung (DOM Batching, nur geänderte Bereiche) ---------- */
const VIEW_RENDER = { system: renderSystem, scanner: renderScanner, signals: renderSignals, markets: renderMarkets, watchlist: renderWatchlist, positions: renderPositions, orders: renderOrders, history: renderHistory, backtest: renderBacktest, analytics: renderAnalytics, risk: renderRisk, alerts: renderAlerts, diagnostics: renderDiagnostics, logs: renderLogs, settings: renderSettings, knowledge: renderKnowledge };
const STATIC_VIEWS = new Set(['settings', 'backtest', 'knowledge']);
const LIVE_INPUTS = new Set(['q', 'hq', 'lq', 'kbq']);
function renderView(force) {
  const v = UI.view, sec = document.getElementById('v-' + v); if (!sec || !VIEW_RENDER[v]) return;
  if (!force && STATIC_VIEWS.has(v)) return;
  const ae = document.activeElement;
  if (!force && ae && sec.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && !LIVE_INPUTS.has(ae.id)) return;
  VIEW_RENDER[v](sec);
}
let renderQueued = false, lastRender = 0;
function scheduleRender(force) {
  if (renderQueued) return;
  renderQueued = true;
  const wait = force ? 0 : Math.max(0, 800 - (performance.now() - lastRender));
  setTimeout(() => requestAnimationFrame(() => { renderQueued = false; renderAll(force); }), wait);
}
function renderAll(force) {
  if (!force && Date.now() - UI.lastTouch < 900) { scheduleRender(); return; } // keine Re-Renders während Tippen/Klicken
  const t0 = performance.now();
  try { renderTop(); renderControl(); renderTiles(); renderNav(); renderView(); renderDetail(); }
  catch (e) { core.log.error('UI', 'Render-Fehler: ' + e.message); if (window.console) console.error(e); }
  lastRender = performance.now();
  core.state.metrics.perf.render = Math.round(lastRender - t0);
}
core.on('scan', () => scheduleRender());
core.on('trade', () => scheduleRender(true));
core.on('bot', () => scheduleRender(true));
core.on('settings', () => scheduleRender());

/* ---------- Kontextmenü ---------- */
function openCtx(id, anchor) {
  const t = tok(id); if (!t) return;
  const m = $('ctx'), w = !!core.state.watchlist[id], pair = (t.A && t.A.core.pairAddress) || null, pr = t.A && (t.A.core.priceRaw || (isNum(t.A.core.price) ? String(t.A.core.price) : null));
  setHTML(m, html`<button role="menuitem" data-act="star" data-id="${id}">${w ? '★ Von Watchlist entfernen' : '☆ Zur Watchlist'}</button>
    <button role="menuitem" data-act="select" data-id="${id}">🔍 Analysieren / Details</button>
    <button role="menuitem" data-act="buy" data-id="${id}">💱 Simulate Buy</button><hr>
    <button role="menuitem" data-act="copy" data-v="${t.mint}" data-l="Mint">⧉ Copy Mint</button>
    ${pair ? html`<button role="menuitem" data-act="copy" data-v="${pair}" data-l="Pair">⧉ Copy Pair</button>` : ''}
    ${pr ? html`<button role="menuitem" data-act="copy" data-v="${pr}" data-l="Preis">⧉ Copy Price</button>` : ''}<hr>
    ${tokenLinks(t).slice(0, 9).map(([n, u]) => html`<a role="menuitem" href="${u}" target="_blank" rel="noopener noreferrer">↗ ${n}</a>`)}`);
  m.hidden = false;
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = clamp(r.right - mw, 8, window.innerWidth - mw - 8) + 'px';
  m.style.top = (r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  const first = m.querySelector('button'); if (first) first.focus();
}
function closeCtx() { const m = document.getElementById('ctx'); if (m && !m.hidden) m.hidden = true; }

/* ---------- Manueller Sim-Kauf: Execution Preview + Bestätigung + Receipt ---------- */
function buyPreviewHtml(t, size) {
  const S = core.S();
  const ex = core.execCheck(t, { auto: false, preTrade: false, sizeUsd: size });
  const sz = ex.sizing || {}, A = t.A;
  return html`<div class="grid2">${kv('Token', t.symbol)}${kv('Seite', 'BUY #' + ((core.state.risk.buyCount[t.id] || 0) + 1) + ' / ' + Math.min(S.maxBuysPerCoin, 2))}${kv('Modus', core.state.mode, 'SIMULATED')}${kv('Geschätzter Preis', fmtPrice(A.core.price), A.label)}${kv('Erw. Price Impact', isNum(sz.impactPct) ? sz.impactPct.toFixed(3) + '%' : '—', 'ESTIMATED')}${kv('Max. Price Impact', S.maxSlippagePct + '%')}${kv('Gebühren', sz.fees ? fmtUsd(sz.fees.total, 4) : '—', 'ESTIMATED')}${kv('Risk / Confidence', A.risk.level + ' ' + A.risk.total + ' / ' + A.confidence.total + '%')}</div>
    ${ex.blockers.length ? html`<h3>Blocker</h3>${ex.blockers.map(b => html`<div class="check"><span class="ic fail">P${b.prio}</span><div><b>${b.code}</b><small>${b.msg}</small></div></div>`)}` : html`<p class="ok">Vorabprüfung ok. Beim Bestätigen werden Daten frisch geladen und alle harten Regeln erneut geprüft (Pre-Trade-Check).</p>`}
    <p class="note">Simulation: keine echte Order, keine Transaktion. Füllung zum Live-Preis + geschätztem Impact, Gebühren geschätzt.</p>`;
}
let buyModalToken = null;
async function openBuy(id) {
  buyModalToken = id;
  try { await openBuyInner(id); } finally { buyModalToken = null; }
}
async function openBuyInner(id) {
  const t = tok(id); if (!t || !t.A) { toast('WARNING', 'Keine Analyse vorhanden', 'Warte auf Marktdaten'); return; }
  if (core.state.mode === 'READ_ONLY') { toast('WARNING', 'READ ONLY aktiv', 'Handel ist in diesem Modus deaktiviert'); return; }
  const eq = core.equityInfo(), S = core.S();
  const sugg = core.execCheck(t, { auto: false, preTrade: false }).sizing;
  const def = sugg && sugg.size > 0 ? sugg.size : m2(Math.min(eq.equity * S.maxPositionPct / 100, eq.equity * 0.02));
  const r = await openModal({
    title: `Simulate Buy · ${t.symbol}`,
    body: html`<label class="fld">Betrag in USD (max. ${fmtUsd(eq.equity * S.maxPositionPct / 100)})<input id="buySize" type="number" min="${MIN_ORDER_USD}" step="any" value="${def}" inputmode="decimal"></label><div id="buyPrev" style="margin-top:10px">${buyPreviewHtml(t, def)}</div>`,
    actions: [{ id: 'cancel', label: 'Abbrechen' }, { id: 'ok', label: '✓ Sim-Kauf bestätigen', cls: 'pri' }],
    collect: () => Number((document.getElementById('buySize') || {}).value)
  });
  if (r.id !== 'ok') return;
  const size = r.data;
  if (!Number.isFinite(size) || size <= 0) { toast('WARNING', 'Ungültiger Betrag'); return; }
  toast('INFO', 'Pre-Trade-Check läuft …', t.symbol);
  const res = await core.executeBuy(id, { sizeUsd: size, reason: 'Manueller Sim-Kauf (Nutzer)' });
  if (res.ok) receiptModal(res.order);
  else toast('ERROR', 'Kauf abgelehnt', res.blockers ? res.blockers.slice(0, 3).map(b => b.code).join(', ') : res.error);
  scheduleRender(true);
}
function receiptModal(o) {
  openModal({ title: 'Order Receipt (SIMULATED)', body: html`<div class="grid2">${kv('Order ID', o.id)}${kv('Status', o.state)}${kv('Token', o.symbol)}${kv('Seite', o.side)}${kv('Füllpreis', fmtPrice(o.fillPrice), 'SIMULATED')}${kv('Größe', fmtUsd(o.sizeUsd))}${kv('Menge', fmtNum(o.qty, 2))}${kv('Fees', o.fees ? fmtUsd(o.fees.total, 4) : '—', 'ESTIMATED')}${kv('Zeit', fmtDateTime(o.history[o.history.length - 1].ts))}${kv('Transaktion', 'keine – Simulation')}</div><p class="note">Kein Explorer-Link: es existiert keine echte Transaktions-Signatur.</p>` });
}
async function openSell(posId, frac) {
  const p = core.state.positions.find(x => x.id === posId); if (!p) return;
  const qty = frac === 'ALL' ? p.qty : Math.min(p.qty, p.initialQty * frac);
  const t = tok(p.tokenId), liq = t && t.A ? t.A.liq.usd : null, gross = isNum(p.lastPrice) ? qty * p.lastPrice : null;
  const imp = gross != null ? core.estImpact(gross, liq) : null, fees = gross != null ? core.estFees(gross) : null;
  const net = gross != null && imp != null && fees ? gross * (1 - imp) - fees.total : null;
  const ok = await confirmDialog(`Verkaufen · ${p.symbol} (${frac === 'ALL' ? '100' : Math.round(frac * 100)} %)`, 'Simulierter Verkauf mit frischem Preis (Pre-Exit-Check).', {
    confirmLabel: 'Verkaufen', danger: true,
    extra: html`<div class="grid2">${kv('Menge', fmtNum(qty, 2))}${kv('Preis', fmtPrice(p.lastPrice), p.priceLabel)}${kv('Erw. Erlös netto', net != null ? fmtUsd(net) : 'n/v', 'ESTIMATED')}${kv('Price Impact', imp != null ? (imp * 100).toFixed(3) + '%' : 'n/v', 'ESTIMATED')}</div>`
  });
  if (!ok) return;
  const r = await core.executeSell(posId, frac, 'MANUAL', { detail: 'Manueller Verkauf' });
  if (r.ok) receiptModal(r.order); else toast('ERROR', 'Verkauf nicht ausgeführt', r.blockers ? r.blockers.map(b => b.msg).join('; ') : r.error);
  scheduleRender(true);
}

/* ---------- Aktionen (zentraler, einmalig registrierter Event-Handler) ---------- */
const ACTIONS = {
  view: el => { const v = el.dataset.view; if (v === 'more') return ACTIONS.more(); showView(v, true); },
  more: () => {
    const ms = masterStatus(), h = core.systemHealth(), dex = core.http.status('dexPairs');
    return openModal({ title: 'Mehr', body: html`<div class="ctl-top"><span class="mstat ${ms.state}">${ms.text}</span><div class="ctl-why">${ms.why}</div></div>
      <p class="note">Health ${h.score} · DexScreener ${dex} · RPC ${bestRpcStatus()} · RugCheck ${core.http.status('rugcheck')}</p>
      ${NAV_GROUPS.map(([g, ids]) => html`<div class="navgrp"><h3>${g}</h3><div class="grid2">${ids.map(id => { const v = VIEWS.find(x => x[0] === id); return html`<button class="btn" data-act="navgo" data-view="${id}">${v[1]} ${v[2]}</button>`; })}</div></div>`)}` });
  },
  navgo: el => { closeModal(null); showView(el.dataset.view, true); },
  select: el => { closeCtx(); if (el.dataset.id) selectToken(el.dataset.id); },
  star: el => { const id = el.dataset.id; closeCtx(); if (core.state.watchlist[id]) { core.removeWatch(id); toast('INFO', 'Von Watchlist entfernt'); } else { const r = core.addWatch(id); toast(r.ok ? 'SUCCESS' : 'ERROR', r.ok ? 'Zur Watchlist hinzugefügt ★' : r.error); } scheduleRender(true); },
  ctx: el => { const m = document.getElementById('ctx'); if (!m.hidden && m._for === el) { closeCtx(); return; } m._for = el; openCtx(el.dataset.id, el); },
  copy: el => { closeCtx(); copyText(el.dataset.v, el.dataset.l ? el.dataset.l + ' kopiert' : 'Kopiert'); },
  closeDetail: () => closeDetail(),
  dtab: el => { UI.detailTab = el.dataset.k; saveUi(); renderDetail(); const t = selTok(); if (UI.detailTab === 'chart' && t && UI.chartTf !== 'live') loadOhlcv(t.id, UI.chartTf); },
  tf: el => { UI.chartTf = el.dataset.k; saveUi(); chartState.i0 = chartState.i1 = null; const t = selTok(); const box = $('detail'); box._tokenId = null; renderDetail(); if (t && UI.chartTf !== 'live') loadOhlcv(t.id, UI.chartTf); },
  zoomIn: () => zoomChart(0.7), zoomOut: () => zoomChart(1.4), zoomReset: () => { chartState.i0 = chartState.i1 = null; drawChart(); },
  sort: el => { const k = el.dataset.k; if (UI.sort === k) UI.dir = -UI.dir; else { UI.sort = k; UI.dir = k === 'age' || k === 'risk' ? 1 : -1; } saveUi(); renderScanner(); },
  rank: el => { UI.rankBy = el.dataset.k; saveUi(); renderView(true); },
  start: () => { const r = core.start(); toast(r.ok ? 'SUCCESS' : 'ERROR', r.ok ? 'Bot gestartet' : r.error, r.ok ? 'Recovery → Running, sobald Datenqualität ausreicht' : ''); scheduleRender(true); },
  pause: () => { core.pause(); toast('INFO', 'Bot pausiert', 'Scanner & Exits laufen weiter, keine neuen Auto-Trades'); scheduleRender(true); },
  stop: async () => { if (core.state.positions.length && !(await confirmDialog('Bot stoppen?', `${core.state.positions.length} offene Position(en) werden bei gestopptem Bot nicht überwacht (keine Stops/TPs).`, { danger: true, confirmLabel: 'Stoppen' }))) return; core.stop(); toast('WARNING', 'Bot gestoppt', 'Scanner aus, Timer gelöscht, Requests abgebrochen'); scheduleRender(true); },
  safe: () => { core.setSafeMode(!core.state.bot.safeMode); toast('INFO', 'Safe Mode ' + (core.state.bot.safeMode ? 'AN' : 'AUS')); scheduleRender(true); },
  mode: el => { const r = core.setMode(el.dataset.mode); toast(r.ok ? 'INFO' : 'ERROR', r.ok ? 'Modus: ' + el.dataset.mode.replace('_', ' ') : r.error); scheduleRender(true); },
  live: async () => {
    const lr = core.liveReadiness();
    const r = await openModal({ title: 'LIVE-Gating', body: html`<p>LIVE muss separat und ausdrücklich aktiviert werden. <b>Auto-Trading bedeutet nie Echtgeldhandel.</b> Alle Voraussetzungen müssen erfüllt sein:</p>
      ${lr.checks.map(c => html`<div class="check"><span class="ic ${c.ok ? 'pass' : 'fail'}">${c.ok ? 'OK' : 'FEHLT'}</span><div><b>${c.name}</b><small>${c.detail}</small></div></div>`)}
      <p class="note">${lr.ready ? 'Alle Voraussetzungen erfüllt.' : 'LIVE ist derzeit nicht aktivierbar (REQUIRES EXTERNAL PROVIDER). Es wird keine Funktion vorgetäuscht. Private Keys oder Seeds werden nie verarbeitet.'}</p>
      <label class="fld" style="margin-top:8px">Zur ausdrücklichen Bestätigung „LIVE“ eingeben<input id="liveConfirm" autocomplete="off" ${lr.ready ? '' : raw('disabled')}></label>`,
      actions: [{ id: 'close', label: 'Schließen' }, { id: 'wallet', label: 'Wallet verbinden (lesend)' }, { id: 'go', label: 'LIVE aktivieren', cls: 'bad', disabled: !lr.ready }],
      collect: () => (document.getElementById('liveConfirm') || {}).value });
    if (r.id === 'wallet') { await ACTIONS.wallet(); return; }
    if (r.id === 'go') { if ((r.data || '').trim() !== 'LIVE') { toast('WARNING', 'Nicht bestätigt'); return; } const res = core.setMode('LIVE'); toast(res.ok ? 'CRITICAL' : 'ERROR', res.ok ? 'LIVE aktiv' : res.error); }
  },
  walletModal: () => openModal({ title: 'Wallet', body: walletPanel() }),
  reconcile: async () => {
    const rc = core.state.reconciliation;
    const r = await openModal({ title: 'Abgleich (Reconciliation)', body: html`<p>Nach dem Neustart wurden Punkte gefunden, die nicht eindeutig waren. Sie wurden konservativ aufgelöst (keine Füllung ohne Nachweis, Buy-Zähler nie gesenkt). Bitte prüfen und bestätigen – bis dahin sind neue Käufe blockiert, Exits laufen weiter.</p><ul class="list-plain">${rc.issues.map(x => html`<li>${x}</li>`)}</ul>`, actions: [{ id: 'close', label: 'Später' }, { id: 'ack', label: 'Geprüft – bestätigen', cls: 'pri' }] });
    if (r.id === 'ack') { core.ackReconciliation(); toast('SUCCESS', 'Abgleich bestätigt'); scheduleRender(true); }
  },
  auto: async () => {
    const b = core.state.bot;
    if (b.autoTrading) { core.setAutoTrading(false); toast('INFO', 'Auto-Trading AUS'); scheduleRender(true); return; }
    const S = core.S();
    if (!(await confirmDialog('Auto-Trading aktivieren?', `Der Bot führt im Modus ${core.state.mode} virtuelle Trades mit echten Marktdaten aus. Auto-Trading bedeutet nie Echtgeldhandel – LIVE ist separat gesperrt.`, { confirmLabel: 'Aktivieren', extra: html`<ul class="list-plain"><li>Max. ${Math.min(S.maxBuysPerCoin, 2)} Käufe pro Coin, Nachkauf nur im Gewinn</li><li>Max. ${S.maxOpenPositions} Positionen, Exposure ≤ ${S.maxExposurePct} %, Position ≤ ${S.maxPositionPct} %</li><li>Cooldowns: ${S.sellCooldownMin} min nach Verkauf, ${S.lossCooldownMin} min nach Verlust, Pause nach ${S.lossStreakLimit} Verlusten</li><li>Tagesverlust-Limit ${S.dailyLossLimitPct} % → Auto-Trading aus</li></ul>` }))) return;
    const r = core.setAutoTrading(true); toast(r.ok ? 'SUCCESS' : 'ERROR', r.ok ? 'Auto-Trading AN (SIMULATION)' : r.error); scheduleRender(true);
  },
  estop: async () => {
    if (!core.state.bot.emergency) { await core.emergencyStop('Manuell ausgelöst'); scheduleRender(true); return; }
    if (await confirmDialog('Emergency Stop freigeben?', 'Der Bot geht in PAUSED. Auto-Trades starten erst nach START und nur, wenn alle Checks bestehen.', { confirmLabel: 'Freigeben', danger: true })) { core.releaseEmergency(); toast('WARNING', 'Emergency Stop freigegeben', 'Bot ist PAUSED'); scheduleRender(true); }
  },
  notify: async () => { unlockAudio(); if (!('Notification' in window)) { toast('WARNING', 'Browser-Benachrichtigungen nicht unterstützt', 'iPhone: nur als Home-Bildschirm-App mit Service Worker'); updateNotifyBtn(); return; } try { await Notification.requestPermission(); } catch (e) { /* */ } updateNotifyBtn(); },
  buy: el => { closeCtx(); openBuy(el.dataset.id); },
  sell: el => openSell(el.dataset.id, el.dataset.frac === 'ALL' ? 'ALL' : Number(el.dataset.frac)),
  order: el => orderModal(el.dataset.id),
  trade: el => tradeModal(el.dataset.id),
  analyze: el => { const t = tok(el.dataset.id); if (!t) return; core.enqueueSecurity(t, 5000, true); if (UI.chartTf !== 'live') loadOhlcv(t.id, UI.chartTf); toast('INFO', 'Analyse angestoßen', 'Security & Chart werden neu geladen'); },
  secRecheck: el => ACTIONS.analyze(el),
  profile: el => { const r = core.updateSettings(PROFILES[el.dataset.p], 'PROFILE:' + el.dataset.p); toast('INFO', 'Profil ' + el.dataset.p + ' angewendet', r.errors.filter(e => !e.soft).map(e => e.msg).join('; ')); renderFilterForm(); renderView(true); },
  rollback: async el => { const v = +el.dataset.v; if (await confirmDialog('Parameter-Version aktivieren?', `Version v${v} wird aktiviert (nur tunebare Parameter).`)) { core.rollbackTo(v); renderView(true); } },
  newSession: async () => { if (await confirmDialog('Neue Trading Session?', 'Session-Statistiken werden abgeschlossen. Buy-Zähler werden nur für Tokens ohne offene Position zurückgesetzt (Regel in Einstellungen). Cooldowns bleiben aktiv.')) { const r = core.newSession(); toast('SUCCESS', 'Neue Session gestartet', r.reset + ' Buy-Zähler zurückgesetzt'); renderView(true); } },
  resetPortfolio: async () => { if (await confirmDialog('Sim-Portfolio zurücksetzen?', `Cash wird auf das Startkapital (${fmtUsd(core.S().simCapitalUsd)}) gesetzt. Nur ohne offene Positionen möglich. Journal bleibt erhalten.`, { danger: true })) { const r = core.resetPortfolio(); toast(r.ok ? 'SUCCESS' : 'ERROR', r.ok ? 'Portfolio zurückgesetzt' : r.error); renderView(true); } },
  resetSettings: async () => { if (await confirmDialog('Einstellungen zurücksetzen?', 'Alle Einstellungen und Strategien werden auf sichere Defaults gesetzt (Journal, Watchlist und Positionen bleiben).', { danger: true })) { core.resetSettings(); toast('SUCCESS', 'Einstellungen zurückgesetzt'); renderView(true); renderFilterForm(); } },
  factoryReset: async () => { if (await confirmDialog('Factory Reset', 'Löscht ALLE lokalen Daten (Einstellungen, Watchlist, Journal, Positionen, Logs). Nicht umkehrbar.', { danger: true, requireText: 'RESET', confirmLabel: 'Alles löschen' })) { core.factoryReset(); location.reload(); } },
  export: el => { try { const f = core.exportData(el.dataset.kind); download(f.name, f.mime, f.data); toast('SUCCESS', 'Export erstellt', f.name); } catch (e) { toast('ERROR', 'Export fehlgeschlagen', e.message); } },
  importSettings: () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; if (!f) return; if (f.size > 2e6) { toast('ERROR', 'Datei zu groß'); return; } const rd = new FileReader(); rd.onload = () => { const r = core.importSettings(String(rd.result)); toast(r.ok ? 'SUCCESS' : 'ERROR', r.ok ? `Import ok (${r.watchlist} Watchlist-Einträge)` : 'Import fehlgeschlagen', r.errors.filter(e => !e.soft).map(e => e.msg).slice(0, 3).join('; ')); renderView(true); }; rd.onerror = () => toast('ERROR', 'Datei nicht lesbar'); rd.readAsText(f); }, { once: true });
    inp.click();
  },
  runTests: async () => { if (UI.testsRunning) return; UI.testsRunning = true; UI.tests = null; renderView(true); try { UI.tests = await runSelfTests(); const ok = UI.tests.filter(x => x.ok).length; core.log[ok === UI.tests.length ? 'success' : 'error']('SYSTEM', `Selbsttest: ${ok}/${UI.tests.length} bestanden`); toast(ok === UI.tests.length ? 'SUCCESS' : 'ERROR', `Selbsttest: ${ok}/${UI.tests.length} bestanden`); } catch (e) { toast('ERROR', 'Selbsttest abgebrochen', e.message); } finally { UI.testsRunning = false; renderView(true); } },
  btRun: () => runBacktestUi(),
  clearFeed: () => { core.clearFeed(); renderView(true); },
  logsPause: () => { UI.logPaused = !UI.logPaused; renderLogs(); },
  logCat: el => { UI.logCat = el.dataset.k; saveUi(); renderLogs(); },
  wallet: async () => { closeModal(null); const r = await core.walletConnect(); toast(r.ok ? 'SUCCESS' : 'WARNING', r.ok ? 'Wallet verbunden (nur lesend)' : 'Wallet nicht verbunden', r.error || ''); scheduleRender(true); renderView(true); },
  walletOff: () => { core.walletDisconnect(); closeModal(null); renderView(true); scheduleRender(true); },
  walletBal: async () => { await Promise.all([core.walletBalance(), core.walletNetwork()]); closeModal(null); renderView(true); scheduleRender(true); },
  ackReview: () => { core.state.risk.reviewRequired = false; core.persistNow(); renderView(true); renderBanner(); },
  wlAdd: () => { const i = document.getElementById('wlAdd'); const v = i ? i.value.trim() : ''; const r = core.addWatch(v); toast(r.ok ? 'SUCCESS' : 'ERROR', r.ok ? 'Zur Watchlist hinzugefügt' : r.error); if (r.ok) renderView(true); },
  wlRemove: el => { core.removeWatch(el.dataset.id); renderView(true); }
};
document.addEventListener('click', e => {
  const mb = e.target.closest('[data-modal]');
  if (mb) { closeModal(mb.dataset.modal); return; }
  if (e.target.id === 'modal') { closeModal(null); return; }
  const ctx = document.getElementById('ctx');
  if (ctx && !ctx.hidden && !e.target.closest('#ctx') && !e.target.closest('[data-act="ctx"]')) closeCtx();
  const el = e.target.closest('[data-act]');
  if (el) {
    if (el.tagName === 'A') e.preventDefault();
    const fn = ACTIONS[el.dataset.act];
    if (fn) { try { const r = fn(el, e); if (r && r.catch) r.catch(x => { core.log.error('UI', x.message); toast('ERROR', 'Aktion fehlgeschlagen', x.message); }); } catch (x) { core.log.error('UI', x.message); toast('ERROR', 'Aktion fehlgeschlagen', x.message); } }
    return;
  }
  const row = e.target.closest('.mrow');
  if (row && !e.target.closest('a,button,input')) selectToken(row.dataset.id);
  const tr = e.target.closest('a[target=_blank]'); if (tr) closeCtx();
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.set) {
    const d = SETTINGS_INDEX[el.dataset.set]; if (!d) return;
    const v = d.t === 'bool' ? el.checked : el.value;
    const r = core.updateSettings({ [d.k]: v });
    const errs = r.errors.filter(x => x.key === d.k || !x.soft);
    if (errs.length) toast(errs.some(x => !x.soft) ? 'ERROR' : 'WARNING', 'Einstellung angepasst', errs.map(x => x.msg).join('; '));
    else if (r.changes.length) toast('SUCCESS', 'Gespeichert', d.l);
    el.value !== undefined && d.t !== 'bool' && (el.value = core.S()[d.k]);
    if (d.t === 'bool') el.checked = !!core.S()[d.k];
    return;
  }
  if (el.dataset.strat) {
    const f = el.dataset.f, v = f === 'enabled' ? el.checked : Number(el.value);
    const r = core.updateStrategies({ [el.dataset.strat]: { [f]: v } });
    if (r.errors.length) toast('ERROR', 'Ungültiger Wert', r.errors.map(x => x.msg).join('; '));
    const cur = core.state.strategies[el.dataset.strat][f];
    if (f === 'enabled') el.checked = cur; else el.value = cur;
    return;
  }
  if (el.dataset.wl) {
    const f = el.dataset.f; core.updateWatch(el.dataset.wl, { [f]: f === 'alerts' ? el.checked : el.value });
    toast('SUCCESS', 'Watchlist gespeichert'); return;
  }
  if (el.dataset.ui) { const v = Number(el.value); if (Number.isFinite(v)) { UI[el.dataset.ui] = clamp(v, 0, 100); saveUi(); renderScanner(); } return; }
  if (el.id === 'fAge') { UI.age = el.value; saveUi(); renderScanner(); }
  if (el.id === 'fRec') { UI.onlyRec = el.checked; saveUi(); renderScanner(); }
  if (el.id === 'fSafe') { UI.safeOnly = el.checked; saveUi(); renderScanner(); }
  if (el.id === 'fRec' || el.id === 'fSafe') { const lb = el.closest('label'); if (lb) lb.setAttribute('aria-checked', String(el.checked)); }
  if (el.id === 'hMode' || el.id === 'hRes') { UI[el.id] = el.value; renderHistory(); }
});
let inputTimer = null;
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'buySize') { const t = selTokFromModal(); if (t) patch(document.getElementById('buyPrev'), buyPreviewHtml(t, Number(el.value))); return; }
  if (!['q', 'hq', 'lq', 'kbq'].includes(el.id)) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    if (el.id === 'q') { UI.q = el.value; renderScanner(); }
    if (el.id === 'hq') { UI.hq = el.value; renderHistory(); }
    if (el.id === 'lq') { UI.logQ = el.value; renderLogs(); }
    if (el.id === 'kbq') { UI.kbQ = el.value; renderKnowledge(document.getElementById('v-knowledge')); }
  }, 150);
});
const selTokFromModal = () => (buyModalToken ? tok(buyModalToken) : null);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (modalState) { closeModal(null); return; } const c = document.getElementById('ctx'); if (c && !c.hidden) { closeCtx(); return; } if (core.state.selected) { closeDetail(); return; } }
  if (e.key === 'Enter' || e.key === ' ') {
    const row = e.target.closest && e.target.closest('.mrow');
    if (row && e.target === row) { e.preventDefault(); selectToken(row.dataset.id); return; }
    const rb = e.target.closest && e.target.closest('[role="button"][data-act]');
    if (rb && e.target === rb) { e.preventDefault(); rb.click(); return; }
    const sw = e.target.closest && e.target.closest('label.switch');
    if (sw && e.target === sw) { e.preventDefault(); sw.click(); }
  }
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !modalState) { e.preventDefault(); showView('scanner'); const q = document.getElementById('q'); if (q) q.focus(); }
});
document.addEventListener('pointerdown', () => { UI.lastTouch = Date.now(); unlockAudio(); }, { passive: true, capture: true });
window.addEventListener('scroll', () => closeCtx(), { passive: true });
window.addEventListener('online', () => { core.log.info('SYSTEM', 'Netzwerk wieder online'); scheduleRender(true); });
window.addEventListener('offline', () => { core.log.warn('SYSTEM', 'Netzwerk offline – Trading deaktiviert'); scheduleRender(true); });
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { drawChart(); drawCharts(document.getElementById('v-' + UI.view)); }, 200); });
window.addEventListener('error', e => { core.log.error('UI', 'Unerwarteter Fehler: ' + (e.message || 'unbekannt')); });
window.addEventListener('unhandledrejection', e => { core.log.error('UI', 'Unbehandelte Promise-Ablehnung: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))); });
window.addEventListener('pagehide', () => { try { core.persistNow(); } catch (e) { /* */ } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { core.persistNow(); } catch (e) { /* */ } } else scheduleRender(true); });

/* ---------- Bootstrap (System Initialization) ---------- */
function boot() {
  core.init({ autoStart: true });
  loadUi();
  buildNav(); buildControl(); buildTiles();
  const q = document.getElementById('q'); if (q) q.value = UI.q;
  const fr = document.getElementById('fRec'); if (fr) fr.checked = UI.onlyRec;
  const fs = document.getElementById('fSafe'); if (fs) fs.checked = UI.safeOnly;
  const fa = document.getElementById('fAge'); if (fa) fa.value = UI.age;
  renderFilterForm(); updateNotifyBtn();
  showView(UI.view);
  renderAll(true);
  setInterval(() => { renderTop(); if (UI.view === 'risk' || UI.view === 'positions') renderNav(); }, 1000);
  if (core.state.loadInfo.migrated) toast('INFO', `Daten aus Version ${core.state.loadInfo.migrated} übernommen`, 'Einstellungen, Watchlist, Positionen und Alarme wurden migriert');
  if (core.state.reconciliation.required) toast('WARNING', 'Abgleich erforderlich', 'Neue Käufe blockiert, bis der Abgleich bestätigt ist');
  if (core.state.loadInfo.corrupted) toast('WARNING', 'Gespeicherter Zustand war beschädigt', 'Start mit sicheren Defaults');
  core.log.info('UI', 'UI initialisiert');
}
boot();
})();
