// Magic Money — phone dashboard for the trading bot (rebuilt 2026-08-03).
//
// A clean, read-only monitor for the bot's live state. Polls the backend's
// public /dashboard endpoint and renders equity, open positions, the
// performance scorecard, the safety brake, and recent activity — tuned for a
// glance on your phone.
//
// Config:
//   EXPO_PUBLIC_BACKEND_URL — base URL (default https://magic-lw8t.onrender.com)
//   EXPO_PUBLIC_API_TOKEN   — only needed if the deploy protects /dashboard
//
// The /dashboard endpoint is public on the production deploy, so no token is
// needed for the default host.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SafeAreaView, ScrollView, View, Text, StyleSheet, RefreshControl,
  ActivityIndicator, StatusBar, TouchableOpacity, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

// ---- config ---------------------------------------------------------------
const DEFAULT_BACKEND_URL = 'https://magic-lw8t.onrender.com';
const REFRESH_MS = 10000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
function resolveBackend() {
  const env = typeof process !== 'undefined' ? process?.env : {};
  const baseUrl = str(env?.EXPO_PUBLIC_BACKEND_URL) || DEFAULT_BACKEND_URL;
  const apiToken = str(env?.EXPO_PUBLIC_API_TOKEN);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiToken };
}
const { baseUrl: BASE_URL, apiToken: API_TOKEN } = resolveBackend();

// ---- theme ----------------------------------------------------------------
const C = {
  bg: '#0b0f17', card: '#141a26', card2: '#1b2333', line: '#243044',
  text: '#e8edf5', dim: '#8a97ad', faint: '#5c6a80',
  up: '#2ecc71', down: '#ff5b6a', accent: '#5b8cff', warn: '#ffb020', gold: '#f5c451',
};

// ---- formatters -----------------------------------------------------------
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
function usd(v, dp = 2) {
  const n = num(v); if (n == null) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
function pct(v, dp = 2) { const n = num(v); return n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(dp)}%`; }
function pctRaw(v, dp = 1) { const n = num(v); return n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`; }
function bps(v, dp = 1) { const n = num(v); return n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)} bps`; }
function ago(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const shorten = (s) => String(s || '').replace('/USD', '');

// ---- data fetch -----------------------------------------------------------
async function fetchDashboard() {
  if (!BASE_URL) { const e = new Error('Backend URL not configured. Set EXPO_PUBLIC_BACKEND_URL.'); e.code = 'noconfig'; throw e; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { Accept: 'application/json' };
    if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
    const res = await fetch(`${BASE_URL}/dashboard`, { headers, signal: controller.signal });
    if (res.status === 503) { const e = new Error('The service is suspended (paused) on Render.'); e.code = 'suspended'; throw e; }
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// ---- small UI pieces ------------------------------------------------------
function Badge({ label, tone = 'accent' }) {
  const bg = { accent: '#1c2b52', up: '#123524', down: '#3a1620', warn: '#3a2c10', dim: '#222a38' }[tone] || '#222a38';
  const fg = { accent: C.accent, up: C.up, down: C.down, warn: C.warn, dim: C.dim }[tone] || C.dim;
  return <View style={[s.badge, { backgroundColor: bg }]}><Text style={[s.badgeText, { color: fg }]}>{label}</Text></View>;
}
function Card({ title, right, children }) {
  return (
    <View style={s.card}>
      {(title || right) && (
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>{title}</Text>
          {right}
        </View>
      )}
      {children}
    </View>
  );
}
function Stat({ label, value, tone }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, tone && { color: tone }]}>{value}</Text>
    </View>
  );
}

// ---- screen ---------------------------------------------------------------
export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const mounted = useRef(true);

  const load = useCallback(async (isPull) => {
    if (isPull) setRefreshing(true);
    try {
      const json = await fetchDashboard();
      if (!mounted.current) return;
      setData(json); setError(null); setUpdatedAt(Date.now());
    } catch (e) {
      if (!mounted.current) return;
      setError(e?.message || 'Failed to reach the bot.');
    } finally {
      if (!mounted.current) return;
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load(false);
    const id = setInterval(() => load(false), REFRESH_MS);
    return () => { mounted.current = false; clearInterval(id); };
  }, [load]);

  const meta = data?.meta || {};
  const account = data?.account || null;
  const positions = Array.isArray(data?.positions) ? data.positions : [];
  const epoch = meta.performanceEpoch || {};
  const scorecard = epoch.scorecard || meta.scorecard || {};
  const veto = meta?.signalSelector?.realizedVeto || null;

  const equity = num(account?.equity) ?? num(meta.latestEquity);
  const cash = num(account?.cash);
  const venue = str(account?.raw_venue) || (account ? 'live' : null);
  const paused = error && /suspend/i.test(error);

  const signalVersion = str(veto?.signalVersion)
    || str(meta?.activeSignalVersion)
    || str(meta?.signalSelector?.signalVersion) || '—';
  const regime = str(meta?.marketRegime?.regime);
  const engineState = str(meta?.engineState);
  const pnlUsd = num(epoch.pnlUsd);
  const pctChange = num(epoch.pctChange);

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.accent} />}
      >
        {/* header */}
        <View style={s.headerRow}>
          <View>
            <Text style={s.brand}>Magic Money</Text>
            <Text style={s.brandSub}>
              {updatedAt ? `updated ${ago(updatedAt)}` : 'connecting…'}
              {'  ·  '}{BASE_URL.replace(/^https?:\/\//, '')}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            {venue ? <Badge label={venue.toUpperCase()} tone={venue === 'paper' ? 'accent' : 'warn'} /> : null}
            {engineState ? <Badge label={engineState} tone={engineState === 'ready' ? 'up' : 'dim'} /> : null}
          </View>
        </View>

        {loading && !data ? (
          <View style={s.center}><ActivityIndicator color={C.accent} /><Text style={s.dim}>Loading the bot…</Text></View>
        ) : null}

        {error ? (
          <View style={[s.card, { borderColor: paused ? C.warn : C.down }]}>
            <Text style={{ color: paused ? C.warn : C.down, fontWeight: '700', marginBottom: 4 }}>
              {paused ? 'Service paused' : 'Can’t reach the bot'}
            </Text>
            <Text style={s.dim}>{error}</Text>
            {paused ? <Text style={[s.faint, { marginTop: 6 }]}>Resume it in Render, then it’ll appear here.</Text> : null}
            <TouchableOpacity style={s.retry} onPress={() => load(true)}><Text style={s.retryText}>Retry</Text></TouchableOpacity>
          </View>
        ) : null}

        {data ? (
          <>
            {/* equity hero */}
            <LinearGradient colors={['#1a2340', '#141a26']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.hero}>
              <Text style={s.heroLabel}>Portfolio value</Text>
              <Text style={s.heroEquity}>{usd(equity)}</Text>
              <View style={s.heroRow}>
                <Text style={s.heroMeta}>Cash {usd(cash)}</Text>
                {pnlUsd != null ? (
                  <Text style={[s.heroMeta, { color: pnlUsd >= 0 ? C.up : C.down }]}>
                    Since reset {pnlUsd >= 0 ? '+' : ''}{usd(pnlUsd)} {pctChange != null ? `(${pctRaw(pctChange)})` : ''}
                  </Text>
                ) : null}
              </View>
              {account == null ? <Text style={[s.faint, { marginTop: 6 }]}>Waiting for account — check EXECUTION_VENUE is set.</Text> : null}
            </LinearGradient>

            {/* engine / signal row */}
            <Card title="Engine">
              <View style={s.grid}>
                <Stat label="Strategy" value={signalVersion} />
                <Stat label="Regime" value={regime || '—'} />
                <Stat
                  label="Safety brake"
                  value={veto ? (veto.veto ? 'HALTED' : 'armed') : '—'}
                  tone={veto ? (veto.veto ? C.down : C.up) : C.dim}
                />
              </View>
              {veto ? (
                <Text style={s.faint}>
                  realized {bps(veto.realizedAvgNetBps)} / floor {bps(veto.floorBps)} over {veto.sampleSize ?? 0} trades
                  {veto.veto && veto.clearsInMs ? `  ·  clears in ~${Math.round(veto.clearsInMs / 3600000)}h` : ''}
                </Text>
              ) : null}
            </Card>

            {/* scorecard */}
            <Card title="Performance" right={scorecard.totalClosedTrades != null ? <Text style={s.faint}>{scorecard.totalClosedTrades} trades</Text> : null}>
              <View style={s.grid}>
                <Stat label="Win rate" value={scorecard.winRate != null ? `${(scorecard.winRate * 100).toFixed(0)}%` : '—'} />
                <Stat
                  label="Avg / trade"
                  value={bps(scorecard.avgRealizedNetBps)}
                  tone={num(scorecard.avgRealizedNetBps) >= 0 ? C.up : C.down}
                />
                <Stat
                  label="Profit factor"
                  value={num(scorecard.profitFactor) != null ? Number(scorecard.profitFactor).toFixed(2) : '—'}
                  tone={num(scorecard.profitFactor) >= 1 ? C.up : C.down}
                />
              </View>
              {num(scorecard.expectancyUsd) != null ? (
                <Text style={s.faint}>expectancy {scorecard.expectancyUsd >= 0 ? '+' : ''}{usd(scorecard.expectancyUsd, 3)} / trade</Text>
              ) : null}
            </Card>

            {/* positions */}
            <Card title="Open positions" right={<Text style={s.faint}>{positions.length}</Text>}>
              {positions.length === 0 ? (
                <Text style={s.dim}>Flat — no open positions. A daily trend-follower sits in cash a lot; that’s normal.</Text>
              ) : positions.map((p, i) => {
                const entry = num(p.avg_entry_price);
                const cur = num(p.current_price);
                const plpc = entry && cur ? (cur - entry) / entry : num(p.unrealized_plpc);
                const up = num(plpc) >= 0;
                return (
                  <View key={`${p.symbol}-${i}`} style={[s.posRow, i > 0 && s.posDivider]}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.posSym}>{shorten(p.symbol)}</Text>
                      <Text style={s.faint}>{usd(p.market_value)} · entry {usd(entry, entry < 1 ? 4 : 2)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[s.posPct, { color: up ? C.up : C.down }]}>{plpc != null ? pct(plpc) : '—'}</Text>
                      <Text style={s.faint}>{cur != null ? usd(cur, cur < 1 ? 4 : 2) : '—'}</Text>
                    </View>
                  </View>
                );
              })}
            </Card>

            {/* recent activity */}
            {Array.isArray(data.events) && data.events.length ? (
              <Card title="Recent activity">
                {data.events.slice(0, 8).map((e, i) => {
                  const label = str(e?.event) || str(e?.type) || str(e?.msg) || 'event';
                  const sym = str(e?.symbol);
                  const t = e?.ts || e?.at || e?.time;
                  return (
                    <View key={i} style={[s.evtRow, i > 0 && s.posDivider]}>
                      <Text style={s.evtLabel} numberOfLines={1}>{sym ? `${shorten(sym)} · ` : ''}{label}</Text>
                      <Text style={s.faint}>{t ? ago(t) : ''}</Text>
                    </View>
                  );
                })}
              </Card>
            ) : null}

            <Text style={s.footer}>
              Read-only monitor · pull down to refresh · auto-updates every {REFRESH_MS / 1000}s
            </Text>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 16, paddingBottom: 40 },
  center: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  brand: { color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: 0.2 },
  brandSub: { color: C.faint, fontSize: 11, marginTop: 2 },
  hero: { borderRadius: 18, padding: 20, marginBottom: 14, borderWidth: 1, borderColor: C.line },
  heroLabel: { color: C.dim, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  heroEquity: { color: C.text, fontSize: 40, fontWeight: '800', marginTop: 4, ...Platform.select({ ios: { fontVariant: ['tabular-nums'] }, default: {} }) },
  heroRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, flexWrap: 'wrap', gap: 6 },
  heroMeta: { color: C.dim, fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: C.line },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  grid: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  stat: { flex: 1 },
  statLabel: { color: C.faint, fontSize: 11, marginBottom: 3 },
  statValue: { color: C.text, fontSize: 17, fontWeight: '700' },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 8 },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  posRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  posDivider: { borderTopWidth: 1, borderTopColor: C.line },
  posSym: { color: C.text, fontSize: 16, fontWeight: '700' },
  posPct: { fontSize: 16, fontWeight: '800' },
  evtRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  evtLabel: { color: C.dim, fontSize: 13, flex: 1, marginRight: 8 },
  dim: { color: C.dim, fontSize: 13, lineHeight: 19 },
  faint: { color: C.faint, fontSize: 11, marginTop: 4 },
  retry: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: C.card2, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: C.line },
  retryText: { color: C.accent, fontWeight: '700' },
  footer: { color: C.faint, fontSize: 11, textAlign: 'center', marginTop: 8 },
});
