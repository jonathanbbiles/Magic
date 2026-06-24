import React, { useCallback, useEffect, useRef, useState } from 'react';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

// ============================================================================
// MAGIC MONEY — single-page console
// ----------------------------------------------------------------------------
// One screen. Answers two questions, in order:
//   1. Running, or does it need me?   → STATUS (top, glanceable)
//   2. What's it doing?               → the rest (dense, real, no fluff)
//
// Aesthetic: engineered minimalism, coastal light, one bold pink accent.
// Numbers live in monospace. Copy is terse. Cards arrive, they don't appear.
// Law: every figure is a real /dashboard field. Missing = "—". Never a fake 0.
//
// Backend contract (unchanged): GET /dashboard
//   EXPO_PUBLIC_BACKEND_URL  — base URL (default https://magic-lw8t.onrender.com)
//   EXPO_PUBLIC_API_TOKEN    — optional bearer token (dashboard is public)
// ============================================================================

// Coastal light + confident pink. Green up / red down — pink is brand, not loss.
const C = {
  paper:    '#F6F2EA', // warm off-white ground
  card:     '#FFFFFF',
  ink:      '#15131A', // near-black
  ink2:     '#2C2833',
  sub:      '#69646F',
  faint:    '#9C97A2',
  line:     '#E7E0D4', // hairline
  pink:     '#FF2D78', // brand / active / interactive
  pinkSoft: '#FFE3EE',
  up:       '#0F9E78', // gains
  upSoft:   '#DBF1E9',
  down:     '#E23B40', // losses
  downSoft: '#FAE0E1',
  amber:    '#BE8508', // caution / paused
  amberSoft:'#F6EBCB',
};

const T = {
  font: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  sp: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30, huge: 44 },
  r: { sm: 8, md: 12, lg: 18, xl: 24 },
};

// ----------------------------------------------------------------------------
// Backend config (preserved behaviour from the prior frontend).
// ----------------------------------------------------------------------------
const POLL_MS = 20000;
const TICKER_MS = 1000;
const FETCH_TIMEOUT_MS = 20000;
const STALE_WARN_MS = 90000;
const STALE_BAD_MS = 240000;
const DEFAULT_BACKEND_URL = 'https://magic-lw8t.onrender.com';

function readExpoExtraConfig() {
  const a = Constants.expoConfig?.extra;
  const b = Constants.manifest2?.extra?.expoClient?.extra;
  const extra = a ?? b;
  return extra && typeof extra === 'object' ? extra : {};
}
const str = (v) => String(v || '').trim();
function readWebOriginFallback() {
  if (Platform.OS !== 'web') return '';
  if (typeof window === 'undefined' || !window?.location?.origin) return '';
  const o = str(window.location.origin);
  return /^https?:\/\//i.test(o) ? o : '';
}
function resolveBackendConfig() {
  const extra = readExpoExtraConfig();
  const envUrl = str(typeof process !== 'undefined' ? process?.env?.EXPO_PUBLIC_BACKEND_URL : '');
  const extraUrl = str(extra?.backendUrl);
  const defUrl = str(DEFAULT_BACKEND_URL);
  const webUrl = readWebOriginFallback();
  const envTok = str(typeof process !== 'undefined' ? process?.env?.EXPO_PUBLIC_API_TOKEN : '');
  const extraTok = str(extra?.apiToken);
  const baseUrl = envUrl || extraUrl || defUrl || webUrl;
  const apiToken = envTok || extraTok || '';
  return baseUrl ? { baseUrl, apiToken, missing: false } : { baseUrl: null, apiToken, missing: true };
}
const BACKEND = resolveBackendConfig();
const BASE_URL = BACKEND.baseUrl;
const API_TOKEN = BACKEND.apiToken;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeHeaders() {
  const h = { Accept: 'application/json' };
  if (API_TOKEN) { h.Authorization = `Bearer ${API_TOKEN}`; h['x-api-key'] = API_TOKEN; }
  return h;
}
async function apiFetch(path) {
  if (!BASE_URL) { const e = new Error('Missing EXPO_PUBLIC_BACKEND_URL'); e.status = 503; throw e; }
  const url = `${String(BASE_URL).replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: makeHeaders(), signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') { const e = new Error(`Timeout after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`); e.status = 408; throw e; }
    throw err;
  } finally { clearTimeout(tid); }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) { const e = new Error(json?.error || json?.message || text || 'Request failed'); e.status = res.status; throw e; }
  return json;
}
function isTransient(err) {
  const sc = Number(err?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(sc)) return true;
  const m = String(err?.message || '').toLowerCase();
  return m.includes('timed out') || m.includes('network') || m.includes('failed to fetch');
}
async function fetchWithRetry(path, retries = 0) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    try { return await apiFetch(path); } catch (err) {
      last = err;
      if (i === retries || !isTransient(err)) throw err;
      await sleep(Math.min(1500 * (i + 1), 5000));
    }
  }
  throw last;
}

// ----------------------------------------------------------------------------
// Null-safe formatting. num() is the truth guardrail: Number(null)===0, so a
// naive parse fakes a zero out of every missing field. Map empties → null → "—".
// ----------------------------------------------------------------------------
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function usd(v, d = 2) { const n = num(v); if (n == null) return '—'; return `$${n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`; }
function signedUsd(v) { const n = num(v); if (n == null) return '—'; const s = n >= 0 ? '+' : '−'; return `${s}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function pct(v, d = 2) { const n = num(v); if (n == null) return '—'; return `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`; }
// Binance-style "+$0.23/+0.04%" pair. Either side missing → "—/—".
function changePair(usdV, pctV) {
  const u = num(usdV); const p = num(pctV);
  if (u == null && p == null) return '—/—';
  return `${signedUsd(u)}/${p == null ? '—' : pct(p)}`;
}
function bps(v) { const n = num(v); if (n == null) return '—'; return `${n >= 0 ? '+' : ''}${n.toFixed(1)}`; }
function fmtElapsed(ms) {
  if (ms == null) return '—';
  const sec = Math.floor(Math.abs(ms) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function prettySignal(v) {
  const k = String(v || '').toLowerCase();
  if (!k) return '—';
  if (k.startsWith('btc_lead_lag')) return 'BTC Lag';
  if (k.startsWith('mean_reversion')) return 'Mean Rev';
  if (k.startsWith('microstructure')) return 'Microstr';
  if (k === 'ols') return 'OLS';
  if (k === 'barrier') return 'Barrier';
  if (k === 'multi_factor') return 'Multi-F';
  return String(v);
}
function regimeWord(r) {
  const k = String(r || '').toLowerCase();
  const map = { flat: 'Flat', benign: 'Friendly', adverse: 'Choppy', quiet: 'Quiet', wild: 'Wild' };
  return map[k] || (r ? String(r) : '—');
}
const symShort = (x) => String(x || '').replace('/USD', '').replace('USD', '') || '—';

// ----------------------------------------------------------------------------
// computeHealth — the verdict brain. Pure (data, error, age) → status.
// Severity order. Copy is terse and never apologetic.
// ----------------------------------------------------------------------------
function computeHealth({ data, error, ageMs }) {
  const red = (label, line, act) => ({ level: 'red', label, line, act });
  const amber = (label, line, act) => ({ level: 'amber', label, line, act });
  const green = (label, line, act) => ({ level: 'green', label, line, act });

  if (error || !data) return red('OFFLINE', 'Dashboard unreachable.', 'Ping Claude — likely a deploy or network blip.');
  if (ageMs != null && ageMs > STALE_BAD_MS) return red('SILENT', `No fresh read in ${fmtElapsed(ageMs)}.`, 'Check the Render deploy, or ask Claude.');

  const meta = data.meta || {};
  const acct = data.account || {};
  if (acct.account_blocked || acct.trading_blocked) return red('BLOCKED', 'Exchange halted the account.', 'Check Binance.US for holds.');

  if (meta.truth?.backendReachable === false) return red('NO FEED', 'Engine lost market data.', 'Ping Claude.');
  const engine = meta.engineState ?? meta.runtime?.engineState ?? meta.truth?.engineState ?? null;
  if (!engine) return amber('BOOTING', 'Engine just started.', null);

  const veto = meta.signalSelector?.realizedVeto || {};
  const halt = meta.risk?.tradingHaltedReason;
  if (veto.veto || halt) {
    const eta = veto.veto && veto.clearsOnClock && num(veto.clearsInMs) != null
      ? ` Clears in ~${fmtElapsed(num(veto.clearsInMs))}.`
      : '';
    const line = veto.veto
      ? `Brake on. Last ${veto.sampleSize ?? '?'} ${prettySignal(veto.signalVersion)}: ${bps(veto.realizedAvgNetBps)} vs ${bps(veto.floorBps)} floor.${eta}`
      : `Halted: ${String(halt)}.`;
    return amber('PAUSED', line, 'Your call — it re-tests itself.');
  }
  return green('RUNNING', 'Awake, scanning, clear to trade.', null);
}
const lvlColor = (l) => (l === 'green' ? C.up : l === 'amber' ? C.amber : C.down);
const lvlSoft = (l) => (l === 'green' ? C.upSoft : l === 'amber' ? C.amberSoft : C.downSoft);

// ----------------------------------------------------------------------------
// Motion + primitives.
// ----------------------------------------------------------------------------
function useTicker(activeRef) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => { if (!activeRef || activeRef.current) setTick((n) => (n + 1) & 0xffff); }, TICKER_MS);
    return () => clearInterval(id);
  }, [activeRef]);
}

// Reveal — content arrives: rises + fades on mount, staggered by `delay`.
function Reveal({ delay = 0, children, style }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 460, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [a, delay]);
  return (
    <Animated.View style={[style, { opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

// Pulse — live heartbeat dot. Native driver.
function Pulse({ color = C.pink, size = 9, on = true }) {
  const o = useRef(new Animated.Value(0.5)).current;
  const sc = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!on) { o.setValue(0.45); sc.setValue(1); return undefined; }
    const loop = Animated.loop(Animated.parallel([
      Animated.sequence([
        Animated.timing(o, { toValue: 1, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(o, { toValue: 0.4, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(sc, { toValue: 1.5, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(sc, { toValue: 1, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    ]));
    loop.start();
    return () => loop.stop();
  }, [on, o, sc]);
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: o, transform: [{ scale: sc }] }} />
    </View>
  );
}

function Card({ children, style, accent }) {
  return <View style={[s.card, accent ? { borderLeftColor: accent, borderLeftWidth: 3 } : null, style]}>{children}</View>;
}
function Label({ children }) { return <Text style={s.label}>{children}</Text>; }

// A spec row: label left, mono value right. The workhorse of the dense view.
function Row({ k, v, tone, last }) {
  const color = tone === 'up' ? C.up : tone === 'down' ? C.down : tone === 'pink' ? C.pink : C.ink;
  return (
    <View style={[s.specRow, last ? null : s.specRowBorder]}>
      <Text style={s.specKey}>{k}</Text>
      <Text style={[s.specVal, { color }]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

// Stat block (used in the headline grid).
function Stat({ k, v, tone }) {
  const color = tone === 'up' ? C.up : tone === 'down' ? C.down : C.ink;
  return (
    <View style={s.stat}>
      <Text style={s.statK}>{k}</Text>
      <Text style={[s.statV, { color }]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

function Meter({ value, color = C.pink, height = 8 }) {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <View style={{ height, backgroundColor: C.line, borderRadius: height / 2, overflow: 'hidden' }}>
      <View style={{ height: '100%', width: `${v * 100}%`, backgroundColor: color, borderRadius: height / 2 }} />
    </View>
  );
}

// ============================================================================
// SECTIONS
// ============================================================================

// STATUS — the glance. Bold word, dot, one terse line, action only if needed.
function Status({ health }) {
  const color = lvlColor(health.level);
  return (
    <View style={[s.status, { backgroundColor: lvlSoft(health.level) }]}>
      <View style={s.statusTop}>
        <Pulse color={color} size={11} on={health.level !== 'red'} />
        <Text style={[s.statusWord, { color }]}>{health.label}</Text>
      </View>
      <Text style={s.statusLine}>{health.line}</Text>
      {health.act ? (
        <View style={[s.statusAct, { borderColor: color }]}>
          <Text style={[s.statusActText, { color }]}>{health.act}</Text>
        </View>
      ) : null}
    </View>
  );
}

// MONEY — the headline. Big mono equity, then the deltas that matter.
function Money({ data }) {
  const meta = data.meta || {};
  const acct = data.account || {};
  const ep = meta.performanceEpoch || {};
  const equity = num(acct.equity) ?? num(acct.portfolio_value) ?? num(ep.currentEquity);
  const cash = num(acct.cash) ?? num(acct.buying_power);
  const sUsd = num(ep.pnlUsd);
  const sPct = num(ep.pctChange);
  const week = num(meta.weeklyChangePct);
  const sc = ep.scorecard || {};
  const trades = num(sc.totalClosedTrades);
  const win = num(sc.winRate);
  // Honest split: equity delta vs deposit-free realized trading P&L. When the
  // equity move is mostly deposits/withdrawals, say so instead of letting the
  // "SINCE RESET +X%" tile read as strategy performance.
  const tradingUsd = num(ep.realizedTradingPnlUsd);
  const flowSuspected = ep.externalFlowSuspected === true;
  return (
    <Card>
      <Label>EQUITY</Label>
      <Text style={s.equity}>{usd(equity)}</Text>
      <View style={s.statGrid}>
        <Stat k="SINCE RESET" v={`${signedUsd(sUsd)}`} tone={sUsd == null ? null : sUsd >= 0 ? 'up' : 'down'} />
        <Stat k="" v={pct(sPct)} tone={sPct == null ? null : sPct >= 0 ? 'up' : 'down'} />
        <Stat k="TRADING P&L" v={tradingUsd == null ? '—' : signedUsd(tradingUsd)} tone={tradingUsd == null ? null : tradingUsd >= 0 ? 'up' : 'down'} />
        <Stat k="WEEK" v={pct(week)} tone={week == null ? null : week >= 0 ? 'up' : 'down'} />
        <Stat k="CASH" v={usd(cash, 0)} />
      </View>
      {flowSuspected ? (
        <Text style={s.flowNote}>
          ⚠ SINCE RESET is mostly deposits/withdrawals, not trading. TRADING P&L is the deposit-free strategy result.
        </Text>
      ) : null}
      <View style={s.winWrap}>
        <View style={s.winHead}>
          <Text style={s.winLabel}>WIN RATE · {trades == null ? 0 : trades} trades since reset</Text>
          <Text style={s.winVal}>{win == null ? '—' : `${Math.round(win * 100)}%`}</Text>
        </View>
        <Meter value={win} color={win != null && win >= 0.5 ? C.up : C.pink} />
      </View>
    </Card>
  );
}

// CHANGE — equity change across time horizons, the Binance position-screen
// readout the operator asked for. Dollar + percent per window, green up / red
// down, "—/—" when there isn't that much history yet. Every figure is a real
// meta.equityChanges field — never a fabricated zero.
const CHANGE_ROWS = [
  ['24 Hour', 'h24'],
  ['1 Week', 'd7'],
  ['1 Month', 'd30'],
  ['3 Month', 'd90'],
  ['6 Month', 'd180'],
  ['1 Year', 'd365'],
  ['All-time', 'allTime'],
];
function Change({ data }) {
  const ch = data.meta?.equityChanges || {};
  return (
    <Card>
      <Label>CHANGE</Label>
      <View style={{ marginTop: T.sp.xs }}>
        {CHANGE_ROWS.map(([label, key], i) => {
          const c = ch[key] || null;
          const u = c ? num(c.usd) : null;
          const tone = u == null ? null : u >= 0 ? 'up' : 'down';
          return (
            <Row
              key={key}
              k={`${label} Change`}
              v={c ? changePair(c.usd, c.pct) : '—/—'}
              tone={tone}
              last={i === CHANGE_ROWS.length - 1}
            />
          );
        })}
      </View>
      <Text style={s.tiny}>Equity vs each window back. Blank windows = not enough history yet.</Text>
    </Card>
  );
}

// ENGINE — what it's running, as a tight spec sheet.
function Engine({ data }) {
  const meta = data.meta || {};
  const acct = data.account || {};
  const veto = meta.signalSelector?.realizedVeto || {};
  const venue = String(acct.raw_venue || acct.account_number || '').toLowerCase();
  const venueLabel = venue === 'binance_us' ? 'Binance.US' : venue || '—';
  const engineState = meta.engineState ?? meta.runtime?.engineState ?? '—';
  const scanning = String(meta.truth?.currentEntryScanProgress?.state || '').toLowerCase() === 'scanning' || String(engineState).toLowerCase() === 'scanning';
  const watching = num(meta.scanSymbolsCount);
  const open = Array.isArray(data.positions) ? data.positions.length : 0;
  return (
    <Card>
      <View style={s.cardHead}>
        <Label>ENGINE</Label>
        <View style={s.headPulse}>
          <Pulse color={scanning ? C.pink : C.faint} size={8} on={scanning} />
          <Text style={[s.headPulseText, { color: scanning ? C.pink : C.sub }]}>{scanning ? 'scanning' : String(engineState)}</Text>
        </View>
      </View>
      <Row k="Signal" v={prettySignal(veto.signalVersion)} tone="pink" />
      <Row k="Venue" v={venueLabel} />
      <Row k="Watching" v={watching == null ? '—' : `${watching} coins`} />
      <Row k="Open positions" v={String(open)} tone={open > 0 ? 'up' : null} last />
    </Card>
  );
}

// BRAKE — the realized-expectancy circuit breaker. Numbers, not paragraphs.
function Brake({ data }) {
  const veto = data.meta?.signalSelector?.realizedVeto;
  if (!veto || veto.enabled === false) {
    return <Card><Label>BRAKE</Label><Text style={s.note}>Off in config — no auto-halt on a losing streak.</Text></Card>;
  }
  const on = Boolean(veto.veto);
  const color = on ? C.amber : C.up;
  const clearsInMs = num(veto.clearsInMs);
  const clearsOnClock = Boolean(veto.clearsOnClock);
  const clearText = clearVerdict(veto);
  return (
    <Card accent={color}>
      <View style={s.cardHead}>
        <Label>SAFETY BRAKE</Label>
        <Text style={[s.brakeState, { color }]}>{on ? 'ENGAGED' : 'CLEAR'}</Text>
      </View>
      <Row k="Recent avg" v={`${bps(veto.realizedAvgNetBps)} bps`} tone={on ? 'down' : 'up'} />
      <Row k="Floor" v={`${bps(veto.floorBps)} bps`} />
      <Row k="Sample" v={veto.sampleSize == null ? '—' : `${veto.sampleSize} trades`} />
      <Row
        k="Clears in"
        v={on ? (clearsOnClock && clearsInMs != null ? `~${fmtElapsed(clearsInMs)}` : 'on next good fills') : '—'}
        tone={on ? 'pink' : null}
        last
      />
      {on ? <Text style={s.note}>{clearText}</Text> : null}
    </Card>
  );
}

// clearVerdict — plain-language "when does the brake lift" line. The clock-based
// ETA (clearsInMs) is the honest, computable answer: if no trade closes first,
// the oldest losing fills age out and the breaker re-probes small at that time.
// When the clock can't recover it (disabled, or too many untimestamped fills),
// the only path is fresh fills beating the floor.
function clearVerdict(veto) {
  const clearsInMs = num(veto.clearsInMs);
  if (veto.clearsOnClock && clearsInMs != null) {
    const aged = num(veto.agedOutCount);
    const pending = num(veto.agedTradesPending);
    const tail = pending ? ` ${pending} stale fill${pending === 1 ? '' : 's'} left to expire.` : '';
    const past = aged ? ` ${aged} already aged out.` : '';
    return `Auto-clears in ~${fmtElapsed(clearsInMs)} if no trade closes sooner — then it re-probes small.${tail}${past}`;
  }
  return 'Clears as soon as recent fills average back above the floor — or when a backtest picks a different signal.';
}

// FLOOR — the look-and-see layer. Tight, real, scannable.
function Floor({ data }) {
  const meta = data.meta || {};
  const conv = meta.conviction || {};
  const feeds = meta.binanceFeedShadow?.overall || {};
  const fresh = num(feeds.symbolsFresh);
  const tracked = num(feeds.symbolsTracked);

  const grid = Array.isArray(meta.perSymbolExpectancy?.grid) ? meta.perSymbolExpectancy.grid : [];
  const ranked = grid
    .filter((g) => num(g?.avgNetBps) != null && num(g?.entries) != null && num(g.entries) >= 2)
    .sort((a, b) => num(b.avgNetBps) - num(a.avgNetBps));
  const best = ranked.slice(0, 3);
  const worst = ranked.slice(-3).reverse();

  return (
    <View>
      <Card>
        <Label>MARKET</Label>
        <View style={[s.statGrid, { marginTop: T.sp.sm }]}>
          <Stat k="REGIME" v={regimeWord(meta.marketRegime?.regime)} />
          <Stat k="FEEDS" v={fresh == null || tracked == null ? '—' : `${fresh}/${tracked}`} tone={fresh != null && tracked != null && fresh >= tracked * 0.8 ? 'up' : null} />
          <Stat k="CONVICTION" v={num(conv.avgConviction) == null ? '—' : num(conv.avgConviction).toFixed(2)} />
        </View>
      </Card>

      <Card>
        <Label>LEADERBOARD · bps / trade</Label>
        {best.length === 0 && worst.length === 0 ? (
          <Text style={s.note}>Not enough closed trades to rank yet.</Text>
        ) : (
          <View style={{ marginTop: T.sp.xs }}>
            {best.map((g, i) => <Lead key={`b${i}`} rank={`${i + 1}`} g={g} />)}
            {worst.length ? <View style={s.dash} /> : null}
            {worst.map((g, i) => <Lead key={`w${i}`} rank="▾" g={g} />)}
            <Text style={s.tiny}>Real closed-trade averages, per coin × strategy. ≥2 trades to list.</Text>
          </View>
        )}
      </Card>
    </View>
  );
}

function Lead({ rank, g }) {
  const v = num(g.avgNetBps);
  const color = v == null ? C.sub : v >= 0 ? C.up : C.down;
  return (
    <View style={s.leadRow}>
      <Text style={s.leadRank}>{rank}</Text>
      <Text style={s.leadSym}>{symShort(g.symbol)}</Text>
      <Text style={s.leadSig} numberOfLines={1}>{prettySignal(g.signalVersion)}</Text>
      <Text style={[s.leadBps, { color }]}>{bps(v)}</Text>
      <Text style={s.leadN}>{num(g.entries) == null ? '' : `×${g.entries}`}</Text>
    </View>
  );
}

// FOOTER — freshness, version, one-tap state grab for the Claude workflow.
//
// "Grab state → Claude" copies a paste-ready report to the CLIPBOARD (not the
// share sheet) and appends the tail of the backend log ring so the paste is
// actually diagnostic. RN 0.79 removed core Clipboard, so this uses
// expo-clipboard. Failures surface in the button label — never swallowed.
function fmtLogTail(entries, max = 40) {
  if (!Array.isArray(entries) || entries.length === 0) return '(no log entries)';
  return entries.slice(-max).map((e) => {
    const t = num(e?.ts);
    const stamp = t == null ? '--:--:--' : new Date(t).toISOString().slice(11, 19);
    return `${stamp} ${String(e?.level ?? 'info').toUpperCase()} ${String(e?.msg ?? '')}`;
  }).join('\n');
}
function Footer({ data, ageMs, health }) {
  const version = String(data?.version || data?.meta?.runtime?.commit || '').slice(0, 7) || '—';
  const stale = ageMs != null && ageMs > STALE_WARN_MS;
  const [copyState, setCopyState] = useState('idle'); // idle | copying | done | error
  const onGrab = useCallback(async () => {
    setCopyState('copying');
    const meta = data?.meta || {};
    const veto = meta.signalSelector?.realizedVeto || {};
    const ep = meta.performanceEpoch || {};
    const summary = [
      `Magic Money — ${new Date().toISOString()}`,
      `${health.label}: ${health.line}`,
      `Equity ${usd(num(data?.account?.equity) ?? num(data?.account?.portfolio_value))} · since reset ${signedUsd(num(ep.pnlUsd))} (${pct(num(ep.pctChange))})`,
      `Trading P&L (deposit-free) ${signedUsd(num(ep.realizedTradingPnlUsd))}${ep.externalFlowSuspected === true ? ' · since-reset is mostly deposits' : ''}`,
      `Engine ${meta.engineState ?? '—'} · ${data?.account?.raw_venue ?? '—'} · signal ${veto.signalVersion ?? '—'}`,
      `Brake ${veto.veto ? 'ENGAGED' : 'clear'} — avg ${bps(veto.realizedAvgNetBps)} vs floor ${bps(veto.floorBps)} bps, n=${veto.sampleSize ?? '—'}${veto.veto && veto.clearsOnClock && num(veto.clearsInMs) != null ? ` · clears in ~${fmtElapsed(num(veto.clearsInMs))}` : ''}`,
      `v${version} · data age ${fmtElapsed(ageMs)}`,
    ].join('\n');
    // Best-effort: append the backend log tail. A logs failure must not block
    // the copy — fall back to "(logs unavailable)" and still copy the summary.
    let logsBlock;
    try {
      const logs = await fetchWithRetry('/debug/logs', 1);
      logsBlock = fmtLogTail(logs?.entries);
    } catch (err) {
      logsBlock = `(logs unavailable: ${String(err?.message || err)})`;
    }
    const msg = `${summary}\n\n--- recent logs ---\n${logsBlock}`;
    try {
      await Clipboard.setStringAsync(msg);
      setCopyState('done');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      // Clipboard unavailable (rare) — fall back to the share sheet so the
      // user still gets the text out, and show the failure rather than hide it.
      try { await Share.share({ message: msg }); } catch (_) { /* noop */ }
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 3000);
    }
  }, [data, health, version, ageMs]);
  const grabLabel = copyState === 'copying' ? 'Grabbing…'
    : copyState === 'done' ? 'Copied ✓'
    : copyState === 'error' ? 'Copy failed — tap to retry'
    : 'Grab state → Claude';
  return (
    <View style={s.footer}>
      <Pressable style={s.grab} onPress={onGrab} disabled={copyState === 'copying'}>
        <Text style={s.grabText}>{grabLabel}</Text>
      </Pressable>
      <Text style={[s.foot, stale ? { color: C.amber } : null]}>
        {stale ? `STALE · ${fmtElapsed(ageMs)}` : `LIVE · ${fmtElapsed(ageMs)}`} · v{version}
      </Text>
      <Text style={s.tiny}>Live from the bot. Blanks mean no data — not zero.</Text>
    </View>
  );
}

// ----------------------------------------------------------------------------
// Shell + polling (preserved behaviour).
// ----------------------------------------------------------------------------
export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

function AppInner() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const activeRef = useRef(true);
  useTicker(activeRef);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (n) => { activeRef.current = n === 'active'; });
    return () => sub.remove();
  }, []);

  const load = useCallback(async ({ isRefresh = false } = {}) => {
    if (!BASE_URL) { setLoading(false); setRefreshing(false); setError('Backend URL not configured. Set EXPO_PUBLIC_BACKEND_URL.'); return; }
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const payload = await fetchWithRetry('/dashboard', isRefresh ? 1 : 3);
      setData(payload); setLoadedAt(Date.now()); setError(null);
    } catch (err) {
      const msg = err?.message || 'Request failed';
      setError(`${err?.status ? `HTTP ${err.status}` : 'Error'}: ${msg}`);
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (activeRef.current) load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = useCallback(() => load({ isRefresh: true }), [load]);
  const ageMs = loadedAt ? Date.now() - loadedAt : null;
  const health = computeHealth({ data, error, ageMs });

  if (loading && !data) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="dark-content" />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={s.wordmark}>MAGIC MONEY</Text>
          <View style={s.wordRule} />
          <ActivityIndicator color={C.pink} size="large" style={{ marginTop: T.sp.xl }} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.paper} />
      <View style={s.topBar}>
        <View>
          <Text style={s.wordmark}>MAGIC MONEY</Text>
          <View style={s.wordRule} />
        </View>
        <View style={s.topRight}>
          <Pulse color={lvlColor(health.level)} size={8} on={!error} />
          <Text style={[s.topRightText, { color: lvlColor(health.level) }]}>{error ? 'OFFLINE' : 'LIVE'}</Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: T.sp.lg, paddingBottom: T.sp.huge }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.pink} colors={[C.pink]} />}
        showsVerticalScrollIndicator={false}
      >
        <Reveal delay={0}><Status health={health} /></Reveal>
        {data ? (
          <>
            <Reveal delay={70}><Money data={data} /></Reveal>
            <Reveal delay={140}><Change data={data} /></Reveal>
            <Reveal delay={210}><Engine data={data} /></Reveal>
            <Reveal delay={280}><Brake data={data} /></Reveal>
            <Reveal delay={350}><Floor data={data} /></Reveal>
            <Reveal delay={420}><Footer data={data} ageMs={ageMs} health={health} /></Reveal>
          </>
        ) : (
          <Card><Text style={s.note}>{error || 'No data.'}</Text></Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[ErrorBoundary]', error, info?.componentStack); }
  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={[s.root, { justifyContent: 'center', alignItems: 'center', padding: T.sp.xl }]}>
          <StatusBar barStyle="dark-content" />
          <Text style={s.wordmark}>MAGIC MONEY</Text>
          <Text style={[s.note, { marginTop: T.sp.lg, textAlign: 'center' }]}>{String(this.state.error?.message || this.state.error)}</Text>
          <Pressable style={[s.grab, { marginTop: T.sp.lg }]} onPress={() => this.setState({ error: null })}>
            <Text style={s.grabText}>Reset</Text>
          </Pressable>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

// ----------------------------------------------------------------------------
// Styles.
// ----------------------------------------------------------------------------
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper },

  topBar: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: T.sp.lg, paddingTop: T.sp.sm, paddingBottom: T.sp.md },
  wordmark: { color: C.ink, fontSize: 19, fontWeight: '900', letterSpacing: 3 },
  wordRule: { height: 3, width: 34, backgroundColor: C.pink, marginTop: 5, borderRadius: 2 },
  topRight: { flexDirection: 'row', alignItems: 'center', marginTop: T.sp.xs },
  topRightText: { marginLeft: T.sp.xs, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },

  // Status hero
  status: { borderRadius: T.r.lg, padding: T.sp.xl, marginBottom: T.sp.md },
  statusTop: { flexDirection: 'row', alignItems: 'center' },
  statusWord: { marginLeft: T.sp.sm, fontSize: 30, fontWeight: '900', letterSpacing: 2 },
  statusLine: { color: C.ink2, fontSize: 15, lineHeight: 22, marginTop: T.sp.sm, fontWeight: '500' },
  statusAct: { alignSelf: 'flex-start', borderWidth: 1.5, borderRadius: 999, paddingHorizontal: T.sp.md, paddingVertical: T.sp.xs, marginTop: T.sp.md },
  statusActText: { fontSize: 13, fontWeight: '700' },

  // Cards
  card: { backgroundColor: C.card, borderRadius: T.r.lg, borderWidth: 1, borderColor: C.line, padding: T.sp.lg, marginBottom: T.sp.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: T.sp.xs },
  label: { color: C.faint, fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  headPulse: { flexDirection: 'row', alignItems: 'center' },
  headPulseText: { marginLeft: T.sp.xs, fontSize: 12, fontWeight: '700', fontFamily: T.mono },

  equity: { color: C.ink, fontSize: 42, fontWeight: '800', fontFamily: T.mono, marginTop: T.sp.xs, marginBottom: T.sp.md, letterSpacing: -0.5 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  stat: { width: '25%', paddingVertical: T.sp.xs },
  statK: { color: C.faint, fontSize: 9, fontWeight: '800', letterSpacing: 1, height: 12 },
  statV: { color: C.ink, fontSize: 15, fontWeight: '700', fontFamily: T.mono, marginTop: 2 },

  flowNote: { color: C.sub, fontSize: 11, fontWeight: '600', marginTop: T.sp.sm, lineHeight: 15 },

  winWrap: { marginTop: T.sp.md },
  winHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: T.sp.xs },
  winLabel: { color: C.sub, fontSize: 11, fontWeight: '600' },
  winVal: { color: C.ink, fontSize: 13, fontWeight: '800', fontFamily: T.mono },

  // Spec rows
  specRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: T.sp.sm },
  specRowBorder: { borderBottomWidth: 1, borderBottomColor: C.line },
  specKey: { color: C.sub, fontSize: 14, fontWeight: '500' },
  specVal: { color: C.ink, fontSize: 15, fontWeight: '700', fontFamily: T.mono },

  brakeState: { fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  note: { color: C.sub, fontSize: 12, lineHeight: 18, marginTop: T.sp.sm },
  tiny: { color: C.faint, fontSize: 10, lineHeight: 15, marginTop: T.sp.sm },

  // Leaderboard
  leadRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: T.sp.xs },
  leadRank: { color: C.faint, fontSize: 12, width: 20, fontFamily: T.mono },
  leadSym: { color: C.ink, fontSize: 14, fontWeight: '800', width: 52, fontFamily: T.mono },
  leadSig: { color: C.faint, fontSize: 11, flex: 1 },
  leadBps: { fontSize: 14, fontWeight: '800', fontFamily: T.mono, width: 64, textAlign: 'right' },
  leadN: { color: C.faint, fontSize: 11, width: 34, textAlign: 'right', fontFamily: T.mono },
  dash: { height: 1, backgroundColor: C.line, marginVertical: T.sp.sm },

  // Footer
  footer: { alignItems: 'center', marginTop: T.sp.sm },
  grab: { backgroundColor: C.pink, borderRadius: 999, paddingHorizontal: T.sp.xl, paddingVertical: T.sp.md },
  grabText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
  foot: { color: C.sub, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: T.sp.md, fontFamily: T.mono },
});
