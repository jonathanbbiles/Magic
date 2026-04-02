import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const theme = {
  colors: {
    bg: '#070A12',
    text: 'rgba(255,255,255,0.92)',
    muted: 'rgba(255,255,255,0.65)',
    faint: 'rgba(255,255,255,0.45)',
    card: '#0B1220',
    cardAlt: '#0F1730',
    positive: '#72FFB6',
    negative: '#FF5C8A',
    warning: '#FFD36E',
    border: 'rgba(255,255,255,0.10)',
    glowPos: 'rgba(114,255,182,0.55)',
    glowNeg: 'rgba(255,92,138,0.55)',
    errorBg: 'rgba(255,60,90,0.18)',
    errorText: 'rgba(255,220,230,0.95)',
  },
  spacing: { xs: 6, sm: 10, md: 14, lg: 18, xl: 24 },
  radius: { md: 14, lg: 18, xl: 24 },
};

const POLL_MS = 20000;

const BASE_URL =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_BACKEND_URL) ||
  'https://magic-lw8t.onrender.com';

const API_TOKEN =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_API_TOKEN) || '';
const DASHBOARD_FETCH_TIMEOUT_MS = 20000;
const DASHBOARD_INITIAL_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchDashboard() {
  const url = `${String(BASE_URL).replace(/\/$/, '')}/dashboard`;
  const headers = { Accept: 'application/json' };
  if (API_TOKEN) {
    headers.Authorization = `Bearer ${API_TOKEN}`;
    headers['x-api-key'] = API_TOKEN;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DASHBOARD_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error(`Request timed out after ${Math.round(DASHBOARD_FETCH_TIMEOUT_MS / 1000)}s`);
      timeoutErr.status = 408;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const err = new Error(json?.error || json?.message || text || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return json;
}

function isTransientFetchError(err) {
  const status = Number(err?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('network')
  );
}

async function fetchDashboardWithRetry({ retries = 0 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchDashboard();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientFetchError(err)) throw err;
      await sleep(Math.min(1500 * (attempt + 1), 5000));
    }
  }
  throw lastErr;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function usd(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${abs}`;
}

function pct(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function minsSince(isoTs) {
  const ms = Date.parse(String(isoTs || ''));
  if (!Number.isFinite(ms)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  return `${mins}m`;
}

function ageLabelFromPosition(position) {
  const heldDirect = toNum(position?.heldSeconds);
  if (Number.isFinite(heldDirect) && heldDirect >= 0) {
    const mins = Math.floor(heldDirect / 60);
    const rem = Math.floor(heldDirect % 60);
    return `${mins}m ${rem}s`;
  }
  const heldSnake = toNum(position?.held_seconds);
  if (Number.isFinite(heldSnake) && heldSnake >= 0) {
    const mins = Math.floor(heldSnake / 60);
    const rem = Math.floor(heldSnake % 60);
    return `${mins}m ${rem}s`;
  }
  const createdMs = Date.parse(String(position?.created_at || ''));
  if (Number.isFinite(createdMs)) {
    const seconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
    const mins = Math.floor(seconds / 60);
    const rem = Math.floor(seconds % 60);
    return `${mins}m ${rem}s`;
  }
  return '—';
}

function ageLabelShort(position) {
  const heldDirect = toNum(position?.heldSeconds);
  if (Number.isFinite(heldDirect) && heldDirect >= 0) {
    return `${Math.floor(heldDirect / 60)}m`;
  }
  const heldSnake = toNum(position?.held_seconds);
  if (Number.isFinite(heldSnake) && heldSnake >= 0) {
    return `${Math.floor(heldSnake / 60)}m`;
  }
  const createdMs = Date.parse(String(position?.created_at || ''));
  if (Number.isFinite(createdMs)) {
    const seconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
    return `${Math.floor(seconds / 60)}m`;
  }
  return '—';
}


function distToTargetPct(position) {
  const current = toNum(position?.current_price);
  const sellLimit =
    toNum(position?.sell?.activeLimit) ??
    toNum(position?.bot?.sellOrderLimit);

  if (!Number.isFinite(current) || !Number.isFinite(sellLimit) || current === 0) return null;
  return ((sellLimit - current) / current) * 100;
}

function Chip({ value }) {
  return (
    <View style={headerStyles.chip}>
      <Text style={headerStyles.chipValue}>{value}</Text>
    </View>
  );
}

function CompactPositionRow({ position }) {
  const symbol = position?.symbol || '—';

  const upnl = toNum(position?.unrealized_pl);
  const upnlPctRaw = toNum(position?.unrealized_plpc);
  const upnlPct = Number.isFinite(upnlPctRaw) ? upnlPctRaw * 100 : null;
  const pnlPositive = (upnl || 0) >= 0;

  const dist = distToTargetPct(position);

  const distText = Number.isFinite(dist) ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '—';
  const pnlDollar = signedUsd(upnl);
  const pnlPercent = pct(upnlPct);
  const timeShort = ageLabelShort(position);

  const glow = pnlPositive ? theme.colors.glowPos : theme.colors.glowNeg;

  return (
    <View style={[compactStyles.tile, { borderColor: glow }]}>
      <View style={compactStyles.line1}>
        <Text style={compactStyles.sym} numberOfLines={1} ellipsizeMode="tail">
          {symbol}
        </Text>
        <Text style={compactStyles.delta} numberOfLines={1} ellipsizeMode="tail">
          Δ🎯 {distText}
        </Text>
      </View>

      <View style={compactStyles.line2}>
        <Text
          style={[compactStyles.pnl, { color: pnlPositive ? theme.colors.positive : theme.colors.negative }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          📌 {pnlDollar} ({pnlPercent})
        </Text>

        <Text style={compactStyles.timeInline} numberOfLines={1} ellipsizeMode="tail">
          ⏱️ {timeShort}
        </Text>
      </View>
    </View>
  );
}

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(async ({ isRefresh = false } = {}) => {
    if (isRefresh) setRefreshing(true);
    if (!isRefresh) setLoading(true);
    try {
      const payload = await fetchDashboardWithRetry({ retries: isRefresh ? 1 : DASHBOARD_INITIAL_RETRIES });
      setDashboard(payload);
      setError(null);
    } catch (err) {
      const message = err?.message || 'Request failed';
      const status = err?.status ? `HTTP ${err.status}` : 'HTTP ?';
      setError(`${status}: ${message}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const positions = useMemo(() => {
    const list = Array.isArray(dashboard?.positions) ? dashboard.positions.slice() : [];

    list.sort((a, b) => {
      const aDist = distToTargetPct(a);
      const bDist = distToTargetPct(b);
      if (!Number.isFinite(aDist)) return 1;
      if (!Number.isFinite(bDist)) return -1;
      return aDist - bDist; // closest to fill first
    });

    return list;
  }, [dashboard]);

  const account = dashboard?.account || {};
  const portfolioValue = account?.portfolio_value ?? account?.equity;

  const weeklyChangePct = toNum(dashboard?.meta?.weeklyChangePct);

  const openPL = useMemo(() => positions.reduce((sum, p) => sum + (toNum(p?.unrealized_pl) || 0), 0), [positions]);

  const openPLPct = useMemo(() => {
    const mv = positions.reduce((sum, p) => sum + (toNum(p?.market_value) || 0), 0);
    if (!Number.isFinite(mv) || mv <= 0) return null;
    return (openPL / mv) * 100;
  }, [positions, openPL]);
  const entryDiagnostics = dashboard?.diagnostics || {};
  const entryScan = entryDiagnostics?.entryScan || null;
  const predictorCandidates = entryDiagnostics?.predictorCandidates || null;
  const skipReasonsBySymbol = entryDiagnostics?.skipReasonsBySymbol || {};
  const topCandidate = Array.isArray(predictorCandidates?.topCandidates) ? predictorCandidates.topCandidates[0] : null;
  const firstSkipSymbol = Object.keys(skipReasonsBySymbol)[0] || null;
  const firstSkip = firstSkipSymbol && Array.isArray(skipReasonsBySymbol[firstSkipSymbol])
    ? skipReasonsBySymbol[firstSkipSymbol][0]
    : null;
  const meta = dashboard?.meta || {};
  const scorecard = meta?.scorecard || {};
  const sizing = meta?.sizing || {};
  const risk = meta?.risk || {};
  const concurrency = meta?.concurrency || {};
  const quoteFreshness = meta?.quoteFreshness || {};
  const universe = meta?.universe || {};
  const warmup = meta?.predictorWarmup || {};
  const warmupStatus = meta?.predictorWarmupStatus || {};
  const warmupInProgress = Boolean(warmup?.inProgress);
  const truth = meta?.truth || {};
  const runtime = meta?.runtime || {};
  const backendReachable = truth?.backendReachable !== false;
  const alpacaConnected = runtime?.alpacaCredentialsPresent ?? meta?.connectionState?.alpaca?.alpacaAuthOk ?? false;
  const authEnabled = runtime?.apiTokenEnabled ?? truth?.authConfigured ?? false;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={[theme.colors.bg, '#130A26']} style={styles.screen}>
        <FlatList
          data={positions}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          keyExtractor={(item) => String(item?.symbol || 'unknown')}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} tintColor="#fff" />
          }
          ListHeaderComponent={
            <View style={headerStyles.wrap}>
              <View style={headerStyles.topRow}>
                <Text style={headerStyles.title}>🎩 Magic Money</Text>
                <Text style={headerStyles.titleRight}>{usd(portfolioValue)}</Text>
              </View>

              <View style={headerStyles.chipsRow}>
                <Chip value={`Weekly: ${Number.isFinite(weeklyChangePct) ? pct(weeklyChangePct) : '—'}`} />
              </View>

              <View style={headerStyles.openRow}>
                <Text style={headerStyles.openLine}>Open P/L: {signedUsd(openPL)} ({pct(openPLPct)})</Text>
              </View>

              <View style={styles.diagnosticsBlock}>
                <Text style={styles.diagnosticsTitle}>Runtime truth</Text>
                <Text style={styles.diagnosticsText}>{JSON.stringify({
                  backendReachable,
                  alpacaConnected,
                  authEnabled,
                  dynamicUniverseActive: meta?.dynamicUniverseActive ?? runtime?.dynamicUniverseActive ?? truth?.dynamicUniverseActive ?? universe?.dynamicUniverseActive ?? false,
                  acceptedSymbolsCount: meta?.acceptedSymbolsCount ?? runtime?.acceptedSymbolsCount ?? truth?.acceptedSymbolsCount ?? universe?.acceptedSymbolsCount ?? 0,
                  engineState: meta?.engineState ?? runtime?.engineState ?? truth?.engineState ?? '—',
                  ratePressureState: truth?.ratePressureState ?? runtime?.ratePressureState ?? null,
                  warmupInProgress: warmupStatus?.inProgress ?? runtime?.predictorWarmup?.inProgress ?? truth?.warmupInProgress ?? warmupInProgress,
                  seedingProgress: truth?.seedingProgress ?? null,
                  marketRejectionCount: truth?.marketRejectionCount ?? 0,
                  dataRejectionCount: truth?.dataRejectionCount ?? 0,
                  fallbackSuppressionCount: truth?.fallbackSuppressionCount ?? 0,
                  topSkipReasons: truth?.topSkipReasons ?? entryScan?.topSkipReasons ?? {},
                  signalBlockedByWarmupCount: truth?.signalBlockedByWarmupCount ?? entryScan?.signalBlockedByWarmupCount ?? 0,
                  openPositions: truth?.openPositions ?? positions.length,
                  activeSellLimits: truth?.activeSellLimits ?? positions.filter((p) => Number.isFinite(toNum(p?.sell?.activeLimit))).length,
                })}</Text>
              </View>
              <View style={styles.diagnosticsBlock}>
                <Text style={styles.diagnosticsTitle}>Entry diagnostics</Text>
                <Text style={styles.diagnosticsText}>
                  Last scan: scanned={toNum(entryScan?.scanned) ?? '—'} placed={toNum(entryScan?.placed) ?? '—'} skipped={toNum(entryScan?.skipped) ?? '—'}
                </Text>
                <Text style={styles.diagnosticsText}>
                  Top skip reasons: {entryScan?.topSkipReasons ? JSON.stringify(entryScan.topSkipReasons) : '—'}
                </Text>
                <Text style={styles.diagnosticsText}>
                  Signals: ready={toNum(entryScan?.signalReadyCount) ?? 0} blockedByWarmup={toNum(entryScan?.signalBlockedByWarmupCount) ?? 0} staleQuoteSkips={toNum(entryScan?.staleEntryQuoteSkips) ?? 0}
                </Text>
                <Text style={styles.diagnosticsText}>
                  Predictor candidates: {predictorCandidates?.topCandidates ? JSON.stringify(predictorCandidates.topCandidates) : '—'}
                </Text>
                <Text style={styles.diagnosticsText}>
                  Top candidate detail: {topCandidate ? JSON.stringify({
                    symbol: topCandidate.symbol,
                    requiredEdgeBps: topCandidate.requiredEdgeBps,
                    netEdgeBps: topCandidate.netEdgeBps,
                    quoteAgeMs: topCandidate.quoteAgeMs,
                    quoteTsMs: topCandidate.quoteTsMs,
                    quoteReceivedAtMs: topCandidate.quoteReceivedAtMs,
                    regimeLabel: topCandidate.regimeLabel,
                    regimePenaltyBps: topCandidate.regimePenaltyBps,
                    dataQualityReason: topCandidate.dataQualityReason,
                    sparseRetry: topCandidate.sparseRetry,
                  }) : '—'}
                </Text>
                <Text style={styles.diagnosticsText}>
                  Per-symbol skips: {Object.keys(skipReasonsBySymbol).length ? JSON.stringify(skipReasonsBySymbol) : '—'}
                </Text>
                <Text style={styles.diagnosticsText}>
                  First skip detail: {firstSkip ? JSON.stringify({
                    symbol: firstSkipSymbol,
                    reason: firstSkip.reason,
                    requiredEdgeBps: firstSkip.requiredEdgeBps,
                    netEdgeBps: firstSkip.netEdgeBps,
                    quoteAgeMs: firstSkip.quoteAgeMs,
                    quoteTsMs: firstSkip.quoteTsMs,
                    quoteReceivedAtMs: firstSkip.quoteReceivedAtMs,
                    regimeLabel: firstSkip.regimeLabel,
                    regimePenaltyBps: firstSkip.regimePenaltyBps,
                    dataQualityReason: firstSkip.dataQualityReason,
                    sparseRetry: firstSkip.sparseRetry,
                  }) : '—'}
                </Text>
              </View>
              <View style={styles.diagnosticsBlock}>
                <Text style={styles.diagnosticsTitle}>Closed-trade scorecard</Text>
                <Text style={styles.diagnosticsText}>{JSON.stringify(scorecard)}</Text>
                <Text style={styles.diagnosticsTitle}>Sizing / concurrency</Text>
                <Text style={styles.diagnosticsText}>{JSON.stringify({
                  mode: sizing?.activeMode,
                  kellyEnabled: sizing?.kellyEnabled,
                  kellyShadowMode: sizing?.kellyShadowMode,
                  activeSlotsUsed: concurrency?.activeSlotsUsed,
                  cap: concurrency?.capMaxEffective,
                })}</Text>
                <Text style={styles.diagnosticsTitle}>Quote freshness / guards</Text>
                <Text style={styles.diagnosticsText}>{JSON.stringify({
                  entryQuoteMaxAgeMs: quoteFreshness?.entryQuoteMaxAgeMs,
                  entryRegimeStaleQuoteMaxAgeMs: quoteFreshness?.entryRegimeStaleQuoteMaxAgeMs,
                  sparseRequireQuoteFreshMs: quoteFreshness?.sparseRequireQuoteFreshMs,
                  sparseStaleQuoteToleranceMs: quoteFreshness?.sparseStaleQuoteToleranceMs,
                  staleEntryQuoteSkips: quoteFreshness?.staleEntryQuoteSkips,
                  staleQuoteRejectionCount: truth?.staleQuoteRejectionCount ?? entryDiagnostics?.gating?.staleQuoteRejectionCount ?? 0,
                  marketRejectionCount: truth?.marketRejectionCount ?? 0,
                  topSkipReasons: truth?.topSkipReasons ?? entryScan?.topSkipReasons ?? {},
                  topSkipReasonsRolling: truth?.topSkipReasonsRolling ?? {},
                  positions: truth?.openPositions ?? positions.length,
                  activeSellLimits: truth?.activeSellLimits ?? positions.filter((p) => Number.isFinite(toNum(p?.sell?.activeLimit))).length,
                  drawdownPct: risk?.drawdownPct,
                  dailyDrawdownPct: risk?.dailyDrawdownPct,
                  drawdownGuardEnabled: risk?.drawdownGuardEnabled,
                  correlationGuardEnabled: risk?.correlationGuardEnabled,
                })}</Text>
              </View>
              <View style={styles.diagnosticsBlock}>
                <Text style={styles.diagnosticsTitle}>Universe truth</Text>
                <Text style={styles.diagnosticsText}>{JSON.stringify({
                  requested: universe?.envRequestedUniverseMode,
                  effective: universe?.effectiveUniverseMode,
                  dynamicUniverseActive: universe?.dynamicUniverseActive,
                  allowDynamicInProd: universe?.allowDynamicUniverseInProduction,
                  dynamicTradableSymbolsFound: universe?.dynamicTradableSymbolsFound,
                  acceptedSymbolsCount: universe?.acceptedSymbolsCount,
                  configuredPrimaryCount: universe?.configuredPrimaryCount,
                  configuredSecondaryCount: universe?.configuredSecondaryCount,
                  sample: universe?.acceptedSymbolsSample,
                  fallbackOccurred: universe?.fallbackOccurred,
                  fallbackReason: universe?.fallbackReason,
                  lastUniverseRefreshAt: universe?.lastUniverseRefreshAt,
                })}</Text>
                <Text style={styles.diagnosticsTitle}>Predictor warmup</Text>
                <Text style={styles.diagnosticsText}>{JSON.stringify({
                  inProgress: warmupInProgress,
                  startedAt: warmup?.startedAt,
                  finishedAt: warmup?.finishedAt,
                  totalSymbolsPlanned: warmup?.totalSymbolsPlanned,
                  symbolsCompleted: warmup?.symbolsCompleted,
                  chunksCompleted: warmup?.chunksCompleted,
                  totalChunks: warmup?.totalChunks,
                  currentTimeframe: warmup?.currentTimeframe,
                  lastCompletedTimeframe: warmup?.lastCompletedTimeframe,
                  timeframesCompleted: warmup?.timeframesCompleted,
                  lastBatchSummary: warmup?.lastBatchSummary,
                  lastError: warmup?.lastError,
                })}</Text>
              </View>

              {error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                  {warmupInProgress ? (
                    <Text style={styles.errorHint}>
                      ⏳ Backend is warming up market data. Progress: {toNum(warmup?.symbolsCompleted) ?? 0}/{toNum(warmup?.totalSymbolsPlanned) ?? '—'} symbols.
                    </Text>
                  ) : null}
                  {authEnabled ? (
                    <Text style={styles.errorHint}>
                      🔑 token mismatch? base url wrong? (EXPO_PUBLIC_API_TOKEN / EXPO_PUBLIC_BACKEND_URL)
                    </Text>
                  ) : (
                    <Text style={styles.errorHint}>
                      ℹ️ Backend auth token is disabled on server; only backend URL must be correct.
                    </Text>
                  )}
                </View>
              ) : null}

              {loading ? <ActivityIndicator color="#fff" style={styles.loader} /> : null}
              {!error && warmupInProgress ? (
                <Text style={styles.empty}>
                  ⏳ warming up market data ({toNum(warmup?.symbolsCompleted) ?? 0}/{toNum(warmup?.totalSymbolsPlanned) ?? '—'} symbols)
                </Text>
              ) : null}
              {!loading && positions.length === 0 ? <Text style={styles.empty}>🎩 no positions</Text> : null}
            </View>
          }
          renderItem={({ item }) => <CompactPositionRow position={item} />}
        />
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  screen: { flex: 1 },
  content: { padding: theme.spacing.md, paddingBottom: 100 },
  gridRow: {
    justifyContent: 'space-between',
    gap: 10,
  },
  errorBanner: {
    backgroundColor: theme.colors.errorBg,
    borderColor: '#8A2A3C',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginTop: theme.spacing.md,
  },
  errorText: { color: theme.colors.errorText, fontWeight: '900' },
  errorHint: { color: theme.colors.errorText, opacity: 0.85, marginTop: 6, fontWeight: '700', fontSize: 12 },
  loader: { marginVertical: theme.spacing.md },
  empty: { color: theme.colors.muted, marginTop: theme.spacing.md, marginBottom: theme.spacing.lg, fontWeight: '800' },
  diagnosticsBlock: {
    marginTop: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  diagnosticsTitle: { color: theme.colors.text, fontWeight: '900', marginBottom: 4 },
  diagnosticsText: { color: theme.colors.muted, fontSize: 11, marginTop: 2 },
});

const headerStyles = StyleSheet.create({
  wrap: { paddingBottom: theme.spacing.md },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: theme.spacing.sm,
  },
  title: { color: theme.colors.text, fontSize: 26, fontWeight: '900', letterSpacing: 0.6 },
  titleRight: { color: theme.colors.text, fontSize: 26, fontWeight: '900' },
  chipsRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    flexWrap: 'wrap',
    marginBottom: theme.spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chipValue: { color: theme.colors.text, fontSize: 14, fontWeight: '800' },
  openRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  openLine: { color: theme.colors.text, fontSize: 16, fontWeight: '900' },
});

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
    borderWidth: 1.25,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: theme.spacing.sm,
  },
  symWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  symbol: { color: theme.colors.text, fontSize: 19, fontWeight: '900', letterSpacing: 0.8 },
  qty: { color: theme.colors.muted, fontSize: 14, fontWeight: '800' },
  pill: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  pillText: { color: theme.colors.text, fontSize: 12, fontWeight: '900' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  stat: {
    minWidth: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  statIcon: { color: theme.colors.muted, fontSize: 14, fontWeight: '900' },
  statValue: { color: theme.colors.text, fontSize: 14, fontWeight: '900' },
  bigRow: { marginBottom: theme.spacing.sm },
  forensicsWrap: {
    marginTop: theme.spacing.xs,
    paddingTop: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  forensicsTitle: { color: theme.colors.muted, fontWeight: '900', marginBottom: 6 },
  forensicsDebug: { color: theme.colors.faint, fontSize: 11, marginTop: 2 },
});


const compactStyles = StyleSheet.create({
  tile: {
    flex: 1,
    borderWidth: 1.1,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    minHeight: 0,
  },
  line1: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  line2: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  sym: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  delta: {
    color: theme.colors.warning,
    fontSize: 12,
    fontWeight: '900',
  },
  pnl: {
    flex: 1,
    fontSize: 12,
    fontWeight: '900',
  },
  timeInline: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '800',
  },
});
