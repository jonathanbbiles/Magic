import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Constants from 'expo-constants';
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
// MAGIC TRADER — theatrical scalper dashboard
// ----------------------------------------------------------------------------
// Single-file Expo app. Drop into App.js and run via Expo Go.
//
// Backend contract (unchanged, plug-compatible with the previous frontend):
//   GET /dashboard        — full snapshot powering Stage / Cast / Backstage
//   GET /debug/logs       — ring buffer of structured log lines
//
// Auth contract (unchanged):
//   EXPO_PUBLIC_BACKEND_URL  — base URL (default https://magic-lw8t.onrender.com)
//   EXPO_PUBLIC_API_TOKEN    — optional bearer token (some endpoints public)
//
// Pure UI rewrite. Polling, retry, error boundary, and AppState pause/resume
// are preserved verbatim from the previous version so behaviour stays stable.
// ============================================================================

// ----------------------------------------------------------------------------
// Theme — burlesque velvet, gold trim, hot magenta, vibrant green / rose.
// Colour rules: green = good, rose = bad. Always.
// ----------------------------------------------------------------------------
const palette = {
  velvet:      '#0E0820',  // deep aubergine — curtain
  velvetSoft:  '#1A0F30',  // raised surface
  velvetEdge:  '#2A1A4A',  // borders, dividers
  velvetGlow:  '#3D2466',  // subtle highlight
  gold:        '#F6C667',  // accent / "waiting" / calm
  goldDim:     '#A8884A',
  rose:        '#FF3D71',  // losses, errors, drawdown
  roseDim:     '#9C1F44',
  rosePale:    '#3A1224',  // tinted bg for negatives
  emerald:     '#10D481',  // wins, ok, ascending
  emeraldDim:  '#0E7F4F',
  emeraldPale: '#0E2A1F',  // tinted bg for positives
  magenta:     '#FF1F8C',  // active scanning, accent
  magentaSoft: '#5C0E37',
  cream:       '#F4ECDA',  // primary text
  pearl:       '#D8CFB7',  // secondary text
  fog:         '#7E7390',  // tertiary
  ink:         '#070414',
};

const T = {
  c: palette,
  font: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  fontMono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  sp: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, huge: 40 },
  r: { sm: 8, md: 14, lg: 20, xl: 28 },
};

// ----------------------------------------------------------------------------
// Backend config (unchanged from previous frontend).
// ----------------------------------------------------------------------------
const POLL_MS = 20000;
const LOG_POLL_MS = 5000;
const TICKER_MS = 1000;
const FETCH_TIMEOUT_MS = 20000;
const DEFAULT_BACKEND_URL = 'https://magic-lw8t.onrender.com';

function readExpoExtraConfig() {
  const expoConfigExtra = Constants.expoConfig?.extra;
  const manifest2Extra = Constants.manifest2?.extra?.expoClient?.extra;
  const extra = expoConfigExtra ?? manifest2Extra;
  return extra && typeof extra === 'object' ? extra : {};
}

function readStringConfig(value) {
  return String(value || '').trim();
}

function readWebOriginFallback() {
  if (Platform.OS !== 'web') return '';
  if (typeof window === 'undefined' || !window?.location?.origin) return '';
  const origin = readStringConfig(window.location.origin);
  return /^https?:\/\//i.test(origin) ? origin : '';
}

function resolveBackendConfig() {
  const extra = readExpoExtraConfig();
  const envBackendUrl = readStringConfig(typeof process !== 'undefined' ? process?.env?.EXPO_PUBLIC_BACKEND_URL : '');
  const extraBackendUrl = readStringConfig(extra?.backendUrl);
  const defaultBackendUrl = readStringConfig(DEFAULT_BACKEND_URL);
  const webOriginFallback = readWebOriginFallback();
  const envApiToken = readStringConfig(typeof process !== 'undefined' ? process?.env?.EXPO_PUBLIC_API_TOKEN : '');
  const extraApiToken = readStringConfig(extra?.apiToken);
  const baseUrl = envBackendUrl || extraBackendUrl || defaultBackendUrl || webOriginFallback;
  const apiToken = envApiToken || extraApiToken || '';
  if (baseUrl) {
    let warning = null;
    if (!envBackendUrl) {
      if (extraBackendUrl) warning = 'Using expo extra.backendUrl (not env).';
      else if (defaultBackendUrl) warning = 'Using built-in backend URL.';
      else if (webOriginFallback) warning = 'Using web origin fallback.';
    }
    return { baseUrl, apiToken, warning, missing: false };
  }
  return {
    baseUrl: null,
    apiToken,
    warning: 'Missing required EXPO_PUBLIC_BACKEND_URL.',
    missing: true,
  };
}

const BACKEND = resolveBackendConfig();
const BASE_URL = BACKEND.baseUrl;
const API_TOKEN = BACKEND.apiToken;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHeaders() {
  const h = { Accept: 'application/json' };
  if (API_TOKEN) {
    h.Authorization = `Bearer ${API_TOKEN}`;
    h['x-api-key'] = API_TOKEN;
  }
  return h;
}

async function apiFetch(path) {
  if (!BASE_URL) {
    const e = new Error('Missing EXPO_PUBLIC_BACKEND_URL');
    e.status = 503;
    throw e;
  }
  const url = `${String(BASE_URL).replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: makeHeaders(), signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error(`Timeout after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`);
      e.status = 408;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(tid);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error(json?.error || json?.message || text || 'Request failed');
    e.status = res.status;
    throw e;
  }
  return json;
}

function isTransient(err) {
  const s = Number(err?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(s)) return true;
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
// Formatting helpers.
// ----------------------------------------------------------------------------
// num — null-safe number parse. CRITICAL: `Number(null)` and `Number('')` are
// both 0 (a finite number), so a naive parse turns every missing/null backend
// field into a fake 0 — the root of the "everything shows zeros" bug, since the
// Binance position shape returns avg_entry_price / unrealized_pl / etc. as null.
// We map null / undefined / '' to null so callers can fall back or render "—".
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function usd(v, decimals = 2) {
  const n = num(v);
  if (n == null) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function signedUsd(v) {
  const n = num(v);
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
}

function pct(v, decimals = 2) {
  const n = num(v);
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

function fmtBps(v) {
  const n = num(v);
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} bps`;
}

function liveAge(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Date.now() - ms);
}

function fmtElapsed(elapsedMs) {
  if (elapsedMs == null) return '—';
  const s = Math.floor(elapsedMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtLogTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ----------------------------------------------------------------------------
// derivePosition — single source of truth for every per-token number.
//
// THE ZEROS BUG: on Binance.US the position object returns avg_entry_price,
// unrealized_pl, unrealized_plpc and cost_basis as NULL (those are Alpaca-only
// fields). The old tiles read them directly, so entry price, P&L and % all
// rendered blank/zero. The real data is present elsewhere: the entry price is
// in the attached entry forensics (`forensics.buyLimit`), current_price +
// market_value are populated, the resting take-profit is `sell.activeLimit`,
// and the signal's per-trade target lives in `forensics` / `bot`. We recompute
// everything here so each tile shows live, non-zero values — and fall back to a
// clean null (rendered as "—") only when a field is genuinely absent.
// ----------------------------------------------------------------------------
function derivePosition(p) {
  const fz = p?.forensics || {};
  const bot = p?.bot || {};
  const symbol = String(p?.symbol || '—');
  const symShort = symbol.replace('/USD', '').replace('USD', '');
  const qty = num(p?.qty);
  const current = num(p?.current_price);
  const marketValue = num(p?.market_value);
  // entry: prefer the venue avg, then the entry forensics (Binance path).
  const entry = num(p?.avg_entry_price) ?? num(fz.buyLimit) ?? num(bot.entryPrice);
  // unrealized P&L: prefer venue-reported, else derive from entry + current.
  let upl = num(p?.unrealized_pl);
  let uplPct = num(p?.unrealized_plpc);
  if (uplPct != null && Math.abs(uplPct) <= 1.5) uplPct *= 100; // Alpaca reports a fraction
  if (upl == null && entry != null && current != null && qty != null) {
    upl = qty * (current - entry);
  }
  if (uplPct == null && entry != null && current != null && entry !== 0) {
    uplPct = (current / entry - 1) * 100;
  }
  // take-profit target price + the signal's per-trade net target.
  const grossBps = num(fz.signalDerivedGrossBps) ?? num(fz.grossTargetBps);
  const targetPrice = num(p?.sell?.activeLimit) ?? num(bot.targetPrice)
    ?? (entry != null && grossBps != null ? entry * (1 + grossBps / 10000) : null);
  const targetNetBps = num(fz.targetNetProfitBps) ?? num(bot.expectedNetProfitBps) ?? num(fz.signalDerivedNetBps);
  const stopBps = num(fz.stopLossBpsResolved) ?? num(fz.staticStopLossBps);
  const spreadBps = num(fz.spreadBps);
  const volBps = num(fz.volatilityBps);
  const signal = fz.signalVersion || bot.signalVersion || null;
  const state = p?.state || null;
  // progress entry → target (clamped), and distance current → target (%).
  let progress = 0;
  if (entry != null && current != null && targetPrice != null && targetPrice !== entry) {
    progress = Math.max(-0.5, Math.min(1.2, (current - entry) / (targetPrice - entry)));
  }
  const distToTargetPct = (current != null && targetPrice != null && current !== 0)
    ? ((targetPrice - current) / current) * 100 : null;
  const tone = upl == null ? 'neutral' : upl >= 0 ? 'good' : 'bad';
  return {
    symbol, symShort, qty, entry, current, marketValue, upl, uplPct,
    targetPrice, targetNetBps, stopBps, spreadBps, volBps, signal, state,
    progress, distToTargetPct, tone,
  };
}

// ----------------------------------------------------------------------------
// computePortfolio — the backend does NOT emit an aggregate `portfolio` object;
// it exposes per-position unrealized P&L and the account snapshot. Derive the
// open P&L (sum of unrealized P&L) and its percentage (against cost basis) here
// so the Stage's headline number isn't permanently blank. Cost basis per
// position is market_value − unrealized_pl, falling back to qty × avg entry.
// ----------------------------------------------------------------------------
function computePortfolio(data) {
  const positions = Array.isArray(data?.positions) ? data.positions : [];
  let totalPL = 0;
  let totalCost = 0;
  let exposure = 0;
  let sawPL = false;
  for (const p of positions) {
    const d = derivePosition(p);
    if (d.upl != null) { totalPL += d.upl; sawPL = true; }
    const cost = (d.entry != null && d.qty != null)
      ? d.entry * d.qty
      : (d.marketValue != null && d.upl != null ? d.marketValue - d.upl : null);
    if (cost != null) totalCost += cost;
    if (d.marketValue != null) exposure += d.marketValue;
  }
  const portfolioValue = num(data?.account?.portfolio_value) ?? num(data?.account?.equity) ?? null;
  const cash = num(data?.account?.cash) ?? num(data?.account?.buying_power) ?? null;
  const openPL = sawPL ? totalPL : null;
  const openPLPct = openPL != null && totalCost > 0 ? (openPL / totalCost) * 100 : null;
  return { portfolioValue, cash, openPL, openPLPct, exposure, positionCount: positions.length };
}

// ----------------------------------------------------------------------------
// Gradient — zero-dependency shim. We avoid expo-linear-gradient because
// pasting App.js straight into Expo Go can fail to resolve native modules.
// We approximate a soft diagonal gradient by layering two semi-transparent
// fills on top of a solid base colour. Same prop surface as Gradient
// (colors[], start, end ignored, style, children) so the rest of the file
// stays unchanged.
// ----------------------------------------------------------------------------
function Gradient({ colors = [], style, children }) {
  const base = colors[0] || palette.velvet;
  const tint = colors[1] || base;
  return (
    <View style={[style, { backgroundColor: base, overflow: 'hidden' }]}>
      {tint !== base ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: tint,
            opacity: 0.45,
          }}
        />
      ) : null}
      {tint !== base ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0, left: 0, right: '50%', bottom: '50%',
            backgroundColor: base,
            opacity: 0.5,
          }}
        />
      ) : null}
      <View style={{ position: 'relative' }}>{children}</View>
    </View>
  );
}

// ----------------------------------------------------------------------------
// useTicker — triggers a re-render every interval so live "Xs ago" labels
// count up smoothly. Pauses when the app is backgrounded (caller passes ref).
// ----------------------------------------------------------------------------
function useTicker(intervalMs = TICKER_MS, activeRef) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (!activeRef || activeRef.current) setTick((n) => (n + 1) & 0xffff);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, activeRef]);
}

// ----------------------------------------------------------------------------
// Pulse — subtle pulsing dot, used for the engine state badge. Native driver
// so it stays smooth without re-rendering the tree every frame.
// ----------------------------------------------------------------------------
function Pulse({ color = palette.magenta, size = 10, on = true }) {
  const opacity = useRef(new Animated.Value(0.4)).current;
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!on) {
      opacity.setValue(0.6);
      scale.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.35, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [on, opacity, scale]);
  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity,
          transform: [{ scale }],
          shadowColor: color,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.8,
          shadowRadius: size,
        }}
      />
    </View>
  );
}

// ----------------------------------------------------------------------------
// Bar — a horizontal progress bar used for "distance to target" mini-meter.
// Negative values render in rose, positive in emerald, capped at the edges.
// ----------------------------------------------------------------------------
function Bar({ value, height = 8 }) {
  // value in [-0.5, 1.2]; 0 = entry, 1 = target. Below 0 = drawdown.
  const v = Math.max(-0.5, Math.min(1.2, num(value) ?? 0));
  const positiveWidth = Math.max(0, Math.min(1, v)) * 100;
  const negativeWidth = v < 0 ? Math.max(0, Math.min(0.5, -v)) * 100 : 0;
  const overWidth = v > 1 ? Math.max(0, Math.min(0.2, v - 1)) * 100 : 0;
  return (
    <View style={{ height, backgroundColor: palette.velvetEdge, borderRadius: height / 2, overflow: 'hidden', position: 'relative' }}>
      {/* Center line at "0" */}
      <View style={{ position: 'absolute', left: '33%', top: 0, bottom: 0, width: 1, backgroundColor: palette.fog, opacity: 0.3 }} />
      {/* Negative (drawdown) extends LEFT from center */}
      {negativeWidth > 0 && (
        <View
          style={{
            position: 'absolute',
            top: 0, bottom: 0,
            right: '67%',
            width: `${negativeWidth * 0.66}%`,
            backgroundColor: palette.rose,
          }}
        />
      )}
      {/* Positive (toward target) extends RIGHT from center */}
      {positiveWidth > 0 && (
        <View
          style={{
            position: 'absolute',
            top: 0, bottom: 0,
            left: '33%',
            width: `${positiveWidth * 0.5}%`,
            backgroundColor: palette.emerald,
          }}
        />
      )}
      {/* Overshoot beyond target */}
      {overWidth > 0 && (
        <View
          style={{
            position: 'absolute',
            top: 0, bottom: 0,
            left: '83%',
            width: `${overWidth * 0.85}%`,
            backgroundColor: palette.gold,
          }}
        />
      )}
    </View>
  );
}

// ----------------------------------------------------------------------------
// Mood — picks a theatrical headline + colour based on portfolio + scan state.
// ----------------------------------------------------------------------------
function deriveMood({ openPL, engineOk, scanInProgress, hasPositions }) {
  if (!engineOk) return { label: '🌑 LIGHTS OUT', sub: 'Engine unreachable', color: palette.rose, accent: palette.rose };
  const pl = num(openPL);
  if (!hasPositions && scanInProgress) return { label: '🔮 PROWLING', sub: 'Scanning the universe', color: palette.magenta, accent: palette.magenta };
  if (!hasPositions) return { label: '🪞 INTERMISSION', sub: 'Waiting for the next scene', color: palette.gold, accent: palette.gold };
  if (pl == null) return { label: '🎭 ON STAGE', sub: 'Positions live', color: palette.gold, accent: palette.gold };
  if (pl >= 0.5) return { label: '✨ STANDING OVATION', sub: 'Profits growing', color: palette.emerald, accent: palette.emerald };
  if (pl >= 0) return { label: '🌟 IN THE SPOTLIGHT', sub: 'Slightly green', color: palette.emerald, accent: palette.emerald };
  if (pl >= -0.5) return { label: '🎭 ON STAGE', sub: 'Holding the line', color: palette.gold, accent: palette.gold };
  if (pl >= -2) return { label: '🥀 BLEEDING ROUGE', sub: 'Drawdown — strategy intact', color: palette.rose, accent: palette.rose };
  return { label: '🌧️ STORM ON STAGE', sub: 'Heavy drawdown', color: palette.rose, accent: palette.rose };
}

// ----------------------------------------------------------------------------
// HeaderStrip — top of every tab. Pulse dot, app name, build / version.
// ----------------------------------------------------------------------------
// interpretMonitor — turn a /monitor payload into a single health verdict the
// header pill + Backstage panel both read. Returns { tone, label, hb }.
//   green  = trading, no flags
//   gold   = veto active (benign — the safety brake is halting new entries)
//   rose   = a real alert flag is present ([EXEC_FAIL]/[EQUITY_LOW]/[VETO_NEW])
function interpretMonitor(monitor) {
  const hb = monitor?.latest || null;
  if (!hb) return { tone: 'idle', label: 'monitor —', hb: null };
  const flags = Array.isArray(hb.flags) ? hb.flags : [];
  if (flags.length > 0) return { tone: 'bad', label: flags.join(' · '), hb };
  if (hb.veto) return { tone: 'warn', label: 'safety veto', hb };
  return { tone: 'good', label: 'healthy', hb };
}

function HeaderStrip({ engineState, scanInProgress, lastScanAt, version, monitor }) {
  const pulseColor = !engineState ? palette.fog
    : scanInProgress ? palette.magenta
    : String(engineState).toLowerCase() === 'ready' ? palette.emerald
    : palette.gold;
  const ageMs = liveAge(lastScanAt);
  const mon = interpretMonitor(monitor);
  const monColor = mon.tone === 'good' ? palette.emerald
    : mon.tone === 'warn' ? palette.gold
    : mon.tone === 'bad' ? palette.rose
    : palette.fog;
  return (
    <View style={s.headerStrip}>
      <View style={s.headerLeft}>
        <Pulse color={pulseColor} size={11} on={Boolean(engineState)} />
        <View style={{ marginLeft: T.sp.sm }}>
          <Text style={s.headerTitle}>MAGIC TRADER</Text>
          <Text style={s.headerSub}>
            {scanInProgress ? 'scanning' : (engineState || 'offline')}
            {ageMs != null ? ` · last scan ${fmtElapsed(ageMs)} ago` : ''}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {/* Monitor health pill — at-a-glance "is the bot ok?" without leaving the header. */}
        <View style={[s.monPill, { borderColor: monColor }]}>
          <View style={[s.monDot, { backgroundColor: monColor }]} />
          <Text style={[s.monPillText, { color: monColor }]} numberOfLines={1}>{mon.label}</Text>
        </View>
        {version ? (
          <View style={[s.versionPill, { marginLeft: T.sp.xs }]}>
            <Text style={s.versionPillText}>{String(version).slice(0, 7)}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ----------------------------------------------------------------------------
// Banner — tinted info strip used for warnings, errors, fun status.
// ----------------------------------------------------------------------------
function Banner({ tone = 'info', children }) {
  const map = {
    info: { bg: 'rgba(246, 198, 103, 0.10)', border: palette.gold, text: palette.gold },
    error: { bg: 'rgba(255, 61, 113, 0.10)', border: palette.rose, text: palette.rose },
    ok: { bg: 'rgba(16, 212, 129, 0.10)', border: palette.emerald, text: palette.emerald },
  };
  const c = map[tone] || map.info;
  return (
    <View style={[s.banner, { backgroundColor: c.bg, borderColor: c.border }]}>
      <Text style={[s.bannerText, { color: c.text }]}>{children}</Text>
    </View>
  );
}

// ----------------------------------------------------------------------------
// MoneyTile — the giant portfolio-value tile on the Stage.
// ----------------------------------------------------------------------------
function MoneyTile({ portfolioValue, openPL, openPLPct, mood, deltaSinceLast }) {
  const pl = num(openPL);
  const arrow = pl == null ? '·' : pl >= 0 ? '▲' : '▼';
  const arrowColor = pl == null ? palette.gold : pl >= 0 ? palette.emerald : palette.rose;
  return (
    <Gradient
      colors={[palette.velvetSoft, palette.velvet]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={s.moneyTile}
    >
      <View style={s.moneyMoodRow}>
        <Text style={[s.moneyMoodLabel, { color: mood.color }]} numberOfLines={1}>{mood.label}</Text>
      </View>
      <Text style={s.moneyValue}>{usd(portfolioValue)}</Text>
      <Text style={[s.moneySub, { color: mood.color }]}>{mood.sub}</Text>
      <View style={s.moneyDeltaRow}>
        <Text style={[s.moneyDelta, { color: arrowColor }]}>{arrow} {signedUsd(openPL)} ({pct(openPLPct)})</Text>
        {deltaSinceLast != null ? (
          <Text style={[s.moneyDeltaSub, { color: deltaSinceLast > 0 ? palette.emerald : deltaSinceLast < 0 ? palette.rose : palette.fog }]}>
            {deltaSinceLast > 0 ? '▲' : deltaSinceLast < 0 ? '▼' : '·'} {signedUsd(deltaSinceLast)} since last poll
          </Text>
        ) : null}
      </View>
    </Gradient>
  );
}

// ----------------------------------------------------------------------------
// StatTriple — three side-by-side big stat cards (Open P&L / Win % / TP fill).
// ----------------------------------------------------------------------------
function StatTriple({ items }) {
  return (
    <View style={s.statRow}>
      {items.map((it, idx) => {
        const tone = it.tone || 'neutral';
        const color = tone === 'good' ? palette.emerald : tone === 'bad' ? palette.rose : palette.gold;
        return (
          <View key={idx} style={[s.statCell, { borderColor: 'rgba(255,255,255,0.06)' }]}>
            <Text style={s.statLabel}>{it.label}</Text>
            <Text style={[s.statValue, { color }]} numberOfLines={1}>{it.value}</Text>
            {it.sub ? <Text style={s.statSub}>{it.sub}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

// ----------------------------------------------------------------------------
// Chip — small in-theme label pill. Used for per-token signal/spread/stop tags.
// ----------------------------------------------------------------------------
function Chip({ label, tone = 'neutral' }) {
  const color = tone === 'good' ? palette.emerald : tone === 'bad' ? palette.rose : palette.gold;
  return (
    <View style={[s.chip, { borderColor: color }]}>
      <Text style={[s.chipText, { color }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

// prettyReason — humanise a backend skip/blocker reason for the watchlist.
function prettyReason(reason) {
  const map = {
    micro_spread_regime_wide: 'spread too wide',
    micro_prob_below_min: 'edge too low',
    spread_too_wide: 'spread too wide',
    stale_quote: 'quote stale',
    no_quote: 'no quote',
    universe_hard_allowlist_filtered: 'off allowlist',
    concurrent_position_cap: 'slots full',
    realized_expectancy_veto: 'bleed-halt',
    insufficient_cash: 'low cash',
    sizing_unavailable: 'sizing n/a',
  };
  if (map[reason]) return map[reason];
  return String(reason || '').replace(/_/g, ' ');
}

// price formatter that scales decimals to the magnitude of the price.
function priceFmt(px) {
  if (px == null) return '—';
  const abs = Math.abs(px);
  return usd(px, abs >= 100 ? 2 : abs >= 1 ? 3 : 5);
}

// ----------------------------------------------------------------------------
// CastCard — single position tile, big and theatrical. Reads DERIVED values so
// entry / P&L / % / target are always live (never the null Binance fields).
// ----------------------------------------------------------------------------
function CastCard({ position, activeRef }) {
  useTicker(TICKER_MS, activeRef);
  const d = derivePosition(position);
  const accent = d.tone === 'good' ? palette.emerald : d.tone === 'bad' ? palette.rose : palette.gold;
  const heldSec = num(position?.heldSeconds);

  return (
    <Gradient
      colors={d.tone === 'good'
        ? [palette.emeraldPale, palette.velvetSoft]
        : d.tone === 'bad'
          ? [palette.rosePale, palette.velvetSoft]
          : [palette.velvetSoft, palette.velvet]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[s.castCard, { borderColor: accent }]}
    >
      <View style={s.castHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[s.castSym, { color: palette.cream }]}>{d.symShort}</Text>
          {d.state ? <Text style={s.castStateBadge}>{String(d.state).toUpperCase()}</Text> : null}
        </View>
        <Text style={[s.castPL, { color: accent }]}>{signedUsd(d.upl)}</Text>
      </View>
      <View style={s.castSubRow}>
        <Text style={[s.castPct, { color: accent }]}>{pct(d.uplPct, 3)}</Text>
        <Text style={s.castMeta}>
          {d.marketValue != null ? `${usd(d.marketValue)} • ` : ''}held {heldSec != null ? fmtElapsed(heldSec * 1000) : '—'}
        </Text>
      </View>
      <View style={{ marginTop: T.sp.md }}>
        <Bar value={d.progress} height={10} />
        <View style={s.castPriceRow}>
          <Text style={s.castPriceLabel}>entry</Text>
          <Text style={s.castPriceLabel}>now</Text>
          <Text style={s.castPriceLabel}>TP {d.targetNetBps != null ? `+${d.targetNetBps.toFixed(0)}bps` : ''}</Text>
        </View>
        <View style={s.castPriceRow}>
          <Text style={s.castPriceVal}>{priceFmt(d.entry)}</Text>
          <Text style={[s.castPriceVal, { color: accent }]}>{priceFmt(d.current)}</Text>
          <Text style={s.castPriceVal}>{priceFmt(d.targetPrice)}</Text>
        </View>
      </View>
      <View style={s.castChipRow}>
        {d.signal ? <Chip label={String(d.signal).replace('microstructure_', 'micro ')} /> : null}
        {d.spreadBps != null ? <Chip label={`spread ${d.spreadBps.toFixed(1)}bps`} /> : null}
        {d.stopBps != null ? <Chip label={`stop −${d.stopBps.toFixed(0)}bps`} tone="bad" /> : null}
      </View>
      <View style={s.castFooter}>
        <Text style={s.castFooterText}>
          {d.distToTargetPct != null
            ? `${d.distToTargetPct >= 0 ? '↑' : '↓'} ${Math.abs(d.distToTargetPct).toFixed(2)}% to take-profit`
            : 'take-profit resting'}
        </Text>
      </View>
    </Gradient>
  );
}

// ----------------------------------------------------------------------------
// sortPositionsByHealth — green (winning %) at top, red (losing %) at bottom.
// Sort key: unrealized_plpc descending. Ties break on unrealized_pl. Positions
// with non-numeric P&L sink to the bottom so live winners/losers stay grouped.
// ----------------------------------------------------------------------------
function sortPositionsByHealth(positions) {
  if (!Array.isArray(positions)) return [];
  // Sort on DERIVED unrealized P&L% (winners on top), since the venue field is
  // null on Binance. Ties break on derived P&L $.
  return [...positions]
    .map((p) => ({ p, d: derivePosition(p) }))
    .sort((a, b) => {
      const ap = a.d.uplPct;
      const bp = b.d.uplPct;
      if (ap == null && bp == null) return 0;
      if (ap == null) return 1;
      if (bp == null) return -1;
      if (ap !== bp) return bp - ap;
      const au = a.d.upl == null ? -Infinity : a.d.upl;
      const bu = b.d.upl == null ? -Infinity : b.d.upl;
      return bu - au;
    })
    .map((x) => x.p);
}

// ----------------------------------------------------------------------------
// Stage — overview tab. The "tonight at a glance" view.
// ----------------------------------------------------------------------------
function Stage({ data, activeRef, onJumpToCast }) {
  useTicker(TICKER_MS, activeRef);
  const meta = data?.meta || {};
  const truth = meta?.truth || {};
  const runtime = meta?.runtime || {};
  const portfolio = computePortfolio(data);
  const positions = sortPositionsByHealth(data?.positions);
  const scorecard = meta?.scorecard || {};
  const engineState = meta?.engineState ?? runtime?.engineState ?? truth?.engineState ?? null;
  const engineOk = String(engineState || '').toLowerCase() === 'ready' || String(engineState || '').toLowerCase() === 'scanning';
  const scanInProgress = (truth?.currentEntryScanProgress?.state || '').toLowerCase() === 'scanning';
  const lastScanAt = meta?.lastEntryScanAt ?? truth?.lastEntryScanAt;
  const portfolioValue = portfolio?.portfolioValue ?? data?.account?.portfolio_value ?? data?.account?.equity;
  const openPL = portfolio?.openPL;
  const openPLPct = portfolio?.openPLPct;

  const prevPLRef = useRef(num(openPL));
  const [delta, setDelta] = useState(null);
  useEffect(() => {
    const next = num(openPL);
    if (next != null && prevPLRef.current != null) {
      const d = next - prevPLRef.current;
      setDelta(Math.abs(d) > 0.001 ? d : 0);
    }
    prevPLRef.current = next;
  }, [openPL]);

  const mood = deriveMood({ openPL: num(openPL), engineOk, scanInProgress, hasPositions: positions.length > 0 });

  const totalClosed = num(scorecard?.totalClosedTrades);
  const winRate = num(scorecard?.winRate);
  const tpFillRate = num(scorecard?.tpFillRate);
  const expectancy = num(scorecard?.expectancyUsd);
  const avgWin = num(scorecard?.avgWinUsd);
  const avgLoss = num(scorecard?.avgLossUsd);

  const stats = [
    { label: 'OPEN P&L',
      value: signedUsd(openPL),
      sub: pct(openPLPct),
      tone: openPL == null ? 'neutral' : openPL >= 0 ? 'good' : 'bad' },
    { label: 'WIN RATE',
      value: winRate == null ? '—' : `${(winRate * 100).toFixed(0)}%`,
      sub: totalClosed != null ? `${totalClosed} closed` : '—',
      tone: winRate == null ? 'neutral' : winRate >= 0.5 ? 'good' : 'bad' },
    { label: 'EXPECTANCY',
      value: expectancy == null ? '—' : signedUsd(expectancy),
      sub: tpFillRate != null ? `${(tpFillRate * 100).toFixed(0)}% TP fills` : '—',
      tone: expectancy == null ? 'neutral' : expectancy >= 0 ? 'good' : 'bad' },
  ];

  const skipReasons = truth?.topSkipReasonsRolling || {};
  const skipEntries = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const skipTotal = skipEntries.reduce((a, [, v]) => a + v, 0);

  return (
    <View style={s.tabBody}>
      <MoneyTile
        portfolioValue={portfolioValue}
        openPL={openPL}
        openPLPct={openPLPct}
        mood={mood}
        deltaSinceLast={delta}
      />
      <StatTriple items={stats} />

      {/* Engine pulse */}
      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>🔮 ENGINE PULSE</Text>
      </View>
      <Gradient colors={[palette.velvetSoft, palette.velvet]} style={s.pulseTile}>
        <View style={s.pulseRow}>
          <Text style={s.pulseLabel}>State</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pulse color={mood.accent} size={8} on={Boolean(engineState)} />
            <Text style={[s.pulseValue, { marginLeft: T.sp.sm, color: mood.accent }]}>{engineState || 'offline'}</Text>
          </View>
        </View>
        <View style={s.pulseRow}>
          <Text style={s.pulseLabel}>Last scan</Text>
          <Text style={s.pulseValue}>
            {lastScanAt ? `${fmtElapsed(liveAge(lastScanAt))} ago` : '—'}
          </Text>
        </View>
        <View style={s.pulseRow}>
          <Text style={s.pulseLabel}>Universe</Text>
          <Text style={s.pulseValue}>
            {meta?.scanSymbolsCount ?? '—'} symbols ({meta?.envRequestedUniverseMode || '—'})
          </Text>
        </View>
        <View style={s.pulseRow}>
          <Text style={s.pulseLabel}>Avg win / loss</Text>
          <Text style={s.pulseValue}>
            <Text style={{ color: avgWin != null ? palette.emerald : palette.fog }}>{avgWin != null ? signedUsd(avgWin) : '—'}</Text>
            {' / '}
            <Text style={{ color: avgLoss != null ? palette.rose : palette.fog }}>{avgLoss != null ? signedUsd(avgLoss) : '—'}</Text>
          </Text>
        </View>
      </Gradient>

      {/* Top reject reasons */}
      {skipEntries.length > 0 && (
        <>
          <View style={s.sectionHeader}>
            <Text style={s.sectionHeaderTitle}>🚪 WHY WE&apos;RE NOT BUYING</Text>
            <Text style={s.sectionHeaderSub}>rolling skip reasons</Text>
          </View>
          <View style={s.reasonsTile}>
            {skipEntries.map(([reason, count]) => {
              const widthPct = skipTotal > 0 ? (count / skipTotal) * 100 : 0;
              return (
                <View key={reason} style={{ marginBottom: T.sp.sm }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                    <Text style={s.reasonLabel}>{reason}</Text>
                    <Text style={s.reasonCount}>{count}</Text>
                  </View>
                  <View style={{ height: 6, backgroundColor: palette.velvetEdge, borderRadius: 3, overflow: 'hidden' }}>
                    <View style={{ height: 6, width: `${widthPct}%`, backgroundColor: palette.magenta, borderRadius: 3 }} />
                  </View>
                </View>
              );
            })}
          </View>
        </>
      )}

      {/* Tonight's Cast (last section, all positions, sorted green→red). */}
      <Pressable onPress={onJumpToCast} style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>🎭 TONIGHT&apos;S CAST</Text>
        <Text style={s.sectionHeaderSub}>{positions.length} live · tap for details</Text>
      </Pressable>
      {positions.length === 0 ? (
        <View style={s.emptyTile}>
          <Text style={s.emptyTitle}>No positions on stage</Text>
          <Text style={s.emptyBody}>The engine is looking for the next entry.</Text>
        </View>
      ) : (
        positions.map((p, i) => <CastCardCompact key={p?.symbol || i} position={p} activeRef={activeRef} />)
      )}
    </View>
  );
}

// ----------------------------------------------------------------------------
// CastCardCompact — shorter version for the Stage preview list.
// ----------------------------------------------------------------------------
function CastCardCompact({ position, activeRef }) {
  useTicker(TICKER_MS, activeRef);
  const d = derivePosition(position);
  const accent = d.tone === 'good' ? palette.emerald : d.tone === 'bad' ? palette.rose : palette.gold;
  const heldSec = num(position?.heldSeconds);
  return (
    <View style={[s.compactCard, { borderColor: accent }]}>
      <View style={s.compactRow}>
        <Text style={[s.compactSym, { color: palette.cream }]}>{d.symShort}</Text>
        <Text style={[s.compactPct, { color: accent }]}>{pct(d.uplPct, 2)}</Text>
        <Text style={[s.compactPL, { color: accent }]}>{signedUsd(d.upl)}</Text>
      </View>
      <View style={{ marginTop: T.sp.xs }}>
        <Bar value={d.progress} height={6} />
      </View>
      <Text style={s.compactMeta}>
        {d.signal ? `${String(d.signal).replace('microstructure_', 'micro ')} • ` : ''}held {heldSec != null ? fmtElapsed(heldSec * 1000) : '—'}
      </Text>
    </View>
  );
}

// ----------------------------------------------------------------------------
// Cast — full-detail positions tab.
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// ScanBoard — per-token WATCHLIST. Surfaces what the bot is doing with every
// universe symbol right now: HOLDING (live), or scanning/blocked (with the
// reason + the symbol's historical edge). Fed by meta.tradeFeasibility +
// meta.perSymbolExpectancy, so tokens that never open a position are still
// visible — this is the "why isn't it trading X?" answer the old UI hid.
// ----------------------------------------------------------------------------
function ScanBoard({ data }) {
  const meta = data?.meta || {};
  const feas = Array.isArray(meta?.tradeFeasibility?.symbols) ? meta.tradeFeasibility.symbols : [];
  const grid = Array.isArray(meta?.perSymbolExpectancy?.grid) ? meta.perSymbolExpectancy.grid : [];
  const heldSet = new Set((Array.isArray(data?.positions) ? data.positions : []).map((p) => String(p?.symbol)));

  // best historical avg net bps per symbol (across signals)
  const edgeBySym = {};
  for (const g of grid) {
    const k = String(g?.symbol);
    const v = num(g?.avgNetBps);
    if (v == null) continue;
    if (edgeBySym[k] == null || v > edgeBySym[k]) edgeBySym[k] = v;
  }

  const rows = {};
  for (const f of feas) { const k = String(f?.symbol); if (k) rows[k] = { symbol: k, ...f }; }
  for (const sym of heldSet) if (sym && !rows[sym]) rows[sym] = { symbol: sym };
  const list = Object.values(rows);
  if (list.length === 0) return null;

  list.sort((a, b) => {
    const ah = heldSet.has(a.symbol) ? 1 : 0;
    const bh = heldSet.has(b.symbol) ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return (num(b.feasibilityPct) ?? -1) - (num(a.feasibilityPct) ?? -1);
  });

  return (
    <View style={{ marginTop: T.sp.xl }}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>🔍 WATCHLIST</Text>
        <Text style={s.sectionHeaderSub}>{list.length} symbols · why each is in or out</Text>
      </View>
      {list.map((r) => {
        const held = heldSet.has(r.symbol);
        const blocker = r.topBlocker ? prettyReason(r.topBlocker) : null;
        const edge = edgeBySym[r.symbol];
        const status = held ? 'HOLDING' : (blocker || 'scanning');
        const statusColor = held ? palette.emerald : (r.chronicallyInfeasible ? palette.rose : palette.gold);
        const feasPct = num(r.feasibilityPct);
        return (
          <View key={r.symbol} style={s.scanRow}>
            <Text style={s.scanSym}>{r.symbol.replace('/USD', '')}</Text>
            <View style={{ flex: 1, paddingHorizontal: T.sp.sm }}>
              <Text style={[s.scanStatus, { color: statusColor }]} numberOfLines={1}>{status}</Text>
              {!held && feasPct != null
                ? <Text style={s.scanSub}>{`passes ${feasPct.toFixed(0)}% · ${num(r.rejections) ?? 0} skips`}</Text>
                : null}
            </View>
            <Text style={[s.scanEdge, { color: edge == null ? palette.fog : edge >= 0 ? palette.emerald : palette.rose }]}>
              {edge == null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(0)}bps`}
            </Text>
          </View>
        );
      })}
      <Text style={s.scanLegend}>edge = historical avg net bps/trade for this symbol (— = no closes yet)</Text>
    </View>
  );
}

// ----------------------------------------------------------------------------
// Cast — full-detail positions tab + the per-token watchlist beneath it.
// ----------------------------------------------------------------------------
function Cast({ data, activeRef }) {
  const positions = sortPositionsByHealth(data?.positions);
  const meta = data?.meta || {};
  const scan = meta?.lastEntryScanSummary || {};
  const scanSub = scan?.universeSize != null
    ? `${positions.length} live · scanning ${scan.universeSize}`
    : `${positions.length} live`;
  return (
    <View style={s.tabBody}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>🎭 TONIGHT&apos;S CAST</Text>
        <Text style={s.sectionHeaderSub}>{scanSub}</Text>
      </View>
      {positions.length === 0 ? (
        <View style={s.emptyTile}>
          <Text style={s.emptyTitle}>🎭 No open positions</Text>
          <Text style={s.emptyBody}>The engine is scanning — the watchlist below shows why each token is in or out.</Text>
        </View>
      ) : (
        positions.map((p, i) => <CastCard key={p?.symbol || i} position={p} activeRef={activeRef} />)
      )}
      <ScanBoard data={data} />
    </View>
  );
}

// ----------------------------------------------------------------------------
// Backstage — diagnostics tab. Skip reasons, scan progress, scorecard detail.
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// MonitorPanel — the heartbeat "report" surfaced inside Backstage. Shows the
// latest health verdict big, the key heartbeat fields, and a recent history
// list. Reads the /monitor payload (latest + heartbeats[]).
// ----------------------------------------------------------------------------
function MonitorPanel({ monitor }) {
  const mon = interpretMonitor(monitor);
  const hb = mon.hb;
  const heartbeats = Array.isArray(monitor?.heartbeats) ? monitor.heartbeats.slice(-12).reverse() : [];
  const accent = mon.tone === 'good' ? palette.emerald
    : mon.tone === 'warn' ? palette.gold
    : mon.tone === 'bad' ? palette.rose
    : palette.fog;
  const ageMs = hb ? liveAge(hb.ts) : null;
  const verdict = mon.tone === 'good' ? 'HEALTHY'
    : mon.tone === 'warn' ? 'SAFETY VETO ACTIVE'
    : mon.tone === 'bad' ? 'NEEDS ATTENTION'
    : 'NO HEARTBEAT YET';

  return (
    <View>
      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>💓 MONITOR</Text>
        <Text style={s.sectionHeaderSub}>
          {ageMs != null ? `heartbeat ${fmtElapsed(ageMs)} ago` : 'awaiting first heartbeat'}
        </Text>
      </View>
      <Gradient
        colors={mon.tone === 'good' ? [palette.emeraldPale, palette.velvetSoft]
          : mon.tone === 'bad' ? [palette.rosePale, palette.velvetSoft]
          : [palette.velvetSoft, palette.velvet]}
        style={[s.boxOffice, { borderColor: accent, borderWidth: 1 }]}
      >
        <View style={s.monVerdictRow}>
          <View style={[s.monDot, { backgroundColor: accent, width: 12, height: 12, borderRadius: 6 }]} />
          <Text style={[s.monVerdict, { color: accent }]}>{verdict}</Text>
        </View>
        {hb ? (
          <>
            <View style={s.boRow}><Text style={s.boLabel}>Equity</Text><Text style={s.boValue}>{hb.equity != null ? usd(hb.equity) : '—'}</Text></View>
            <View style={s.boRow}><Text style={s.boLabel}>Open positions</Text><Text style={s.boValue}>{hb.openPositions ?? '—'}</Text></View>
            <View style={s.boRow}>
              <Text style={s.boLabel}>Trading state</Text>
              <Text style={[s.boValue, { color: hb.veto ? palette.gold : palette.emerald }]}>
                {hb.veto ? `halted (${hb.vetoReason || 'veto'})` : 'trading'}
              </Text>
            </View>
            <View style={s.boRow}>
              <Text style={s.boLabel}>Realized edge</Text>
              <Text style={[s.boValue, { color: hb.realizedAvgNetBps == null ? palette.fog : hb.realizedAvgNetBps >= 0 ? palette.emerald : palette.rose }]}>
                {hb.realizedAvgNetBps == null ? '—' : fmtBps(hb.realizedAvgNetBps)}{hb.sampleSize != null ? ` · n=${hb.sampleSize}` : ''}
              </Text>
            </View>
            <View style={s.boRow}><Text style={s.boLabel}>Signal</Text><Text style={s.boValue}>{hb.signalVersion || '—'}</Text></View>
            {hb.execFailure ? (
              <View style={s.boRow}><Text style={s.boLabel}>Exec error</Text><Text style={[s.boValue, { color: palette.rose, flex: 1, textAlign: 'right' }]} numberOfLines={1}>{hb.execFailure}</Text></View>
            ) : null}
          </>
        ) : (
          <Text style={s.emptyBody}>The bot hasn&apos;t recorded a heartbeat yet — it records one each snapshot cycle (~30 min and on key events).</Text>
        )}
        <Text style={s.monLegend}>green = healthy · gold = safety brake halting entries (benign) · rose = needs eyes</Text>
      </Gradient>

      {heartbeats.length > 0 ? (
        <View style={s.reasonsTile}>
          {heartbeats.map((h, i) => {
            const flags = Array.isArray(h.flags) ? h.flags : [];
            const dot = flags.length ? palette.rose : h.veto ? palette.gold : palette.emerald;
            const a = liveAge(h.ts);
            return (
              <View key={h.tsMs || i} style={s.monHistRow}>
                <View style={[s.monDot, { backgroundColor: dot }]} />
                <Text style={s.monHistTime}>{a != null ? `${fmtElapsed(a)} ago` : '—'}</Text>
                <Text style={s.monHistMid} numberOfLines={1}>
                  {h.equity != null ? usd(h.equity, 0) : '—'} · {h.veto ? 'veto' : 'trading'}
                  {h.realizedAvgNetBps != null ? ` · ${fmtBps(h.realizedAvgNetBps)}` : ''}
                </Text>
                {flags.length ? <Text style={s.monHistFlag} numberOfLines={1}>{flags.join(' ')}</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

// ----------------------------------------------------------------------------
function Backstage({ data, monitor, activeRef }) {
  useTicker(TICKER_MS, activeRef);
  const meta = data?.meta || {};
  const truth = meta?.truth || {};
  const scorecard = meta?.scorecard || {};
  const lastScan = meta?.lastEntryScanSummary || {};
  const skipReasons = truth?.topSkipReasonsRolling || {};
  const skipEntries = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]);
  const skipTotal = skipEntries.reduce((a, [, v]) => a + v, 0);
  const lastSuccess = meta?.lastSuccessfulAction;
  const lastFailure = meta?.lastExecutionFailure;

  return (
    <View style={s.tabBody}>
      <MonitorPanel monitor={monitor} />

      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>📜 BOX OFFICE</Text>
        <Text style={s.sectionHeaderSub}>scorecard since last restart</Text>
      </View>
      <Gradient colors={[palette.velvetSoft, palette.velvet]} style={s.boxOffice}>
        <View style={s.boRow}><Text style={s.boLabel}>Closed trades</Text><Text style={s.boValue}>{scorecard?.totalClosedTrades ?? '—'}</Text></View>
        <View style={s.boRow}>
          <Text style={s.boLabel}>Win rate</Text>
          <Text style={[s.boValue, { color: scorecard?.winRate == null ? palette.fog : scorecard.winRate >= 0.5 ? palette.emerald : palette.rose }]}>
            {scorecard?.winRate == null ? '—' : `${(scorecard.winRate * 100).toFixed(0)}%`}
          </Text>
        </View>
        <View style={s.boRow}>
          <Text style={s.boLabel}>Expectancy</Text>
          <Text style={[s.boValue, { color: scorecard?.expectancyUsd == null ? palette.fog : scorecard.expectancyUsd >= 0 ? palette.emerald : palette.rose }]}>
            {scorecard?.expectancyUsd == null ? '—' : signedUsd(scorecard.expectancyUsd)}/trade
          </Text>
        </View>
        <View style={s.boRow}><Text style={s.boLabel}>Avg win</Text><Text style={[s.boValue, { color: palette.emerald }]}>{scorecard?.avgWinUsd != null ? signedUsd(scorecard.avgWinUsd) : '—'}</Text></View>
        <View style={s.boRow}><Text style={s.boLabel}>Avg loss</Text><Text style={[s.boValue, { color: palette.rose }]}>{scorecard?.avgLossUsd != null ? signedUsd(scorecard.avgLossUsd) : '—'}</Text></View>
        <View style={s.boRow}>
          <Text style={s.boLabel}>Profit factor</Text>
          <Text style={[s.boValue, { color: scorecard?.profitFactor == null ? palette.fog : scorecard.profitFactor >= 1 ? palette.emerald : palette.rose }]}>
            {scorecard?.profitFactor == null ? '—' : scorecard.profitFactor.toFixed(2)}
          </Text>
        </View>
        <View style={s.boRow}><Text style={s.boLabel}>TP fill rate</Text><Text style={s.boValue}>{scorecard?.tpFillRate != null ? `${(scorecard.tpFillRate * 100).toFixed(0)}%` : '—'}</Text></View>
        <View style={s.boRow}><Text style={s.boLabel}>Median hold</Text><Text style={s.boValue}>{scorecard?.medianHoldSeconds != null ? fmtElapsed(scorecard.medianHoldSeconds * 1000) : '—'}</Text></View>
      </Gradient>

      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>🚪 SKIP REASONS</Text>
        <Text style={s.sectionHeaderSub}>rolling — why we&apos;re not buying</Text>
      </View>
      {skipEntries.length === 0 ? (
        <View style={s.emptyTile}>
          <Text style={s.emptyTitle}>Nothing rejected lately</Text>
          <Text style={s.emptyBody}>Either we&apos;re full or the gates are open.</Text>
        </View>
      ) : (
        <View style={s.reasonsTile}>
          {skipEntries.map(([reason, count]) => {
            const widthPct = skipTotal > 0 ? (count / skipTotal) * 100 : 0;
            return (
              <View key={reason} style={{ marginBottom: T.sp.sm }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                  <Text style={s.reasonLabel}>{reason}</Text>
                  <Text style={s.reasonCount}>{count} ({widthPct.toFixed(0)}%)</Text>
                </View>
                <View style={{ height: 6, backgroundColor: palette.velvetEdge, borderRadius: 3, overflow: 'hidden' }}>
                  <View style={{ height: 6, width: `${widthPct}%`, backgroundColor: palette.magenta, borderRadius: 3 }} />
                </View>
              </View>
            );
          })}
        </View>
      )}

      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>🔍 LAST SCAN</Text>
      </View>
      <Gradient colors={[palette.velvetSoft, palette.velvet]} style={s.boxOffice}>
        <View style={s.boRow}><Text style={s.boLabel}>Universe</Text><Text style={s.boValue}>{lastScan?.universeSize ?? '—'}</Text></View>
        <View style={s.boRow}><Text style={s.boLabel}>Held</Text><Text style={s.boValue}>{lastScan?.heldCount ?? '—'}</Text></View>
        <View style={s.boRow}><Text style={s.boLabel}>Slots open</Text><Text style={[s.boValue, { color: (lastScan?.slotsAvailable ?? 0) > 0 ? palette.emerald : palette.gold }]}>{lastScan?.slotsAvailable ?? '—'}</Text></View>
        <View style={s.boRow}><Text style={s.boLabel}>Evaluated</Text><Text style={s.boValue}>{lastScan?.evaluated ?? '—'}</Text></View>
        <View style={s.boRow}><Text style={s.boLabel}>Entered</Text><Text style={[s.boValue, { color: (lastScan?.entered ?? 0) > 0 ? palette.emerald : palette.fog }]}>{lastScan?.entered ?? '—'}</Text></View>
      </Gradient>

      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>🎬 LAST ACTION</Text>
      </View>
      <Gradient colors={[palette.velvetSoft, palette.velvet]} style={s.boxOffice}>
        <View style={s.boRow}><Text style={s.boLabel}>Last success</Text>
          <Text style={[s.boValue, { color: lastSuccess ? palette.emerald : palette.fog, fontSize: 12 }]} numberOfLines={1}>
            {lastSuccess ? `${lastSuccess.symbol} ${lastSuccess.action}` : '—'}
          </Text>
        </View>
        <View style={s.boRow}><Text style={s.boLabel}>Last failure</Text>
          <Text style={[s.boValue, { color: lastFailure ? palette.rose : palette.fog, fontSize: 12 }]} numberOfLines={2}>
            {lastFailure ? `${lastFailure.reason}: ${lastFailure.message}` : 'none'}
          </Text>
        </View>
      </Gradient>
    </View>
  );
}

// ----------------------------------------------------------------------------
// Send — the logs + "copy bundle for AI" tab.
// ----------------------------------------------------------------------------
function Send({ data, logsRef, activeRef }) {
  useTicker(TICKER_MS, activeRef);
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [logError, setLogError] = useState(null);
  const lastTsRef = useRef(0);

  useEffect(() => {
    if (logsRef) logsRef.current = logs;
  }, [logs, logsRef]);

  const fetchLogs = useCallback(async () => {
    try {
      const since = lastTsRef.current;
      const result = await apiFetch(`/debug/logs?since=${since}&limit=200`);
      if (result?.entries?.length) {
        setLogs((prev) => [...prev, ...result.entries].slice(-500));
        lastTsRef.current = result.entries[result.entries.length - 1].ts;
      }
      setLogError(null);
    } catch (err) {
      setLogError(err?.message || 'Log fetch failed');
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    const id = setInterval(() => {
      if (!activeRef || activeRef.current) fetchLogs();
    }, LOG_POLL_MS);
    return () => clearInterval(id);
  }, [fetchLogs, activeRef]);

  const filtered = useMemo(() => {
    if (filter === 'all') return logs;
    return logs.filter((e) => e.level === filter);
  }, [logs, filter]);

  // The format the user pastes into our chats. One tap → clipboard.
  const buildBundle = useCallback(() => {
    const diagJson = JSON.stringify(data, null, 2);
    const logLines = filtered.map((e) => `[${fmtLogTime(e.ts)}] [${e.level}] ${e.msg}`).join('\n');
    return `=== DIAGNOSTICS ===\n${diagJson}\n\n=== LOGS (${filtered.length} entries) ===\n${logLines}`;
  }, [data, filtered]);

  const copyForAI = useCallback(async () => {
    const text = buildBundle();
    try { await Share.share({ message: text }); } catch { /* ignore */ }
  }, [buildBundle]);

  const copyLogsOnly = useCallback(async () => {
    const text = filtered.map((e) => `[${fmtLogTime(e.ts)}] [${e.level}] ${e.msg}`).join('\n');
    try { await Share.share({ message: text }); } catch { /* ignore */ }
  }, [filtered]);

  const copyDiagOnly = useCallback(async () => {
    const text = JSON.stringify(data, null, 2);
    try { await Share.share({ message: text }); } catch { /* ignore */ }
  }, [data]);

  const levelColor = (lvl) => lvl === 'error' ? palette.rose
    : lvl === 'warn' ? palette.gold
    : palette.cream;

  return (
    <View style={s.tabBody}>
      {/* Hero copy button */}
      <Pressable onPress={copyForAI}>
        <Gradient
          colors={[palette.magenta, palette.rose]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={s.heroCopy}
        >
          <Text style={s.heroCopyEmoji}>📋✨</Text>
          <Text style={s.heroCopyTitle}>COPY EVERYTHING FOR AI</Text>
          <Text style={s.heroCopySub}>Diagnostics JSON + last {filtered.length} log lines, formatted</Text>
        </Gradient>
      </Pressable>

      <View style={s.copyRow}>
        <Pressable onPress={copyDiagOnly} style={s.copyHalf}>
          <Text style={s.copyHalfLabel}>📊 Diagnostics only</Text>
        </Pressable>
        <Pressable onPress={copyLogsOnly} style={s.copyHalf}>
          <Text style={s.copyHalfLabel}>📜 Logs only ({filtered.length})</Text>
        </Pressable>
      </View>

      <View style={s.sectionHeader}>
        <Text style={s.sectionHeaderTitle}>📜 LIVE LOGS</Text>
        <Text style={s.sectionHeaderSub}>polled every 5s</Text>
      </View>

      <View style={s.logsToolbar}>
        {['all', 'info', 'warn', 'error'].map((f) => (
          <Pressable
            key={f}
            style={[s.filterChip, filter === f && s.filterChipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[s.filterChipText, filter === f && s.filterChipTextActive]}>
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => { setLogs([]); lastTsRef.current = 0; fetchLogs(); }}
          style={[s.filterChip, { marginLeft: 'auto' }]}
        >
          <Text style={s.filterChipText}>↻ Refresh</Text>
        </Pressable>
      </View>

      {logError ? <Banner tone="error">Log fetch error: {logError}</Banner> : null}

      <View style={s.logsContainer}>
        {filtered.length === 0 ? (
          <Text style={s.logsEmpty}>No logs yet. Engine is quiet.</Text>
        ) : (
          filtered.slice(-200).map((entry, i) => (
            <Text key={`${entry.ts}-${i}`} style={[s.logLine, { color: levelColor(entry.level) }]} selectable>
              <Text style={s.logTs}>{fmtLogTime(entry.ts)} </Text>
              <Text style={[s.logLevel, { color: levelColor(entry.level) }]}>[{entry.level}] </Text>
              {entry.msg}
            </Text>
          ))
        )}
      </View>
    </View>
  );
}

// ----------------------------------------------------------------------------
// TabBar — bottom nav with a glowing active indicator.
// ----------------------------------------------------------------------------
function TabBar({ active, onChange }) {
  const tabs = [
    { id: 'stage', label: 'Stage', emoji: '🎭' },
    { id: 'cast', label: 'Cast', emoji: '🌟' },
    { id: 'backstage', label: 'Backstage', emoji: '🔮' },
    { id: 'send', label: 'Send', emoji: '📋' },
  ];
  return (
    <View style={s.tabBar}>
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <Pressable key={tab.id} style={s.tabButton} onPress={() => onChange(tab.id)}>
            <Text style={[s.tabEmoji, !isActive && { opacity: 0.4 }]}>{tab.emoji}</Text>
            <Text style={[s.tabLabel, isActive && s.tabLabelActive]}>{tab.label}</Text>
            {isActive ? <View style={s.tabActiveBar} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// ----------------------------------------------------------------------------
// ErrorBoundary (preserved from previous frontend).
// ----------------------------------------------------------------------------
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[ErrorBoundary]', error, info?.componentStack); }
  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={[s.root, { justifyContent: 'center', alignItems: 'center', padding: T.sp.xl }]}>
          <StatusBar barStyle="light-content" />
          <Text style={[s.heroCopyEmoji, { fontSize: 48 }]}>🪞</Text>
          <Text style={s.errorTitle}>The mirror cracked</Text>
          <Text style={s.errorMsg}>{String(this.state.error?.message || this.state.error)}</Text>
          <Pressable style={s.errorBtn} onPress={() => this.setState({ error: null })}>
            <Text style={s.errorBtnText}>Try again</Text>
          </Pressable>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

// ----------------------------------------------------------------------------
// App entry.
// ----------------------------------------------------------------------------
export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  const [data, setData] = useState(null);
  const [monitor, setMonitor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('stage');
  const logsRef = useRef([]);
  const activeRef = useRef(true);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      activeRef.current = next === 'active';
    });
    return () => sub.remove();
  }, []);

  const load = useCallback(async ({ isRefresh = false } = {}) => {
    if (!BASE_URL) {
      setLoading(false);
      setRefreshing(false);
      setError('Backend URL not configured. Set EXPO_PUBLIC_BACKEND_URL.');
      return;
    }
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await fetchWithRetry('/dashboard', isRefresh ? 1 : 3);
      setData(payload);
      setError(null);
    } catch (err) {
      const msg = err?.message || 'Request failed';
      const status = err?.status ? `HTTP ${err.status}` : 'Error';
      setError(`${status}: ${msg}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // Monitor heartbeat ring — separate, best-effort fetch. Never blocks or
    // errors the main dashboard load; the panel just shows "—" if it fails.
    try {
      const mon = await apiFetch('/monitor?limit=40');
      setMonitor(mon);
    } catch (_) { /* monitor is non-critical; leave prior value */ }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (activeRef.current) load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = useCallback(() => load({ isRefresh: true }), [load]);

  const meta = data?.meta || {};
  const runtime = meta?.runtime || {};
  const truth = meta?.truth || {};
  const engineState = meta?.engineState ?? runtime?.engineState ?? truth?.engineState;
  const scanInProgress = (truth?.currentEntryScanProgress?.state || '').toLowerCase() === 'scanning';
  const lastScanAt = meta?.lastEntryScanAt ?? truth?.lastEntryScanAt;
  const version = data?.version ?? runtime?.commit ?? meta?.runtime?.version;

  if (loading && !data) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={[s.heroCopyEmoji, { fontSize: 56, marginBottom: T.sp.md }]}>🎭</Text>
          <Text style={[s.heroCopyTitle, { color: palette.cream }]}>MAGIC TRADER</Text>
          <ActivityIndicator color={palette.magenta} size="large" style={{ marginTop: T.sp.lg }} />
          <Text style={[s.statSub, { marginTop: T.sp.md }]}>raising the curtain...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={palette.velvet} />
      <HeaderStrip
        engineState={engineState}
        scanInProgress={scanInProgress}
        lastScanAt={lastScanAt}
        version={version}
        monitor={monitor}
      />

      {error ? <Banner tone="error">{error}</Banner> : null}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: T.sp.xxl + 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.magenta} colors={[palette.magenta]} />}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'stage' && <Stage data={data} activeRef={activeRef} onJumpToCast={() => setTab('cast')} />}
        {tab === 'cast' && <Cast data={data} activeRef={activeRef} />}
        {tab === 'backstage' && <Backstage data={data} monitor={monitor} activeRef={activeRef} />}
        {tab === 'send' && <Send data={data} logsRef={logsRef} activeRef={activeRef} />}
      </ScrollView>

      <TabBar active={tab} onChange={setTab} />
    </SafeAreaView>
  );
}

// ----------------------------------------------------------------------------
// Styles.
// ----------------------------------------------------------------------------
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.velvet,
  },
  // -- Header strip
  headerStrip: {
    paddingHorizontal: T.sp.lg,
    paddingVertical: T.sp.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomColor: palette.velvetEdge,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  headerTitle: {
    color: palette.cream,
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 2.5,
    fontFamily: T.font,
  },
  headerSub: {
    color: palette.fog,
    fontSize: 11,
    marginTop: 1,
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  versionPill: {
    backgroundColor: palette.velvetEdge,
    paddingHorizontal: T.sp.sm,
    paddingVertical: 2,
    borderRadius: 8,
  },
  versionPillText: {
    color: palette.fog,
    fontSize: 9,
    fontFamily: T.fontMono,
    letterSpacing: 0.5,
  },
  // -- Banner
  banner: {
    marginHorizontal: T.sp.lg,
    marginTop: T.sp.sm,
    paddingVertical: T.sp.sm,
    paddingHorizontal: T.sp.md,
    borderWidth: 1,
    borderRadius: T.r.md,
  },
  bannerText: {
    fontSize: 12,
    fontFamily: T.font,
  },
  // -- Tab body
  tabBody: {
    paddingHorizontal: T.sp.lg,
    paddingTop: T.sp.lg,
    paddingBottom: T.sp.lg,
  },
  // -- Money tile
  moneyTile: {
    borderRadius: T.r.lg,
    paddingVertical: T.sp.xl,
    paddingHorizontal: T.sp.lg,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
    marginBottom: T.sp.md,
  },
  moneyMoodRow: { flexDirection: 'row', alignItems: 'center', marginBottom: T.sp.sm },
  moneyMoodLabel: {
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 2,
    fontFamily: T.font,
  },
  moneyValue: {
    color: palette.cream,
    fontSize: 48,
    fontWeight: '800',
    letterSpacing: 0.5,
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  moneySub: {
    fontSize: 13,
    marginTop: T.sp.xs,
    fontFamily: T.font,
  },
  moneyDeltaRow: {
    marginTop: T.sp.md,
    paddingTop: T.sp.sm,
    borderTopColor: palette.velvetEdge,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  moneyDelta: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  moneyDeltaSub: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  // -- Stat triple
  statRow: {
    flexDirection: 'row',
    gap: T.sp.sm,
    marginBottom: T.sp.md,
  },
  statCell: {
    flex: 1,
    backgroundColor: palette.velvetSoft,
    borderRadius: T.r.md,
    padding: T.sp.md,
    borderWidth: 1,
  },
  statLabel: {
    color: palette.fog,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontFamily: T.font,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '800',
    marginTop: T.sp.xs,
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  statSub: {
    color: palette.fog,
    fontSize: 10,
    marginTop: 2,
    fontFamily: T.font,
  },
  // -- Section header
  sectionHeader: {
    marginTop: T.sp.lg,
    marginBottom: T.sp.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  sectionHeaderTitle: {
    color: palette.cream,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 2,
    fontFamily: T.font,
  },
  sectionHeaderSub: {
    color: palette.fog,
    fontSize: 10,
    fontFamily: T.font,
  },
  // -- Cast card (full)
  castCard: {
    borderRadius: T.r.lg,
    padding: T.sp.lg,
    borderLeftWidth: 4,
    marginBottom: T.sp.sm,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
  },
  castHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  castSym: {
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
    fontFamily: T.font,
  },
  castPL: {
    fontSize: 18,
    fontWeight: '800',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  castSubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: T.sp.xs,
  },
  castPct: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  castMeta: {
    color: palette.fog,
    fontSize: 11,
    fontFamily: T.font,
  },
  castPriceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: T.sp.sm,
  },
  castPriceLabel: {
    color: palette.fog,
    fontSize: 9,
    flex: 1,
    fontFamily: T.font,
    letterSpacing: 0.5,
  },
  castPriceVal: {
    color: palette.cream,
    fontSize: 13,
    flex: 1,
    fontWeight: '600',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
  },
  castFooter: {
    marginTop: T.sp.md,
    paddingTop: T.sp.sm,
    borderTopColor: palette.velvetEdge,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  castFooterText: {
    color: palette.pearl,
    fontSize: 11,
    fontFamily: T.font,
  },
  // -- Compact cast card (Stage preview)
  compactCard: {
    backgroundColor: palette.velvetSoft,
    borderRadius: T.r.md,
    padding: T.sp.md,
    marginBottom: T.sp.xs,
    borderLeftWidth: 3,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
  },
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  compactSym: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: T.font,
    flex: 1,
  },
  compactPct: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
    marginRight: T.sp.md,
  },
  compactPL: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
    minWidth: 70,
    textAlign: 'right',
  },
  compactMeta: {
    color: palette.fog,
    fontSize: 9,
    marginTop: T.sp.xs,
    fontFamily: T.font,
  },
  // -- Pulse / box-office tile
  pulseTile: {
    borderRadius: T.r.md,
    padding: T.sp.md,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
  },
  pulseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: T.sp.xs,
  },
  pulseLabel: {
    color: palette.fog,
    fontSize: 11,
    fontFamily: T.font,
    letterSpacing: 0.5,
  },
  pulseValue: {
    color: palette.cream,
    fontSize: 13,
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  // -- Reasons tile
  reasonsTile: {
    backgroundColor: palette.velvetSoft,
    borderRadius: T.r.md,
    padding: T.sp.md,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
  },
  reasonLabel: {
    color: palette.cream,
    fontSize: 11,
    fontFamily: T.fontMono,
  },
  reasonCount: {
    color: palette.fog,
    fontSize: 11,
    fontFamily: T.fontMono,
  },
  // -- Box office (scorecard)
  boxOffice: {
    borderRadius: T.r.md,
    padding: T.sp.md,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
    marginBottom: T.sp.sm,
  },
  boRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: T.sp.sm,
    borderBottomColor: palette.velvetEdge,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  boLabel: {
    color: palette.fog,
    fontSize: 12,
    fontFamily: T.font,
    letterSpacing: 0.3,
  },
  boValue: {
    color: palette.cream,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
    maxWidth: '60%',
    textAlign: 'right',
  },
  // -- Empty state
  emptyTile: {
    backgroundColor: palette.velvetSoft,
    borderRadius: T.r.md,
    padding: T.sp.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: palette.velvetEdge,
  },
  emptyTitle: {
    color: palette.gold,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: T.font,
    marginBottom: T.sp.xs,
  },
  emptyBody: {
    color: palette.fog,
    fontSize: 12,
    textAlign: 'center',
    fontFamily: T.font,
  },
  // -- Hero copy button
  heroCopy: {
    borderRadius: T.r.lg,
    paddingVertical: T.sp.xl,
    paddingHorizontal: T.sp.lg,
    alignItems: 'center',
    shadowColor: palette.magenta,
    shadowOpacity: 0.4,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 16,
    elevation: 6,
    marginBottom: T.sp.md,
  },
  heroCopyEmoji: {
    fontSize: 36,
    marginBottom: T.sp.xs,
  },
  heroCopyTitle: {
    color: palette.cream,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 2.5,
    textAlign: 'center',
    fontFamily: T.font,
  },
  heroCopySub: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: T.sp.xs,
    fontFamily: T.font,
  },
  copyRow: {
    flexDirection: 'row',
    gap: T.sp.sm,
    marginBottom: T.sp.md,
  },
  copyHalf: {
    flex: 1,
    backgroundColor: palette.velvetSoft,
    paddingVertical: T.sp.md,
    borderRadius: T.r.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: palette.velvetEdge,
  },
  copyHalfLabel: {
    color: palette.cream,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: T.font,
  },
  // -- Logs
  logsToolbar: {
    flexDirection: 'row',
    gap: T.sp.xs,
    marginBottom: T.sp.sm,
    flexWrap: 'wrap',
  },
  filterChip: {
    paddingVertical: T.sp.xs,
    paddingHorizontal: T.sp.sm,
    borderRadius: T.r.sm,
    backgroundColor: palette.velvetSoft,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
  },
  filterChipActive: {
    backgroundColor: palette.magentaSoft,
    borderColor: palette.magenta,
  },
  filterChipText: {
    color: palette.pearl,
    fontSize: 11,
    fontFamily: T.font,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: palette.cream,
  },
  logsContainer: {
    backgroundColor: palette.ink,
    borderRadius: T.r.md,
    padding: T.sp.md,
    borderWidth: 1,
    borderColor: palette.velvetEdge,
    minHeight: 200,
  },
  logsEmpty: {
    color: palette.fog,
    textAlign: 'center',
    paddingVertical: T.sp.xl,
    fontFamily: T.font,
    fontSize: 12,
  },
  logLine: {
    fontSize: 11,
    fontFamily: T.fontMono,
    paddingVertical: 1,
    lineHeight: 15,
  },
  logTs: {
    color: palette.fog,
    fontFamily: T.fontMono,
  },
  logLevel: {
    fontFamily: T.fontMono,
    fontSize: 10,
  },
  // -- Tab bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: palette.velvet,
    borderTopColor: palette.velvetEdge,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: Platform.OS === 'ios' ? 24 : T.sp.sm,
    paddingTop: T.sp.sm,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: T.sp.xs,
    position: 'relative',
  },
  tabEmoji: {
    fontSize: 22,
    marginBottom: 2,
  },
  tabLabel: {
    color: palette.fog,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    fontFamily: T.font,
  },
  tabLabelActive: {
    color: palette.cream,
  },
  tabActiveBar: {
    position: 'absolute',
    bottom: 0,
    width: 28,
    height: 3,
    borderRadius: 2,
    backgroundColor: palette.magenta,
    shadowColor: palette.magenta,
    shadowOpacity: 0.8,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 6,
  },
  // -- Error fallback
  errorTitle: {
    color: palette.cream,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 2,
    marginTop: T.sp.md,
    textAlign: 'center',
    fontFamily: T.font,
  },
  errorMsg: {
    color: palette.fog,
    fontSize: 13,
    marginTop: T.sp.sm,
    textAlign: 'center',
    fontFamily: T.fontMono,
  },
  errorBtn: {
    marginTop: T.sp.xl,
    paddingHorizontal: T.sp.xl,
    paddingVertical: T.sp.md,
    backgroundColor: palette.magenta,
    borderRadius: T.r.md,
  },
  errorBtnText: {
    color: palette.cream,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontFamily: T.font,
  },
  // -- Per-token enrichments (2026-05-31 redesign)
  castStateBadge: {
    color: palette.gold,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    marginLeft: T.sp.sm,
    paddingHorizontal: T.sp.sm,
    paddingVertical: 1,
    borderRadius: T.r.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.goldDim,
    overflow: 'hidden',
    fontFamily: T.font,
  },
  castChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: T.sp.xs,
    marginTop: T.sp.md,
  },
  chip: {
    paddingHorizontal: T.sp.sm,
    paddingVertical: 2,
    borderRadius: T.r.sm,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: palette.velvet,
    marginRight: T.sp.xs,
    marginBottom: T.sp.xs,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
    fontFamily: T.font,
  },
  // -- Watchlist / scan board
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: T.sp.sm,
    paddingHorizontal: T.sp.md,
    backgroundColor: palette.velvetSoft,
    borderRadius: T.r.md,
    marginBottom: T.sp.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.velvetEdge,
  },
  scanSym: {
    color: palette.cream,
    fontSize: 14,
    fontWeight: '800',
    fontFamily: T.font,
    minWidth: 56,
  },
  scanStatus: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: T.font,
    letterSpacing: 0.3,
  },
  scanSub: {
    color: palette.fog,
    fontSize: 10,
    fontFamily: T.font,
    marginTop: 1,
  },
  scanEdge: {
    fontSize: 12,
    fontWeight: '800',
    fontFamily: T.font,
    fontVariant: ['tabular-nums'],
    minWidth: 56,
    textAlign: 'right',
  },
  scanLegend: {
    color: palette.fog,
    fontSize: 9,
    fontFamily: T.font,
    marginTop: T.sp.xs,
    fontStyle: 'italic',
  },
  // -- Monitor (header pill + Backstage panel)
  monPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: T.sp.sm,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: palette.velvet,
    maxWidth: 132,
  },
  monDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 5,
  },
  monPillText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.3,
    fontFamily: T.font,
  },
  monVerdictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: T.sp.sm,
  },
  monVerdict: {
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1,
    marginLeft: T.sp.sm,
    fontFamily: T.font,
  },
  monLegend: {
    color: palette.fog,
    fontSize: 9,
    fontFamily: T.font,
    marginTop: T.sp.md,
    fontStyle: 'italic',
  },
  monHistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    borderBottomColor: palette.velvetEdge,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  monHistTime: {
    color: palette.pearl,
    fontSize: 10,
    fontFamily: T.font,
    width: 74,
    marginLeft: T.sp.xs,
  },
  monHistMid: {
    color: palette.cream,
    fontSize: 11,
    fontFamily: T.font,
    flex: 1,
  },
  monHistFlag: {
    color: palette.rose,
    fontSize: 9,
    fontWeight: '800',
    fontFamily: T.font,
    marginLeft: T.sp.xs,
  },
});
