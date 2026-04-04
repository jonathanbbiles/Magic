import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';

const theme = {
  colors: {
    bg: '#070A12',
    bgAlt: '#0A1020',
    text: 'rgba(255,255,255,0.92)',
    muted: 'rgba(255,255,255,0.65)',
    faint: 'rgba(255,255,255,0.45)',
    card: '#0B1220',
    cardAlt: '#0F1730',
    positive: '#72FFB6',
    negative: '#FF5C8A',
    warning: '#FFD36E',
    accent: '#88A7FF',
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

function StatusChip({ label, ok }) {
  return (
    <View style={[styles.statusChip, ok ? styles.statusChipOk : styles.statusChipWarn]}>
      <Text style={styles.statusChipText}>{label}</Text>
    </View>
  );
}

function KpiPill({ label, value, valueStyle }) {
  return (
    <View style={styles.kpiPill}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, valueStyle]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function CompactPositionRow({ position, tileWidth }) {
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

  return (
    <View style={[compactStyles.tile, { width: tileWidth, borderColor: pnlPositive ? theme.colors.glowPos : theme.colors.glowNeg }]}>
      <View style={compactStyles.line1}>
        <Text style={compactStyles.sym} numberOfLines={1}>{symbol}</Text>
        <Text style={compactStyles.delta} numberOfLines={1}>Δ🎯 {distText}</Text>
      </View>
      <View style={compactStyles.line2}>
        <Text style={[compactStyles.pnl, { color: pnlPositive ? theme.colors.positive : theme.colors.negative }]} numberOfLines={1}>
          📌 {pnlDollar} ({pnlPercent})
        </Text>
        <Text style={compactStyles.timeInline} numberOfLines={1}>⏱️ {timeShort}</Text>
      </View>
    </View>
  );
}

function DiagnosticsCard({ title, preview, raw, expanded, onToggle, onCopy, copied }) {
  return (
    <View style={styles.diagCard}>
      <View style={styles.diagHead}>
        <Text style={styles.diagTitle}>{title}</Text>
        <View style={styles.diagActions}>
          <Pressable onPress={onCopy} style={styles.actionBtn}>
            <Text style={styles.actionText}>{copied ? 'Copied' : 'Copy'}</Text>
          </Pressable>
          <Pressable onPress={onToggle} style={styles.actionBtn}>
            <Text style={styles.actionText}>{expanded ? 'Hide' : 'Expand'}</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.diagPreview} numberOfLines={expanded ? 0 : 2}>{preview}</Text>
      {expanded ? <Text style={styles.diagRaw}>{raw}</Text> : null}
    </View>
  );
}

export default function App() {
  const { width } = useWindowDimensions();
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [expandedCards, setExpandedCards] = useState({});
  const [copiedCardId, setCopiedCardId] = useState('');

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
      return aDist - bDist;
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
  const engineState = meta?.engineState ?? runtime?.engineState ?? truth?.engineState ?? '—';
  const lastEntryScanAt = meta?.lastEntryScanAt ?? truth?.lastEntryScanAt ?? '—';
  const lastEntryScanSummary = meta?.lastEntryScanSummary ?? truth?.lastEntryScanSummary ?? entryScan ?? null;
  const currentEntryScanProgress = truth?.currentEntryScanProgress ?? meta?.currentEntryScanProgress ?? null;
  const lastSuccessfulAction = meta?.lastSuccessfulAction ?? truth?.lastSuccessfulAction ?? null;
  const lastExecutionFailure = meta?.lastExecutionFailure ?? truth?.lastExecutionFailure ?? null;

  const compactScanSummary = {
    progress: currentEntryScanProgress
      ? `${toNum(currentEntryScanProgress.symbolsProcessed) ?? 0}/${toNum(currentEntryScanProgress.universeSize) ?? 0} (${currentEntryScanProgress.state || '—'})`
      : '—',
    staleQuoteCooldownCount:
      toNum(currentEntryScanProgress?.staleQuoteCooldownCount)
      ?? toNum(entryScan?.staleQuoteCooldownCount)
      ?? 0,
    stalePrimaryQuoteCount:
      toNum(currentEntryScanProgress?.stalePrimaryQuoteCount)
      ?? toNum(entryScan?.stalePrimaryQuoteCount)
      ?? 0,
    dataUnavailableCount:
      toNum(currentEntryScanProgress?.dataUnavailableCount)
      ?? toNum(entryScan?.dataUnavailableCount)
      ?? 0,
    marketRejectionCount:
      toNum(currentEntryScanProgress?.marketRejectionCount)
      ?? toNum(entryScan?.marketRejectionCount)
      ?? toNum(truth?.marketRejectionCount)
      ?? 0,
    topSkipReasons:
      currentEntryScanProgress?.topSkipReasons
      ?? entryScan?.topSkipReasons
      ?? truth?.topSkipReasons
      ?? {},
  };

  const stalled = String(engineState).toLowerCase() === 'degraded' && Boolean(meta?.lastEntryScanAt || truth?.lastEntryScanAt);

  const runtimeTruthRaw = {
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
  };

  const entryDiagnosticsRaw = {
    engineState,
    stalled,
    lastEntryScanAt,
    lastEntryScanSummary: lastEntryScanSummary ? {
      scanned: lastEntryScanSummary.scanned,
      placed: lastEntryScanSummary.placed,
      skipped: lastEntryScanSummary.skipped,
      signalReadyCount: lastEntryScanSummary.signalReadyCount,
      signalBlockedByWarmupCount: lastEntryScanSummary.signalBlockedByWarmupCount,
      staleEntryQuoteSkips: lastEntryScanSummary.staleEntryQuoteSkips,
      topSkipReasons: lastEntryScanSummary.topSkipReasons,
      marketDataBudget: lastEntryScanSummary.marketDataBudget,
      at: lastEntryScanAt,
    } : null,
    currentEntryScanProgress,
    compactScanSummary,
    signals: {
      ready: toNum(entryScan?.signalReadyCount) ?? 0,
      blockedByWarmup: toNum(entryScan?.signalBlockedByWarmupCount) ?? 0,
      staleQuoteSkips: toNum(entryScan?.staleEntryQuoteSkips) ?? 0,
    },
    predictorCandidates: predictorCandidates?.topCandidates ?? null,
    topCandidateDetail: topCandidate ? {
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
    } : null,
    perSymbolSkips: Object.keys(skipReasonsBySymbol).length ? skipReasonsBySymbol : null,
    firstSkipDetail: firstSkip ? {
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
    } : null,
    lastSuccessfulAction,
    lastExecutionFailure,
  };

  const scorecardRaw = scorecard;
  const sizingConcurrencyRaw = {
    mode: sizing?.activeMode,
    kellyEnabled: sizing?.kellyEnabled,
    kellyShadowMode: sizing?.kellyShadowMode,
    activeSlotsUsed: concurrency?.activeSlotsUsed,
    cap: concurrency?.capMaxEffective,
  };
  const quoteGuardsRaw = {
    entryQuoteMaxAgeMs: quoteFreshness?.entryQuoteMaxAgeMs,
    entryRegimeStaleQuoteMaxAgeMs: quoteFreshness?.entryRegimeStaleQuoteMaxAgeMs,
    sparseRequireQuoteFreshMs: quoteFreshness?.sparseRequireQuoteFreshMs,
    sparseStaleQuoteToleranceMs: quoteFreshness?.sparseStaleQuoteToleranceMs,
    staleEntryQuoteSkips: quoteFreshness?.staleEntryQuoteSkips,
    staleQuoteRejectionCount: truth?.staleQuoteRejectionCount ?? entryDiagnostics?.gating?.staleQuoteRejectionCount ?? 0,
    marketRejectionCount: truth?.marketRejectionCount ?? 0,
    staleDataRejectionCount: truth?.staleDataRejectionCount ?? truth?.dataRejectionCount ?? 0,
    staleCooldownSuppressionCount: truth?.staleCooldownSuppressionCount ?? 0,
    topSkipReasons: truth?.topSkipReasons ?? entryScan?.topSkipReasons ?? {},
    topSkipReasonsRolling: truth?.topSkipReasonsRolling ?? {},
    positions: truth?.openPositions ?? positions.length,
    activeSellLimits: truth?.activeSellLimits ?? positions.filter((p) => Number.isFinite(toNum(p?.sell?.activeLimit))).length,
    drawdownPct: risk?.drawdownPct,
    dailyDrawdownPct: risk?.dailyDrawdownPct,
    drawdownGuardEnabled: risk?.drawdownGuardEnabled,
    correlationGuardEnabled: risk?.correlationGuardEnabled,
  };
  const universeRaw = {
    requested: universe?.envRequestedUniverseMode,
    effective: universe?.effectiveUniverseMode,
    dynamicUniverseActive: universe?.dynamicUniverseActive,
    stableExclusionEnabled: universe?.stableExclusionEnabled,
    stableSymbolsExcludedCount: universe?.stableSymbolsExcludedCount,
    allowDynamicInProd: universe?.allowDynamicUniverseInProduction,
    dynamicTradableSymbolsFound: universe?.dynamicTradableSymbolsFound,
    acceptedSymbolsCount: universe?.acceptedSymbolsCount,
    configuredPrimaryCount: universe?.configuredPrimaryCount,
    configuredSecondaryCount: universe?.configuredSecondaryCount,
    sample: universe?.acceptedSymbolsSample,
    fallbackOccurred: universe?.fallbackOccurred,
    fallbackReason: universe?.fallbackReason,
    lastUniverseRefreshAt: universe?.lastUniverseRefreshAt,
  };
  const warmupRaw = {
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
  };

  const diagCards = [
    {
      id: 'runtime-truth',
      title: 'Runtime truth',
      preview: `engine=${runtimeTruthRaw.engineState} • backend=${runtimeTruthRaw.backendReachable ? 'up' : 'down'} • alpaca=${runtimeTruthRaw.alpacaConnected ? 'ok' : 'off'} • open=${runtimeTruthRaw.openPositions}`,
      raw: runtimeTruthRaw,
    },
    {
      id: 'entry-diagnostics',
      title: 'Entry diagnostics',
      preview: `scan=${compactScanSummary.progress} • ready=${entryDiagnosticsRaw.signals.ready} • skipped=${toNum(entryScan?.skipped) ?? '—'} • stale=${compactScanSummary.stalePrimaryQuoteCount}`,
      raw: entryDiagnosticsRaw,
    },
    {
      id: 'scorecard',
      title: 'Closed-trade scorecard',
      preview: `wins=${toNum(scorecard?.wins) ?? '—'} • losses=${toNum(scorecard?.losses) ?? '—'} • pnl=${signedUsd(scorecard?.realizedPnL ?? scorecard?.realizedPnl ?? scorecard?.totalPnl)}`,
      raw: scorecardRaw,
    },
    {
      id: 'sizing-concurrency',
      title: 'Sizing / concurrency',
      preview: `mode=${sizingConcurrencyRaw.mode || '—'} • slots=${sizingConcurrencyRaw.activeSlotsUsed ?? '—'}/${sizingConcurrencyRaw.cap ?? '—'} • kelly=${sizingConcurrencyRaw.kellyEnabled ? 'on' : 'off'}`,
      raw: sizingConcurrencyRaw,
    },
    {
      id: 'quote-guards',
      title: 'Quote freshness / guards',
      preview: `staleSkips=${toNum(quoteGuardsRaw.staleEntryQuoteSkips) ?? 0} • marketReject=${toNum(quoteGuardsRaw.marketRejectionCount) ?? 0} • staleReject=${toNum(quoteGuardsRaw.staleDataRejectionCount) ?? 0}`,
      raw: quoteGuardsRaw,
    },
    {
      id: 'universe-truth',
      title: 'Universe truth',
      preview: `effective=${universeRaw.effective || '—'} • accepted=${toNum(universeRaw.acceptedSymbolsCount) ?? '—'} • fallback=${universeRaw.fallbackOccurred ? 'yes' : 'no'}`,
      raw: universeRaw,
    },
    {
      id: 'predictor-warmup',
      title: 'Predictor warmup',
      preview: `inProgress=${warmupInProgress ? 'yes' : 'no'} • symbols=${toNum(warmupRaw.symbolsCompleted) ?? 0}/${toNum(warmupRaw.totalSymbolsPlanned) ?? '—'} • chunks=${toNum(warmupRaw.chunksCompleted) ?? 0}/${toNum(warmupRaw.totalChunks) ?? '—'}`,
      raw: warmupRaw,
    },
  ];

  const isTablet = width >= 768;
  const numColumns = width >= 980 ? 4 : width >= 700 ? 3 : 2;
  const gap = 10;
  const horizontalPad = theme.spacing.md * 2;
  const tileWidth = (width - horizontalPad - gap * (numColumns - 1)) / numColumns;

  const toggleCard = useCallback((id) => {
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const copyCard = useCallback(async (id, raw) => {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    await Clipboard.setStringAsync(text);
    setCopiedCardId(id);
    setTimeout(() => setCopiedCardId((prev) => (prev === id ? '' : prev)), 1200);
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.screen}>
        <FlatList
          data={positions}
          numColumns={numColumns}
          key={`cols-${numColumns}`}
          columnWrapperStyle={styles.gridRow}
          keyExtractor={(item) => String(item?.symbol || 'unknown')}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} tintColor="#fff" />
          }
          ListHeaderComponent={
            <View style={styles.headerWrap}>
              <LinearGradient
                colors={['#18213B', '#0E1529', '#0A1020']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.hero}
              >
                <View style={styles.heroTopRow}>
                  <Text style={styles.heroTitle}>🎩 Magic Money</Text>
                  <Text style={styles.heroValue}>{usd(portfolioValue)}</Text>
                </View>
                <View style={styles.kpiRow}>
                  <KpiPill label="Weekly" value={Number.isFinite(weeklyChangePct) ? pct(weeklyChangePct) : '—'} />
                  <KpiPill
                    label="Open P/L"
                    value={`${signedUsd(openPL)} (${pct(openPLPct)})`}
                    valueStyle={{ color: openPL >= 0 ? theme.colors.positive : theme.colors.negative }}
                  />
                </View>
                <View style={styles.statusRow}>
                  <StatusChip label={`Engine ${engineState}`} ok={String(engineState).toLowerCase() !== 'degraded'} />
                  <StatusChip label={`Auth ${authEnabled ? 'on' : 'off'}`} ok={authEnabled} />
                  <StatusChip label={`Alpaca ${alpacaConnected ? 'ok' : 'off'}`} ok={alpacaConnected} />
                  <StatusChip label={`Backend ${backendReachable ? 'up' : 'down'}`} ok={backendReachable} />
                </View>
              </LinearGradient>

              <View style={[styles.controlPanel, isTablet && styles.controlPanelTablet]}>
                <KpiPill label="Positions" value={String(positions.length)} />
                <KpiPill
                  label="Last Scan"
                  value={lastEntryScanAt && lastEntryScanAt !== '—' ? `${minsSince(lastEntryScanAt)} ago` : '—'}
                />
                <KpiPill label="Scan State" value={compactScanSummary.progress} />
                <KpiPill label="Stale Quotes" value={String(compactScanSummary.stalePrimaryQuoteCount)} />
              </View>

              <Text style={styles.sectionTitle}>Positions</Text>

              {error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                  {warmupInProgress ? (
                    <Text style={styles.errorHint}>
                      ⏳ Backend is warming up market data. Progress: {toNum(warmup?.symbolsCompleted) ?? 0}/{toNum(warmup?.totalSymbolsPlanned) ?? '—'} symbols.
                    </Text>
                  ) : null}
                  {authEnabled ? (
                    <Text style={styles.errorHint}>🔑 token mismatch? base url wrong? (EXPO_PUBLIC_API_TOKEN / EXPO_PUBLIC_BACKEND_URL)</Text>
                  ) : (
                    <Text style={styles.errorHint}>ℹ️ Backend auth token is disabled on server; only backend URL must be correct.</Text>
                  )}
                </View>
              ) : null}

              {loading ? <ActivityIndicator color="#fff" style={styles.loader} /> : null}
              {!error && warmupInProgress ? (
                <Text style={styles.empty}>⏳ warming up market data ({toNum(warmup?.symbolsCompleted) ?? 0}/{toNum(warmup?.totalSymbolsPlanned) ?? '—'} symbols)</Text>
              ) : null}
              {!loading && positions.length === 0 ? <Text style={styles.empty}>🎩 no positions</Text> : null}

              <Text style={[styles.sectionTitle, { marginTop: theme.spacing.md }]}>Diagnostics</Text>
              <View style={styles.diagList}>
                {diagCards.map((card) => {
                  const expanded = Boolean(expandedCards[card.id]);
                  const rawText = JSON.stringify(card.raw, null, 2);
                  return (
                    <DiagnosticsCard
                      key={card.id}
                      title={card.title}
                      preview={card.preview}
                      raw={rawText}
                      expanded={expanded}
                      copied={copiedCardId === card.id}
                      onToggle={() => toggleCard(card.id)}
                      onCopy={() => copyCard(card.id, rawText)}
                    />
                  );
                })}
              </View>
            </View>
          }
          renderItem={({ item }) => <CompactPositionRow position={item} tileWidth={tileWidth} />}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  screen: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: theme.spacing.md, paddingBottom: 90 },
  headerWrap: { paddingBottom: theme.spacing.xs },
  hero: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.11)',
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
  },
  heroTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  heroTitle: { color: theme.colors.text, fontSize: 20, fontWeight: '900', letterSpacing: 0.4 },
  heroValue: { color: theme.colors.text, fontSize: 24, fontWeight: '900' },
  kpiRow: { flexDirection: 'row', marginTop: theme.spacing.sm, gap: 8 },
  statusRow: { marginTop: theme.spacing.sm, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusChipOk: { borderColor: 'rgba(114,255,182,0.5)', backgroundColor: 'rgba(114,255,182,0.15)' },
  statusChipWarn: { borderColor: 'rgba(255,211,110,0.5)', backgroundColor: 'rgba(255,211,110,0.12)' },
  statusChipText: { color: theme.colors.text, fontSize: 11, fontWeight: '800' },
  controlPanel: {
    marginTop: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: theme.spacing.xs,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  controlPanelTablet: { paddingHorizontal: theme.spacing.sm },
  sectionTitle: { color: theme.colors.text, marginTop: theme.spacing.md, marginBottom: theme.spacing.sm, fontWeight: '900', fontSize: 15 },
  kpiPill: {
    flexGrow: 1,
    minWidth: 120,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  kpiLabel: { color: theme.colors.faint, fontSize: 11, fontWeight: '700', marginBottom: 2 },
  kpiValue: { color: theme.colors.text, fontSize: 13, fontWeight: '900' },
  gridRow: { justifyContent: 'space-between', gap: 10 },
  errorBanner: {
    backgroundColor: theme.colors.errorBg,
    borderColor: '#8A2A3C',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  errorText: { color: theme.colors.errorText, fontWeight: '900' },
  errorHint: { color: theme.colors.errorText, opacity: 0.85, marginTop: 6, fontWeight: '700', fontSize: 12 },
  loader: { marginVertical: theme.spacing.md },
  empty: { color: theme.colors.muted, marginBottom: theme.spacing.sm, fontWeight: '800' },
  diagList: { gap: 8, marginTop: 2 },
  diagCard: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: theme.spacing.sm,
  },
  diagHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  diagTitle: { color: theme.colors.text, fontWeight: '900', flex: 1 },
  diagActions: { flexDirection: 'row', gap: 6 },
  actionBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  actionText: { color: theme.colors.accent, fontSize: 11, fontWeight: '800' },
  diagPreview: { color: theme.colors.muted, marginTop: 6, fontSize: 12 },
  diagRaw: {
    color: theme.colors.faint,
    marginTop: 8,
    fontSize: 11,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 8,
  },
});

const compactStyles = StyleSheet.create({
  tile: {
    borderWidth: 1.1,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
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
