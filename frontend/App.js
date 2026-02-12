/*
Quick smoke test:
- Install deps: cd frontend && npx expo install expo-linear-gradient
- Install chart deps: cd frontend && npx expo install react-native-svg
- Start: npx expo start
- Set backend URL in Settings to your Render URL, e.g. https://magic-lw8t.onrender.com
*/
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  ScrollView,
  View,
  Text,
  RefreshControl,
  Pressable,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Circle, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';

// Expo env vars must be referenced via dot notation to be inlined.
const ENV_BASE =
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  '';
const ENV_TOKEN = process.env.EXPO_PUBLIC_API_TOKEN || '';

const API_BASE = ENV_BASE || 'https://magic-lw8t.onrender.com';
const API_TOKEN = ENV_TOKEN || ''; // optional

const POLL_MS = 15000;
const REQUEST_TIMEOUT = 20000;
const FIRST_LOAD_TIMEOUT = 65000; // tolerate sleeping backends (Render cold start)

const theme = {
  background: '#0B1020',
  surface: '#10182C',
  surfaceElevated: '#18233B',
  border: 'rgba(255,255,255,0.08)',
  text: '#F7F8FF',
  muted: 'rgba(255,255,255,0.72)',
  soft: 'rgba(255,255,255,0.55)',
  mint: '#C3F3E8',
  lavender: '#D5C8FF',
  peach: '#FFD6B3',
  sky: '#B7E3FF',
  blush: '#FFC5E6',
  success: '#9CF1C8',
  warning: '#FFE2A8',
  danger: '#FFB3C2',
};

const endpointConfig = [
  { key: 'health', path: '/health' },
  { key: 'status', path: '/debug/status' },
  { key: 'account', path: '/account' },
  { key: 'portfolioHistory', path: '/account/portfolio/history?timeframe=1D&period=1Y' },
  { key: 'positions', path: '/positions' },
  { key: 'orders', path: '/orders' },
];

const emptyResponse = {
  ok: false,
  status: 0,
  data: null,
  error: null,
};

function normalizeBase(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const trimmed = s.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function validateBaseUrl(raw) {
  const normalized = normalizeBase(raw);
  if (!normalized) {
    return {
      normalized,
      isValid: false,
      error: 'Invalid backend URL (check Settings)',
      typoWarning: null,
    };
  }

  if (/\s/.test(normalized)) {
    return {
      normalized,
      isValid: false,
      error: 'Invalid backend URL (check Settings)',
      typoWarning: null,
    };
  }

  let parsed = null;
  try {
    parsed = new URL(normalized);
  } catch {
    return {
      normalized,
      isValid: false,
      error: 'Invalid backend URL (check Settings)',
      typoWarning: null,
    };
  }

  const hostname = String(parsed.hostname || '').toLowerCase();
  const typoWarning = hostname.includes('onrenderder.com')
    ? 'Typo detected: onrenderder.com. Did you mean onrender.com?'
    : null;

  if (!hostname || !hostname.includes('.') || typoWarning) {
    return {
      normalized,
      isValid: false,
      error: typoWarning || 'Invalid backend URL (check Settings)',
      typoWarning,
    };
  }

  return {
    normalized,
    isValid: true,
    error: null,
    typoWarning,
  };
}

function looksLikeLocalhost(url) {
  const u = String(url || '').toLowerCase();
  return u.includes('://localhost') || u.includes('://127.0.0.1');
}

function looksLikePrivateLan(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('://192.168.') ||
    u.includes('://10.') ||
    u.includes('://172.16.') ||
    u.includes('://172.17.') ||
    u.includes('://172.18.') ||
    u.includes('://172.19.') ||
    u.includes('://172.2') ||
    u.includes('://172.3')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonSafe(url, token, timeoutMs = REQUEST_TIMEOUT) {
  const headers = {
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const attemptFetch = async () => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (res.ok) {
        return { ok: true, status: res.status, data, error: null };
      }

      const fallback = text ? String(text).slice(0, 200) : `HTTP ${res.status}`;
      const error = typeof data === 'string' && data.trim() ? data.slice(0, 200) : fallback;
      return { ok: false, status: res.status, data, error };
    } catch (error) {
      const name = error?.name || 'Error';
      const message = error?.message || 'Network request failed';
      return {
        ok: false,
        status: 0,
        data: null,
        error: `${name}: ${message} (url: ${url})`,
      };
    } finally {
      clearTimeout(id);
    }
  };

  const retryDelays = [400, 900];
  let result = await attemptFetch();

  for (let i = 0; i < retryDelays.length; i += 1) {
    const errorText = String(result?.error || '').toLowerCase();
    const isRetryable =
      result?.status === 0 &&
      (errorText.includes('network request failed') ||
        errorText.includes('abort') ||
        errorText.includes('timed out') ||
        errorText.includes('timeout'));

    if (!isRetryable) break;
    await sleep(retryDelays[i]);
    result = await attemptFetch();
  }

  return result;
}

function isReachableResult(result) {
  if (!result) return false;
  if (result.status > 0) return true;
  const errorText = String(result.error || '').toLowerCase();
  return errorText.includes('http');
}

function isAuthError(result) {
  return result?.status === 401 || result?.status === 403;
}

function isTimeoutError(result) {
  if (!result) return false;
  const errorText = String(result.error || '').toLowerCase();
  return errorText.includes('timed out') || errorText.includes('timeout') || errorText.includes('abort');
}

function formatCurrency(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const number = Number(value);
  return `$${number.toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const number = Number(value);
  return `${number.toFixed(2)}%`;
}

function formatAge(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(1)}h`;
}

function toBoolean(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['true', 'yes', 'on', 'enabled', 'live'].includes(normalized)) return true;
    if (['false', 'no', 'off', 'disabled', 'paper'].includes(normalized)) return false;
  }
  return null;
}

function getChangePct(nowEquity, pastEquity) {
  if (nowEquity == null || pastEquity == null) return null;
  const now = Number(nowEquity);
  const past = Number(pastEquity);
  if (!Number.isFinite(now) || !Number.isFinite(past) || past === 0) return null;
  return ((now - past) / past) * 100;
}

function getPastPoint(series, targetTime) {
  if (!series.length) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].t <= targetTime) return series[i];
  }
  return null;
}

function normalizePortfolioHistory(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.history)) {
    return data.history
      .map((point) => {
        const ts = point?.t ?? point?.timestamp ?? point?.time;
        const eq = point?.equity ?? point?.value;
        const tMs = Number.isFinite(Number(ts)) ? Number(ts) * 1000 : Date.parse(String(ts || ''));
        const equity = Number(eq);
        if (!Number.isFinite(tMs) || !Number.isFinite(equity)) return null;
        return { t: tMs, equity };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
  }

  const timestamps = Array.isArray(data.timestamp) ? data.timestamp : [];
  const equities = Array.isArray(data.equity) ? data.equity : [];
  const size = Math.min(timestamps.length, equities.length);
  const points = [];
  for (let i = 0; i < size; i += 1) {
    const tsRaw = timestamps[i];
    const eqRaw = equities[i];
    const tMs = Number.isFinite(Number(tsRaw)) ? Number(tsRaw) * 1000 : Date.parse(String(tsRaw || ''));
    const equity = Number(eqRaw);
    if (!Number.isFinite(tMs) || !Number.isFinite(equity)) continue;
    points.push({ t: tMs, equity });
  }
  return points.sort((a, b) => a.t - b.t);
}

function buildSparklinePath(points, width, height) {
  if (points.length < 2) return '';
  const values = points.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  return points
    .map((point, index) => {
      const x = index * step;
      const y = height - ((point.equity - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

function Sparkline({ points }) {
  const width = 240;
  const height = 60;
  if (points.length < 2) {
    return (
      <View style={styles.sparklineEmpty}>
        <Text style={styles.sparklineEmptyText}>Collecting equity trail…</Text>
      </View>
    );
  }
  const path = buildSparklinePath(points, width, height);
  const lastPoint = points[points.length - 1];
  const values = points.map((point) => point.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const lastX = width;
  const lastY = height - ((lastPoint.equity - min) / range) * height;

  return (
    <Svg width={width} height={height} style={styles.sparklineSvg}>
      <Defs>
        <SvgGradient id="sparklineGradient" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0%" stopColor={theme.mint} stopOpacity="0.9" />
          <Stop offset="100%" stopColor={theme.lavender} stopOpacity="0.9" />
        </SvgGradient>
      </Defs>
      <Path d={path} stroke="url(#sparklineGradient)" strokeWidth={3} fill="none" />
      <Circle cx={lastX} cy={lastY} r={4} fill={theme.blush} />
    </Svg>
  );
}

function Chip({ label, tone }) {
  const palette =
    tone === 'success'
      ? { bg: 'rgba(156,241,200,0.2)', fg: theme.mint }
      : tone === 'warning'
        ? { bg: 'rgba(255,226,168,0.2)', fg: theme.peach }
        : tone === 'danger'
          ? { bg: 'rgba(255,179,194,0.2)', fg: theme.blush }
          : { bg: 'rgba(183,227,255,0.18)', fg: theme.sky };

  return (
    <View style={[styles.chip, { backgroundColor: palette.bg, borderColor: palette.fg }]}>
      <Text style={[styles.chipText, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

function GrowthPill({ label, value, tone }) {
  const palette =
    tone === 'up'
      ? { bg: 'rgba(195,243,232,0.2)', fg: theme.mint }
      : tone === 'down'
        ? { bg: 'rgba(255,197,230,0.2)', fg: theme.blush }
        : { bg: 'rgba(213,200,255,0.18)', fg: theme.lavender };
  const arrow = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '•';

  return (
    <View style={[styles.growthPill, { backgroundColor: palette.bg, borderColor: palette.fg }]}>
      <Text style={styles.growthLabel}>{label}</Text>
      <Text style={[styles.growthValue, { color: palette.fg }]}>{`${arrow} ${value}`}</Text>
    </View>
  );
}

function PositionRow({ symbol, ageHours }) {
  const progress = ageHours == null ? 0 : Math.min(ageHours / 24, 1);
  return (
    <View style={styles.positionRow}>
      <View style={styles.positionMeta}>
        <Text style={styles.positionSymbol}>{symbol}</Text>
        <Text style={styles.positionAge}>{formatAge(ageHours)}</Text>
      </View>
      <View style={styles.positionBar}>
        <View style={[styles.positionFill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
}

export default function App() {
  const [apiBase, setApiBase] = useState(API_BASE);
  const [apiToken, setApiToken] = useState(API_TOKEN);
  const [settingsError, setSettingsError] = useState(null);
  const baseValidation = useMemo(() => validateBaseUrl(apiBase), [apiBase]);
  const baseUrl = baseValidation.normalized;
  const [responses, setResponses] = useState(() => ({
    health: emptyResponse,
    status: emptyResponse,
    account: emptyResponse,
    portfolioHistory: emptyResponse,
    positions: emptyResponse,
    orders: emptyResponse,
  }));
  const [refreshing, setRefreshing] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftBase, setDraftBase] = useState(API_BASE);
  const [draftToken, setDraftToken] = useState(API_TOKEN);
  const [equitySeries, setEquitySeries] = useState([]);
  const [showAllPositions, setShowAllPositions] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const intervalRef = useRef(null);
  const lastSuccessRef = useRef(null);

  const addEquityPoint = useCallback((equityValue) => {
    const equityNumber = Number(equityValue);
    if (!Number.isFinite(equityNumber)) return;
    const now = Date.now();
    setEquitySeries((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.equity === equityNumber && now - last.t < 60000) {
        return prev;
      }
      const cutoff = now - 14 * 24 * 60 * 60 * 1000;
      let next = [...prev, { t: now, equity: equityNumber }].filter((point) => point.t >= cutoff);
      if (next.length > 2000) {
        next = next.slice(next.length - 2000);
      }
      return next;
    });
  }, []);

  const fetchAll = useCallback(
    async (overrideBase, overrideToken) => {
      const baseValidationResult = validateBaseUrl(overrideBase ?? apiBase);
      const activeBase = baseValidationResult.normalized;
      const activeToken = overrideToken ?? apiToken;
      if (!baseValidationResult.isValid) {
        setResponses((prev) => ({
          ...prev,
          health: {
            ok: false,
            status: 0,
            data: null,
            error: 'Invalid backend URL (check Settings)',
          },
        }));
        return;
      }

      const timeoutMs = lastSuccessRef.current ? REQUEST_TIMEOUT : FIRST_LOAD_TIMEOUT;

      const tasks = endpointConfig.map(({ key, path }) => {
        const url = `${activeBase}${path}`;
        return fetchJsonSafe(url, activeToken, timeoutMs).then((result) => ({ key, result }));
      });

      const settled = await Promise.allSettled(tasks);
      let hadSuccess = false;
      let accountEquity = null;

      setResponses((prev) => {
        const next = { ...prev };
        settled.forEach((item) => {
          if (item.status !== 'fulfilled') return;
          const { key, result } = item.value;
          if (result.status === 404) {
            next[key] = { ...prev[key], ok: false, status: 404, data: null, error: 'Not Found' };
            return;
          }
          if (result.ok) hadSuccess = true;
          if (key === 'account' && result.ok && result.data) {
            accountEquity = result.data.equity ?? result.data.accountEquity ?? null;
          }
          next[key] = result;
        });
        return next;
      });

      if (accountEquity != null) {
        addEquityPoint(accountEquity);
      }
      if (hadSuccess) {
        const when = new Date();
        lastSuccessRef.current = when;
        setLastSuccessAt(when);
      }
    },
    [addEquityPoint, apiBase, apiToken],
  );

  const resetPolling = useCallback(
    (nextBase, nextToken) => {
      clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => fetchAll(nextBase, nextToken), POLL_MS);
    },
    [fetchAll],
  );

  const handleSaveSettings = useCallback(() => {
    const validation = validateBaseUrl(draftBase);
    if (!validation.isValid) {
      setSettingsError(validation.error || 'Invalid backend URL (check Settings)');
      return;
    }

    setSettingsError(null);
    setApiBase(validation.normalized);
    setApiToken(draftToken);
    setSettingsOpen(false);
    fetchAll(validation.normalized, draftToken);
    resetPolling(validation.normalized, draftToken);
  }, [draftBase, draftToken, fetchAll, resetPolling]);

  const openSettings = useCallback(() => {
    setDraftBase(apiBase);
    setDraftToken(apiToken);
    setSettingsError(null);
    setSettingsOpen(true);
  }, [apiBase, apiToken]);

  const cancelSettings = useCallback(() => {
    setSettingsError(null);
    setSettingsOpen(false);
  }, []);

  const hasMissingBase = !apiBase?.trim() || apiBase.includes('YOUR_BACKEND_URL_HERE');

  useEffect(() => {
    fetchAll();
    intervalRef.current = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const healthData = responses.health.data || {};
  const statusData = responses.status.data || {};
  const accountData = responses.account.data || {};
  const positionsData = Array.isArray(responses.positions.data)
    ? responses.positions.data
    : [];

  const tradingEnabled =
    toBoolean(healthData?.autoTradeEnabled) ??
    toBoolean(statusData?.trading?.TRADING_ENABLED) ??
    toBoolean(healthData?.tradingEnabled) ??
    toBoolean(statusData?.autoTradeEnabled) ??
    toBoolean(statusData?.tradingEnabled) ??
    null;

  const liveMode =
    toBoolean(healthData?.liveMode) ??
    toBoolean(statusData?.liveMode) ??
    (() => {
      const tradeBase = String(statusData?.alpaca?.tradeBase || statusData?.tradeBase || '').toLowerCase();
      if (!tradeBase) return null;
      return !tradeBase.includes('paper');
    })();

  const healthOk = responses.health.ok || responses.status.ok;
  const responseList = Object.values(responses);
  const anySuccess = responseList.some((item) => item?.ok);
  const anyReachable = responseList.some((result) => isReachableResult(result) || result?.ok);
  const anyAuthError = responseList.some((result) => isAuthError(result));
  const anyTimeout = responseList.some((result) => isTimeoutError(result));

  let overallTone = 'danger';
  let overallText = 'Backend unreachable';
  if (anyAuthError && !anySuccess) {
    overallTone = 'warning';
    overallText = 'Auth required';
  } else if (anyReachable && healthOk) {
    if (tradingEnabled) {
      overallTone = 'success';
      overallText = 'Healthy & Trading';
    } else {
      overallTone = 'warning';
      overallText = 'Healthy, Trading Paused';
    }
  } else if (anyReachable) {
    overallTone = 'warning';
    overallText = 'Reachable, partial data';
  }

  const dataAgeSeconds = lastSuccessAt
    ? Math.floor((Date.now() - lastSuccessAt.getTime()) / 1000)
    : null;

  const positionsWithAge = positionsData
    .map((pos) => {
      const heldSeconds = pos?.heldSeconds ?? pos?.held_seconds;
      if (heldSeconds != null) {
        return { ...pos, ageHours: heldSeconds / 3600 };
      }
      return { ...pos, ageHours: null };
    })
    .sort((a, b) => {
      if (a.ageHours == null && b.ageHours == null) return 0;
      if (a.ageHours == null) return 1;
      if (b.ageHours == null) return -1;
      return b.ageHours - a.ageHours;
    });

  const visiblePositions = showAllPositions
    ? positionsWithAge
    : positionsWithAge.slice(0, 12);

  const equityValue = Number(accountData?.equity);
  const currentEquity = Number.isFinite(equityValue) ? equityValue : null;
  const portfolioHistorySeries = normalizePortfolioHistory(responses.portfolioHistory.data);
  const growthSeries = portfolioHistorySeries.length ? portfolioHistorySeries : equitySeries;
  const sparklinePoints = equitySeries.slice(-50);

  const now = Date.now();
  const dailyPoint = getPastPoint(growthSeries, now - 24 * 60 * 60 * 1000);
  const weeklyPoint = getPastPoint(growthSeries, now - 7 * 24 * 60 * 60 * 1000);
  const monthlyPoint = getPastPoint(growthSeries, now - 30 * 24 * 60 * 60 * 1000);
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const ytdPoint =
    growthSeries.find((point) => point.t >= yearStart) ?? growthSeries[0] ?? null;

  const dailyPct = getChangePct(currentEquity, dailyPoint?.equity ?? null);
  const weeklyPct = getChangePct(currentEquity, weeklyPoint?.equity ?? null);
  const monthlyPct = getChangePct(currentEquity, monthlyPoint?.equity ?? null);
  const ytdPct = getChangePct(currentEquity, ytdPoint?.equity ?? null);

  const moodBadge =
    dailyPct == null
      ? '😌 Chill Mode'
      : dailyPct > 0
        ? '✨ Green Day Energy'
        : dailyPct < 0
          ? '🫧 It’s just a dip, babe'
          : '😌 Chill Mode';

  const growthItems = [
    {
      key: 'daily',
      label: 'Daily',
      value: formatPercent(dailyPct),
      tone: dailyPct == null ? 'flat' : dailyPct > 0 ? 'up' : dailyPct < 0 ? 'down' : 'flat',
    },
    {
      key: 'weekly',
      label: 'Weekly',
      value: formatPercent(weeklyPct),
      tone: weeklyPct == null ? 'flat' : weeklyPct > 0 ? 'up' : weeklyPct < 0 ? 'down' : 'flat',
    },
    {
      key: 'monthly',
      label: 'Monthly',
      value: formatPercent(monthlyPct),
      tone: monthlyPct == null ? 'flat' : monthlyPct > 0 ? 'up' : monthlyPct < 0 ? 'down' : 'flat',
    },
    {
      key: 'ytd',
      label: 'YTD',
      value: formatPercent(ytdPct),
      tone: ytdPct == null ? 'flat' : ytdPct > 0 ? 'up' : ytdPct < 0 ? 'down' : 'flat',
    },
  ];

  const friendlyError = !anyReachable
    ? hasMissingBase
      ? 'Set your backend URL in Settings ⚙️'
      : !baseValidation.isValid
        ? 'Invalid backend URL (check Settings)'
      : anyTimeout
        ? 'Waking backend… 💤 (cold start)'
        : 'Can’t reach the mothership 🛸'
    : anyAuthError && !anySuccess
      ? 'Token required 🔐 (add API token in Settings)'
      : null;

  const emptyStateSubtitle = anyTimeout
    ? 'Render might be waking up. Try again in a few seconds.'
    : anyAuthError && !anySuccess
      ? 'Add your API token in Settings and we’ll light up.'
      : 'We’ll keep checking in the background. Want to try again?';

  const diag = endpointConfig.map(({ key, path }) => ({
    key,
    url: baseUrl ? `${baseUrl}${path}` : '',
    ok: responses[key]?.ok,
    status: responses[key]?.status,
    error: responses[key]?.error,
  }));

  const localHostWarning =
    Platform.OS === 'ios' && looksLikeLocalhost(baseUrl)
      ? '⚠️ localhost detected. On a physical iPhone, localhost points to the phone (not your laptop). Use your Render HTTPS URL or a proper HTTPS tunnel.'
      : null;

  const lanWarning =
    Platform.OS === 'ios' && looksLikePrivateLan(baseUrl)
      ? '⚠️ Private LAN URL detected. Ensure iOS Local Network permission is enabled for Expo Go and both devices are on the same Wi-Fi.'
      : null;

  const schemeWarning =
    baseUrl && !/^https:\/\//i.test(baseUrl)
      ? '⚠️ Non-HTTPS URL detected. iOS/Expo Go may block cleartext HTTP (ATS). Prefer HTTPS.'
      : null;

  const typoWarning = baseValidation.typoWarning;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={['#0B1020', '#121A2E']} style={styles.gradient}>
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl tintColor={theme.text} refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <View style={styles.header}>
            <View style={styles.headerRow}>
              <View>
                <Text style={styles.title}>✨ Magic Money Dashboard</Text>
                <Text style={styles.subtitle}>
                  Your bot is doing the boring work so you don’t have to.
                </Text>
                <Text style={styles.backendLabel}>
                  {baseUrl ? `Backend: ${baseUrl}` : 'Backend: set in Settings ⚙️'}
                </Text>
              </View>
              <Pressable onPress={openSettings} style={styles.settingsButton}>
                <Text style={styles.settingsButtonText}>⚙️ Settings</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.statusRow}>
            <Text
              style={[
                styles.statusLabel,
                {
                  color:
                    overallTone === 'success'
                      ? theme.mint
                      : overallTone === 'warning'
                        ? theme.peach
                        : theme.blush,
                },
              ]}
            >
              Overall Status: {overallText}
            </Text>
            <Text style={styles.statusMeta}>
              Data age: {dataAgeSeconds != null ? `${dataAgeSeconds}s` : '—'}
            </Text>
          </View>

          <View style={styles.chipRow}>
            <Chip
              label={`Trading: ${tradingEnabled == null ? '—' : tradingEnabled ? 'ON' : 'OFF'}`}
              tone={tradingEnabled == null ? 'neutral' : tradingEnabled ? 'success' : 'warning'}
            />
            <Chip
              label={`Live: ${liveMode == null ? '—' : liveMode ? 'YES' : 'NO'}`}
              tone={liveMode == null ? 'neutral' : liveMode ? 'success' : 'warning'}
            />
            <Chip label={`Health: ${healthOk ? 'OK' : 'DEGRADED'}`} tone={healthOk ? 'success' : 'danger'} />
          </View>

          <View style={styles.toolsRow}>
            <Pressable
              onPress={() => {
                if (!baseUrl) return;
                Linking.openURL(`${baseUrl}/health`);
              }}
              style={styles.toolButton}
            >
              <Text style={styles.toolButtonText}>Open /health in Safari</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowDiagnostics((prev) => !prev)}
              style={styles.toolButton}
            >
              <Text style={styles.toolButtonText}>{showDiagnostics ? 'Hide Diagnostics' : 'Diagnostics'}</Text>
            </Pressable>
          </View>

          {showDiagnostics ? (
            <View style={styles.diagnosticsCard}>
              <View style={styles.diagnosticsLineWrap}>
                <Text style={styles.diagnosticsLine}>platform: {Platform.OS}</Text>
                <Text style={styles.diagnosticsUrl}>using baseUrl: {baseUrl || 'not set'}</Text>
              </View>
              {localHostWarning ? <Text style={styles.diagnosticsLine}>{localHostWarning}</Text> : null}
              {lanWarning ? <Text style={styles.diagnosticsLine}>{lanWarning}</Text> : null}
              {schemeWarning ? <Text style={styles.diagnosticsLine}>{schemeWarning}</Text> : null}
              {typoWarning ? <Text style={styles.diagnosticsLine}>{typoWarning}</Text> : null}
              {diag.map((item) => (
                <View key={item.key} style={styles.diagnosticsLineWrap}>
                  <Text style={styles.diagnosticsLine}>
                    {item.key} status={item.status ?? '—'} ok={String(item.ok)}
                    {item.error ? ` err=${String(item.error).slice(0, 140)}` : ''}
                  </Text>
                  <Text style={styles.diagnosticsUrl}>{item.url || 'URL not set'}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {friendlyError ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>{friendlyError}</Text>
              <Text style={styles.emptySubtitle}>
                {emptyStateSubtitle}
              </Text>
              <View style={styles.emptyActions}>
                <Pressable onPress={onRefresh} style={styles.emptyButton}>
                  <Text style={styles.emptyButtonText}>Retry</Text>
                </Pressable>
                <Pressable onPress={openSettings} style={styles.emptyButtonGhost}>
                  <Text style={styles.emptyButtonGhostText}>Settings</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
              <View style={styles.portfolioCard}>
                <Text style={styles.portfolioLabel}>Portfolio Value</Text>
                <Text style={styles.portfolioValue}>{formatCurrency(accountData?.equity)}</Text>
                <Sparkline points={sparklinePoints} />
              </View>

              <View style={styles.growthHeader}>
                <Text style={styles.sectionTitle}>Growth</Text>
                <View style={styles.moodBadge}>
                  <Text style={styles.moodText}>{moodBadge}</Text>
                </View>
              </View>
              <View style={styles.growthGrid}>
                {growthItems.map((item) => (
                  <GrowthPill key={item.key} label={item.label} value={item.value} tone={item.tone} />
                ))}
              </View>

              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Positions</Text>
                <Text style={styles.sectionMeta}>Age in hours</Text>
              </View>
              <View style={styles.positionsCard}>
                {visiblePositions.length ? (
                  visiblePositions.map((pos, index) => (
                    <PositionRow
                      key={`${pos.symbol ?? pos.asset ?? index}`}
                      symbol={pos.symbol ?? pos.asset ?? '—'}
                      ageHours={pos.ageHours}
                    />
                  ))
                ) : (
                  <Text style={styles.positionsEmpty}>No positions yet.</Text>
                )}
                {positionsWithAge.length > 12 ? (
                  <Pressable
                    onPress={() => setShowAllPositions((prev) => !prev)}
                    style={styles.showAllButton}
                  >
                    <Text style={styles.showAllText}>
                      {showAllPositions ? 'Show less' : 'Show all'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          )}

          <Text style={styles.footer}>If it’s red, it might just be spread. Breathe.</Text>
        </ScrollView>
      </LinearGradient>
      <Modal
        visible={settingsOpen}
        transparent
        animationType="fade"
        onRequestClose={cancelSettings}
      >
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.modalContainer}
          >
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Settings</Text>
              <Text style={styles.modalLabel}>Backend URL</Text>
              <TextInput
                style={styles.modalInput}
                value={draftBase}
                onChangeText={(value) => {
                  setDraftBase(value);
                  if (settingsError) setSettingsError(null);
                }}
                placeholder="https://your-backend-url.com"
                placeholderTextColor={theme.soft}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                textContentType="URL"
              />
              {settingsError ? <Text style={styles.modalError}>{settingsError}</Text> : null}
              <Text style={styles.modalLabel}>API Token (optional)</Text>
              <TextInput
                style={styles.modalInput}
                value={draftToken}
                onChangeText={setDraftToken}
                placeholder="Bearer token"
                placeholderTextColor={theme.soft}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <View style={styles.modalActions}>
                <Pressable onPress={cancelSettings} style={styles.modalButton}>
                  <Text style={styles.modalButtonText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={handleSaveSettings} style={styles.modalButtonPrimary}>
                  <Text style={styles.modalButtonPrimaryText}>Save &amp; Refresh</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  gradient: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },

  header: { marginBottom: 12 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { color: theme.text, fontSize: 26, fontWeight: '800' },
  subtitle: { color: theme.muted, fontSize: 13, marginTop: 6, maxWidth: 260 },
  backendLabel: { color: theme.soft, fontSize: 11, marginTop: 6 },
  settingsButton: {
    backgroundColor: theme.surfaceElevated,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.border,
  },
  settingsButtonText: { color: theme.text, fontSize: 12, fontWeight: '700' },

  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  statusLabel: { fontSize: 14, fontWeight: '700' },
  statusMeta: { color: theme.soft, fontSize: 11 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },

  toolsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: -8, marginBottom: 12 },
  toolButton: {
    backgroundColor: theme.surfaceElevated,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.border,
  },
  toolButtonText: { color: theme.text, fontSize: 11, fontWeight: '700' },
  diagnosticsCard: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 12,
    marginBottom: 12,
  },
  diagnosticsLineWrap: { marginBottom: 8 },
  diagnosticsLine: { color: theme.muted, fontSize: 11, fontWeight: '600' },
  diagnosticsUrl: { color: theme.soft, fontSize: 10, marginTop: 2 },

  emptyState: {
    backgroundColor: theme.surface,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.border,
    marginTop: 10,
  },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: theme.soft, fontSize: 12, marginTop: 6 },
  emptyActions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  emptyButton: {
    backgroundColor: theme.surfaceElevated,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  emptyButtonText: { color: theme.text, fontWeight: '700', fontSize: 12 },
  emptyButtonGhost: {
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  emptyButtonGhostText: { color: theme.text, fontWeight: '600', fontSize: 12 },

  portfolioCard: {
    backgroundColor: theme.surface,
    borderRadius: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 18,
  },
  portfolioLabel: { color: theme.soft, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.2 },
  portfolioValue: { color: theme.text, fontSize: 34, fontWeight: '800', marginTop: 8 },

  sparklineSvg: { marginTop: 12 },
  sparklineEmpty: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 10,
  },
  sparklineEmptyText: { color: theme.soft, fontSize: 11 },

  growthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sectionTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  sectionMeta: { color: theme.soft, fontSize: 11 },
  moodBadge: {
    backgroundColor: 'rgba(183,227,255,0.2)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  moodText: { color: theme.sky, fontSize: 11, fontWeight: '700' },

  growthGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
  growthPill: {
    width: '47%',
    backgroundColor: 'rgba(213,200,255,0.18)',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
  },
  growthLabel: { color: theme.soft, fontSize: 11 },
  growthValue: { fontSize: 15, fontWeight: '700', marginTop: 6 },

  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  positionsCard: {
    backgroundColor: theme.surface,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 18,
  },
  positionRow: { marginBottom: 12 },
  positionMeta: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  positionSymbol: { color: theme.text, fontSize: 13, fontWeight: '700' },
  positionAge: { color: theme.soft, fontSize: 12 },
  positionBar: {
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  positionFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: theme.mint,
  },
  positionsEmpty: { color: theme.soft, fontSize: 12, textAlign: 'center', marginVertical: 10 },

  showAllButton: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: theme.surfaceElevated,
  },
  showAllText: { color: theme.text, fontSize: 11, fontWeight: '700' },

  footer: { color: theme.soft, fontSize: 12, textAlign: 'center', marginTop: 20 },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(8,11,20,0.7)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContainer: { flex: 1, justifyContent: 'center' },
  modalCard: {
    backgroundColor: theme.surface,
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.border,
  },
  modalTitle: { color: theme.text, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  modalLabel: { color: theme.muted, fontSize: 12, marginTop: 10, marginBottom: 6 },
  modalInput: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.text,
    backgroundColor: theme.surfaceElevated,
    fontSize: 13,
  },
  modalError: { color: theme.danger, fontSize: 11, marginTop: 6 },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 18,
  },
  modalButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  modalButtonText: { color: theme.text, fontSize: 12, fontWeight: '600' },
  modalButtonPrimary: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: theme.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  modalButtonPrimaryText: { color: theme.text, fontSize: 12, fontWeight: '700' },
});
