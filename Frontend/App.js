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
// Plain-language market verdict with an emoji face. `enter` is the conviction
// engine's own decision; the regime emoji is the mood of the tape.
function regimeEmoji(r) {
  const k = String(r || '').toLowerCase();
  const map = { benign: '😎', flat: '😐', quiet: '😴', adverse: '😬', wild: '🌪️' };
  return map[k] || '🤔';
}
function marketVerdict({ regime, enter, conviction, minConviction }) {
  const k = String(regime || '').toLowerCase();
  if (k === 'adverse') return { emoji: '🛑', word: 'Sitting out', sub: 'Choppy tape — waiting for calmer conditions.' };
  if (k === 'wild') return { emoji: '🌪️', word: 'Cautious', sub: 'Wild swings — only the strongest setups qualify.' };
  const c = num(conviction);
  const floor = num(minConviction) ?? 0.45;
  if (enter === true || (c != null && c >= floor)) {
    return { emoji: regimeEmoji(regime), word: 'Good to enter', sub: 'Conditions clear — taking qualifying setups.' };
  }
  return { emoji: regimeEmoji(regime), word: 'Holding fire', sub: 'No setup strong enough right now — that’s normal.' };
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

// MiniStat — a compact column for the single-line money strip.
function MiniStat({ k, v, tone }) {
  const color = tone === 'up' ? C.up : tone === 'down' ? C.down : C.ink;
  return (
    <View style={s.miniStat}>
      <Text style={s.miniStatK} numberOfLines={1}>{k}</Text>
      <Text style={[s.miniStatV, { color }]} numberOfLines={1}>{v}</Text>
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

// LineChart — a dependency-free spark line. react-native-svg isn't installed,
// so the line is drawn as a chain of absolutely-positioned, rotated <View>
// segments (rotation is about each segment's centre, hence the cx/cy maths).
// `points` are { y, label } in chronological order; x is spaced evenly.
function LineChart({ points, height = 120, color = C.up }) {
  const [w, setW] = useState(0);
  const onLayout = useCallback((e) => setW(e.nativeEvent.layout.width), []);
  const pad = 8;
  const thick = 2.5;
  const valid = Array.isArray(points) ? points.filter((p) => num(p?.y) != null) : [];
  if (valid.length < 2) {
    return (
      <View onLayout={onLayout} style={{ height, justifyContent: 'center' }}>
        <Text style={s.note}>Not enough history to chart yet — comes alive as the bot runs.</Text>
      </View>
    );
  }
  const ys = valid.map((p) => num(p.y));
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = maxY - minY || Math.abs(maxY) || 1;
  const innerH = height - pad * 2;
  const n = valid.length;
  const xAt = (i) => (w <= 0 ? 0 : (i / (n - 1)) * (w - pad * 2) + pad);
  const yAt = (val) => pad + (1 - (val - minY) / span) * innerH;

  const segs = [];
  const dots = [];
  if (w > 0) {
    for (let i = 0; i < n; i++) {
      const x = xAt(i);
      const y = yAt(ys[i]);
      if (i < n - 1) {
        const x2 = xAt(i + 1);
        const y2 = yAt(ys[i + 1]);
        const dx = x2 - x;
        const dy = y2 - y;
        const len = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        segs.push(
          <View
            key={`s${i}`}
            style={{
              position: 'absolute',
              left: (x + x2) / 2 - len / 2,
              top: (y + y2) / 2 - thick / 2,
              width: len,
              height: thick,
              borderRadius: thick / 2,
              backgroundColor: color,
              transform: [{ rotate: `${ang}rad` }],
            }}
          />,
        );
      }
      const isEnd = i === n - 1;
      dots.push(
        <View
          key={`d${i}`}
          style={{
            position: 'absolute',
            left: x - (isEnd ? 4 : 2.5),
            top: y - (isEnd ? 4 : 2.5),
            width: isEnd ? 8 : 5,
            height: isEnd ? 8 : 5,
            borderRadius: 4,
            backgroundColor: isEnd ? color : C.card,
            borderWidth: isEnd ? 0 : 1.5,
            borderColor: color,
          }}
        />,
      );
    }
  }
  return (
    <View onLayout={onLayout} style={{ height }}>
      {segs}
      {dots}
      <View style={s.chartAxis}>
        <Text style={s.chartTick} numberOfLines={1}>{valid[0].label}</Text>
        <Text style={[s.chartTick, { textAlign: 'right' }]} numberOfLines={1}>{valid[n - 1].label}</Text>
      </View>
    </View>
  );
}

// HBar — one horizontal magnitude bar for the leaderboard. Width ∝ |value|.
function HBar({ value, maxAbs, color }) {
  const v = num(value);
  const frac = v == null || !maxAbs ? 0 : Math.min(1, Math.abs(v) / maxAbs);
  return (
    <View style={s.hbarTrack}>
      <View style={[s.hbarFill, { width: `${Math.max(frac * 100, 3)}%`, backgroundColor: color }]} />
    </View>
  );
}

// ============================================================================
// SECTIONS
// ============================================================================

// STATUS — the glance, on a single slim line: dot · WORD · terse subtext.
// Colour + dot carry the state; the action hint only appears when it matters.
function Status({ health }) {
  const color = lvlColor(health.level);
  return (
    <View style={[s.status, { backgroundColor: lvlSoft(health.level) }]}>
      <View style={s.statusLineRow}>
        <Pulse color={color} size={8} on={health.level !== 'red'} />
        <Text style={[s.statusWord, { color }]}>{health.label}</Text>
        <Text style={s.statusLine} numberOfLines={1}>{health.line}</Text>
      </View>
      {health.act ? <Text style={[s.statusActText, { color }]} numberOfLines={1}>↳ {health.act}</Text> : null}
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
  // Glance direction: most-recent (24h) move, falling back to since-reset.
  const dir = num(data.meta?.equityChanges?.h24?.usd) ?? sUsd;
  const eqTone = dir == null ? C.ink : dir >= 0 ? C.up : C.down;
  const eqArrow = dir == null ? '' : dir >= 0 ? ' ▲' : ' ▼';
  return (
    <Card>
      <View style={s.equityHead}>
        <Label>EQUITY</Label>
        <Text style={[s.equity, { color: eqTone }]} numberOfLines={1}>{usd(equity)}<Text style={s.equityArrow}>{eqArrow}</Text></Text>
      </View>
      <View style={s.moneyRow}>
        <MiniStat k="SINCE RESET" v={`${signedUsd(sUsd)} ${pct(sPct)}`} tone={sUsd == null ? null : sUsd >= 0 ? 'up' : 'down'} />
        <MiniStat k="TRADING P&L" v={tradingUsd == null ? '—' : signedUsd(tradingUsd)} tone={tradingUsd == null ? null : tradingUsd >= 0 ? 'up' : 'down'} />
        <MiniStat k="WEEK" v={pct(week)} tone={week == null ? null : week >= 0 ? 'up' : 'down'} />
        <MiniStat k="CASH" v={usd(cash, 0)} />
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

// CHANGE — the equity trajectory as a line graph. Each meta.equityChanges
// window carries the equity value AND timestamp it was measured from, so the
// curve below is reconstructed from real historical points (never faked) and
// drawn chronologically: oldest on the left, "Now" on the right.
const CURVE_WINDOWS = [
  ['allTime', 'Start'],
  ['d365', '1Y'],
  ['d180', '6M'],
  ['d90', '3M'],
  ['d30', '1M'],
  ['d7', '1W'],
  ['h24', '24H'],
];
function buildEquityCurve(ch) {
  if (!ch) return [];
  const pts = [];
  for (const [key, label] of CURVE_WINDOWS) {
    const c = ch[key];
    const eq = num(c?.fromEquity);
    const ts = c?.fromTs ? Date.parse(c.fromTs) : null;
    if (eq == null || ts == null || Number.isNaN(ts)) continue;
    pts.push({ y: eq, ts, label });
  }
  const nowEq = num(ch.latestEquity);
  if (nowEq != null) pts.push({ y: nowEq, ts: ch.asOfTs ? Date.parse(ch.asOfTs) : Date.now(), label: 'Now' });
  pts.sort((a, b) => a.ts - b.ts);
  // Collapse points measured within a minute of each other (overlapping windows).
  const out = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].ts - p.ts) < 60000) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}
function Change({ data }) {
  const ch = data.meta?.equityChanges || {};
  const curve = buildEquityCurve(ch);
  const first = curve.length ? curve[0].y : null;
  const last = curve.length ? curve[curve.length - 1].y : null;
  const up = first != null && last != null ? last >= first : true;
  const color = up ? C.up : C.down;
  // Headline = all-time, then 1M / 1W / 24H as quick context chips.
  const allTime = ch.allTime || null;
  const chips = [['1M', ch.d30], ['1W', ch.d7], ['24H', ch.h24]];
  return (
    <Card>
      <View style={s.cardHead}>
        <Label>EQUITY OVER TIME</Label>
        <Text style={[s.changeHeadVal, { color }]}>{allTime ? pct(allTime.pct) : '—'}<Text style={s.changeHeadSub}> all-time</Text></Text>
      </View>
      <LineChart points={curve} height={130} color={color} />
      <View style={s.chipRow}>
        {chips.map(([label, c]) => {
          const p = c ? num(c.pct) : null;
          const tone = p == null ? C.faint : p >= 0 ? C.up : C.down;
          return (
            <View key={label} style={s.chip}>
              <Text style={s.chipK}>{label}</Text>
              <Text style={[s.chipV, { color: tone }]}>{p == null ? '—' : pct(p)}</Text>
            </View>
          );
        })}
      </View>
      <Text style={s.tiny}>Reconstructed from real equity readings. Flat early sections = not enough history yet.</Text>
    </Card>
  );
}

// ENGINE — condensed to one strip of chips. The detail (signal/venue/coins)
// is "good to know" not "act on it", so it reads as a single quiet line with
// the one figure that actually changes — open positions — emphasised.
function Engine({ data }) {
  const meta = data.meta || {};
  const acct = data.account || {};
  const veto = meta.signalSelector?.realizedVeto || {};
  const venue = String(acct.raw_venue || acct.account_number || '').toLowerCase();
  const venueLabel = venue === 'binance_us' ? 'Binance.US' : venue || '—';
  const watching = num(meta.scanSymbolsCount);
  const open = Array.isArray(data.positions) ? data.positions.length : 0;
  return (
    <Card style={s.engineCard}>
      <Text style={s.engineLine} numberOfLines={1}>
        <Text style={s.engineKey}>ENGINE  </Text>
        <Text style={s.enginePink}>{prettySignal(veto.signalVersion)}</Text>
        <Text style={s.engineDim}>  ·  {venueLabel}  ·  {watching == null ? '—' : `${watching} watched`}  ·  </Text>
        <Text style={{ color: open > 0 ? C.up : C.sub, fontWeight: '800' }}>{open} open</Text>
      </Text>
    </Card>
  );
}

// BRAKE — the realized-expectancy circuit breaker. When CLEAR it's a single
// reassurance line (the status hero already shouts when it ENGAGES, so the full
// readout would just be duplicate noise). When ENGAGED — the moment it matters —
// it expands to the full numbers so the operator can see why and when it lifts.
function Brake({ data }) {
  const veto = data.meta?.signalSelector?.realizedVeto;
  if (!veto || veto.enabled === false) {
    return <Card style={s.engineCard}><Text style={s.brakeLine} numberOfLines={1}><Text style={s.engineKey}>SAFETY BRAKE  </Text><Text style={s.engineDim}>off in config — no auto-halt on a losing streak</Text></Text></Card>;
  }
  const on = Boolean(veto.veto);
  if (!on) {
    return (
      <Card style={s.engineCard}>
        <Text style={s.brakeLine} numberOfLines={1}>
          <Text style={s.engineKey}>SAFETY BRAKE  </Text>
          <Text style={{ color: C.up, fontWeight: '900' }}>🟢 CLEAR  </Text>
          <Text style={s.engineDim}>auto-halts if trades start bleeding</Text>
        </Text>
      </Card>
    );
  }
  const clearsInMs = num(veto.clearsInMs);
  const clearsOnClock = Boolean(veto.clearsOnClock);
  return (
    <Card accent={C.amber}>
      <View style={s.cardHead}>
        <Label>SAFETY BRAKE</Label>
        <Text style={[s.brakeState, { color: C.amber }]}>🛑 ENGAGED</Text>
      </View>
      <Row k="Recent avg" v={`${bps(veto.realizedAvgNetBps)} bps`} tone="down" />
      <Row k="Floor" v={`${bps(veto.floorBps)} bps`} />
      <Row k="Sample" v={veto.sampleSize == null ? '—' : `${veto.sampleSize} trades`} />
      <Row
        k="Clears in"
        v={clearsOnClock && clearsInMs != null ? `~${fmtElapsed(clearsInMs)}` : 'on next good fills'}
        tone="pink"
        last
      />
      <Text style={s.note}>{clearVerdict(veto)}</Text>
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

// MARKET — the "is it a good time to enter?" verdict, up near the top where the
// operator asked for it. Emoji + plain words carry the answer; the raw inputs
// (tape mood, data freshness, conviction) sit underneath in friendly language.
function Market({ data }) {
  const meta = data.meta || {};
  const conv = meta.conviction || {};
  const feeds = meta.binanceFeedShadow?.overall || {};
  const fresh = num(feeds.symbolsFresh);
  const tracked = num(feeds.symbolsTracked);
  const regime = meta.marketRegime?.regime;
  const v = marketVerdict({
    regime,
    enter: conv.last?.enter,
    conviction: conv.last?.conviction ?? conv.avgConviction,
    minConviction: conv.minConviction,
  });
  const feedsOk = fresh != null && tracked != null && fresh >= tracked * 0.8;
  const c = num(conv.last?.conviction ?? conv.avgConviction);
  return (
    <Card accent={v.word === 'Good to enter' ? C.up : v.word === 'Sitting out' ? C.down : C.amber}>
      <Label>MARKET</Label>
      <View style={s.verdictRow}>
        <Text style={s.verdictEmoji}>{v.emoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={s.verdictWord}>{v.word}</Text>
          <Text style={s.verdictSub} numberOfLines={2}>{v.sub}</Text>
        </View>
      </View>
      <View style={s.factRow}>
        <View style={s.fact}>
          <Text style={s.factK}>TAPE</Text>
          <Text style={s.factV}>{regimeEmoji(regime)} {regimeWord(regime)}</Text>
        </View>
        <View style={s.fact}>
          <Text style={s.factK}>DATA FEED</Text>
          <Text style={[s.factV, { color: feedsOk ? C.up : C.amber }]}>{fresh == null || tracked == null ? '—' : `${fresh}/${tracked} live`}</Text>
        </View>
        <View style={s.fact}>
          <Text style={s.factK}>CONFIDENCE</Text>
          <Text style={[s.factV, { color: c == null ? C.ink : c >= (num(conv.minConviction) ?? 0.45) ? C.up : C.sub }]}>{c == null ? '—' : `${Math.round(c * 100)}%`}</Text>
        </View>
      </View>
    </Card>
  );
}

// LEADERBOARD — per-coin × strategy realized edge, drawn as magnitude bars so
// the winners/losers read at a glance instead of a wall of numbers. (A true
// time-moving line would need per-trade history the /dashboard doesn't expose
// yet; these bars are the honest visual from the live averages we do have.)
function Leaderboard({ data }) {
  const meta = data.meta || {};
  const grid = Array.isArray(meta.perSymbolExpectancy?.grid) ? meta.perSymbolExpectancy.grid : [];
  const ranked = grid
    .filter((g) => num(g?.avgNetBps) != null && num(g?.entries) != null && num(g.entries) >= 2)
    .sort((a, b) => num(b.avgNetBps) - num(a.avgNetBps));
  const best = ranked.slice(0, 4);
  const worst = ranked.slice(-4).reverse().filter((g) => !best.includes(g));
  const shown = [...best, ...worst];
  const maxAbs = shown.reduce((m, g) => Math.max(m, Math.abs(num(g.avgNetBps) || 0)), 0) || 1;
  return (
    <Card>
      <Label>LEADERBOARD · bps / trade</Label>
      {shown.length === 0 ? (
        <Text style={s.note}>Not enough closed trades to rank yet.</Text>
      ) : (
        <View style={{ marginTop: T.sp.sm }}>
          {shown.map((g, i) => <Lead key={`${g.symbol}${g.signalVersion}${i}`} g={g} maxAbs={maxAbs} />)}
          <Text style={s.tiny}>Real closed-trade averages, per coin × strategy. ≥2 trades to list.</Text>
        </View>
      )}
    </Card>
  );
}

function Lead({ g, maxAbs }) {
  const v = num(g.avgNetBps);
  const color = v == null ? C.sub : v >= 0 ? C.up : C.down;
  return (
    <View style={s.leadRow}>
      <Text style={s.leadSym}>{symShort(g.symbol)}</Text>
      <View style={s.leadBarWrap}>
        <HBar value={v} maxAbs={maxAbs} color={color} />
      </View>
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
            <Reveal delay={140}><Market data={data} /></Reveal>
            <Reveal delay={210}><Change data={data} /></Reveal>
            <Reveal delay={280}><Engine data={data} /></Reveal>
            <Reveal delay={350}><Brake data={data} /></Reveal>
            <Reveal delay={420}><Leaderboard data={data} /></Reveal>
            <Reveal delay={490}><Footer data={data} ageMs={ageMs} health={health} /></Reveal>
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

  // Status — slim single line
  status: { borderRadius: T.r.md, paddingHorizontal: T.sp.md, paddingVertical: T.sp.sm, marginBottom: T.sp.md },
  statusLineRow: { flexDirection: 'row', alignItems: 'center' },
  statusWord: { marginLeft: T.sp.sm, fontSize: 14, fontWeight: '900', letterSpacing: 1.5 },
  statusLine: { color: C.ink2, fontSize: 12.5, marginLeft: T.sp.sm, fontWeight: '500', flex: 1 },
  statusActText: { fontSize: 12, fontWeight: '700', marginTop: T.sp.xs, marginLeft: T.sp.lg },

  // Cards
  card: { backgroundColor: C.card, borderRadius: T.r.lg, borderWidth: 1, borderColor: C.line, padding: T.sp.lg, marginBottom: T.sp.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: T.sp.xs },
  label: { color: C.faint, fontSize: 11, fontWeight: '800', letterSpacing: 2 },

  // Equity — compact, label + value share one baseline; colour = direction
  equityHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: T.sp.md },
  equity: { fontSize: 26, fontWeight: '800', fontFamily: T.mono, letterSpacing: -0.5 },
  equityArrow: { fontSize: 16, fontWeight: '900' },

  // Money strip — all four figures on one line
  moneyRow: { flexDirection: 'row', justifyContent: 'space-between' },
  miniStat: { flex: 1, paddingRight: T.sp.xs },
  miniStatK: { color: C.faint, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.5 },
  miniStatV: { color: C.ink, fontSize: 12.5, fontWeight: '700', fontFamily: T.mono, marginTop: 2 },

  // Charts
  chartAxis: { position: 'absolute', left: 0, right: 0, bottom: -2, flexDirection: 'row', justifyContent: 'space-between' },
  chartTick: { color: C.faint, fontSize: 9, fontWeight: '700', flex: 1 },
  changeHeadVal: { fontSize: 15, fontWeight: '800', fontFamily: T.mono },
  changeHeadSub: { color: C.faint, fontSize: 10, fontWeight: '700' },
  chipRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: T.sp.lg, paddingTop: T.sp.sm, borderTopWidth: 1, borderTopColor: C.line },
  chip: { alignItems: 'center' },
  chipK: { color: C.faint, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  chipV: { fontSize: 14, fontWeight: '800', fontFamily: T.mono, marginTop: 2 },

  // Engine / Brake one-line strips
  engineCard: { paddingVertical: T.sp.md },
  engineLine: { fontSize: 13 },
  brakeLine: { fontSize: 13 },
  engineKey: { color: C.faint, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  enginePink: { color: C.pink, fontWeight: '800', fontFamily: T.mono },
  engineDim: { color: C.sub, fontFamily: T.mono },

  // Market verdict
  verdictRow: { flexDirection: 'row', alignItems: 'center', marginTop: T.sp.sm, marginBottom: T.sp.md },
  verdictEmoji: { fontSize: 34, marginRight: T.sp.md },
  verdictWord: { color: C.ink, fontSize: 20, fontWeight: '900', letterSpacing: 0.3 },
  verdictSub: { color: C.sub, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  factRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: T.sp.sm, borderTopWidth: 1, borderTopColor: C.line },
  fact: { flex: 1 },
  factK: { color: C.faint, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  factV: { color: C.ink, fontSize: 13, fontWeight: '700', marginTop: 3 },

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

  // Leaderboard — magnitude bars
  leadRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: T.sp.xs },
  leadSym: { color: C.ink, fontSize: 13, fontWeight: '800', width: 48, fontFamily: T.mono },
  leadBarWrap: { flex: 1, marginHorizontal: T.sp.sm },
  hbarTrack: { height: 9, backgroundColor: C.line, borderRadius: 5, overflow: 'hidden' },
  hbarFill: { height: '100%', borderRadius: 5 },
  leadBps: { fontSize: 13, fontWeight: '800', fontFamily: T.mono, width: 56, textAlign: 'right' },
  leadN: { color: C.faint, fontSize: 10, width: 28, textAlign: 'right', fontFamily: T.mono },

  // Footer
  footer: { alignItems: 'center', marginTop: T.sp.sm },
  grab: { backgroundColor: C.pink, borderRadius: 999, paddingHorizontal: T.sp.xl, paddingVertical: T.sp.md },
  grabText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
  foot: { color: C.sub, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: T.sp.md, fontFamily: T.mono },
});
