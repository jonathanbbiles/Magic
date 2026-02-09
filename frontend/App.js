/*
Quick smoke test:
- Install deps: cd frontend && npx expo install expo-linear-gradient
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
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const API_BASE = 'https://magic-lw8t.onrender.com';
const API_TOKEN = ''; // optional

const POLL_MS = 10000;
const REQUEST_TIMEOUT = 7000;

const theme = {
  background: '#080B14',
  card: '#0E1627',
  cardElevated: '#121D33',
  border: 'rgba(255,255,255,0.10)',
  text: 'rgba(255,255,255,0.94)',
  muted: 'rgba(255,255,255,0.60)',
  soft: 'rgba(255,255,255,0.40)',
  success: '#35E39A',
  warning: '#F6C453',
  danger: '#FF6B6B',
  neutral: '#7A8AA0',
};

const endpointConfig = [
  { key: 'health', path: '/health' },
  { key: 'status', path: '/debug/status' },
  { key: 'account', path: '/account' },
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
  const trimmed = s.endsWith('/') ? s.slice(0, -1) : s;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function fetchJsonSafe(url, token) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const status = res.status;
    if (status === 204) {
      return { ok: true, status, data: null, error: null };
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        status,
        data,
        error: status === 404 ? 'Not Found' : `HTTP ${status}`,
      };
    }

    return { ok: true, status, data, error: null };
  } catch (error) {
    const message =
      error?.name === 'AbortError'
        ? 'Request timed out'
        : error?.message || 'Network request failed';
    return { ok: false, status: 0, data: null, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
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
  if (value == null || Number.isNaN(Number(value))) return null;
  const number = Number(value);
  return `${number.toFixed(2)}%`;
}

function formatMaybeNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString();
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
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

function Chip({ label, tone }) {
  const background =
    tone === 'success'
      ? 'rgba(53,227,154,0.18)'
      : tone === 'warning'
        ? 'rgba(246,196,83,0.18)'
        : tone === 'danger'
          ? 'rgba(255,107,107,0.18)'
          : 'rgba(122,138,160,0.16)';
  const color =
    tone === 'success'
      ? theme.success
      : tone === 'warning'
        ? theme.warning
        : tone === 'danger'
          ? theme.danger
          : theme.neutral;

  return (
    <View style={[styles.chip, { backgroundColor: background, borderColor: color }]}>
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

function Card({ title, children }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function MetricRow({ label, value, valueStyle }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, valueStyle]} numberOfLines={2}>
        {value ?? '—'}
      </Text>
    </View>
  );
}

export default function App() {
  const [apiBase, setApiBase] = useState(API_BASE);
  const [apiToken, setApiToken] = useState(API_TOKEN);
  const baseUrl = useMemo(() => normalizeBase(apiBase), [apiBase]);
  const [responses, setResponses] = useState(() => ({
    health: emptyResponse,
    status: emptyResponse,
    account: emptyResponse,
    positions: emptyResponse,
    orders: emptyResponse,
  }));
  const [refreshing, setRefreshing] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftBase, setDraftBase] = useState(API_BASE);
  const [draftToken, setDraftToken] = useState(API_TOKEN);
  const intervalRef = useRef(null);

  const fetchAll = useCallback(
    async (overrideBase, overrideToken) => {
      const activeBase = normalizeBase(overrideBase ?? apiBase);
      const activeToken = overrideToken ?? apiToken;
      if (!activeBase) {
        setResponses((prev) => ({
          ...prev,
          health: { ...prev.health, ok: false, status: 0, error: 'Missing API base URL' },
        }));
        return;
      }

      const tasks = endpointConfig.map(({ key, path }) => {
        const url = `${activeBase}${path}`;
        return fetchJsonSafe(url, activeToken).then((result) => ({ key, result }));
      });

      const settled = await Promise.allSettled(tasks);
      let hadSuccess = false;

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
          next[key] = result;
        });
        return next;
      });

      if (hadSuccess) setLastSuccessAt(new Date());
    },
    [apiBase, apiToken],
  );

  const resetPolling = useCallback(
    (nextBase, nextToken) => {
      clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => fetchAll(nextBase, nextToken), POLL_MS);
    },
    [fetchAll],
  );

  const handleSaveSettings = useCallback(() => {
    const normalizedBase = normalizeBase(draftBase);
    setApiBase(normalizedBase);
    setApiToken(draftToken);
    setSettingsOpen(false);
    fetchAll(normalizedBase, draftToken);
    resetPolling(normalizedBase, draftToken);
  }, [draftBase, draftToken, fetchAll, resetPolling]);

  const openSettings = useCallback(() => {
    setDraftBase(apiBase);
    setDraftToken(apiToken);
    setSettingsOpen(true);
  }, [apiBase, apiToken]);

  const cancelSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const hasMissingBase =
    !apiBase?.trim() || apiBase.includes('YOUR_BACKEND_URL_HERE');

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

  const openOrdersCount =
    responses.orders.data?.openOrdersCount ??
    responses.orders.data?.count ??
    responses.orders.data?.open ??
    statusData?.openOrdersCount ??
    statusData?.openOrders ??
    '—';

  const tradingEnabled =
    toBoolean(healthData?.autoTradeEnabled) ??
    toBoolean(healthData?.tradingEnabled) ??
    toBoolean(statusData?.autoTradeEnabled) ??
    toBoolean(statusData?.tradingEnabled) ??
    null;

  const liveMode =
    toBoolean(healthData?.liveMode) ?? toBoolean(statusData?.liveMode) ?? null;

  const healthOk = responses.health.ok || responses.status.ok;
  const anySuccess = Object.values(responses).some((item) => item.ok);

  let overallTone = 'danger';
  let overallText = 'Backend unreachable';
  if (anySuccess && healthOk) {
    if (tradingEnabled) {
      overallTone = 'success';
      overallText = 'Healthy & Trading';
    } else {
      overallTone = 'warning';
      overallText = 'Healthy, Trading Paused';
    }
  } else if (anySuccess) {
    overallTone = 'danger';
    overallText = 'Degraded connectivity';
  }

  const positionsCount = positionsData.length;

  const sortedByPl = [...positionsData]
    .map((pos) => {
      const plPercent =
        pos?.unrealizedPlPercent ?? pos?.unrealized_pl_percent ?? pos?.unrealizedPlPct;
      const plValue = pos?.unrealizedPl ?? pos?.unrealized_pl;
      return {
        ...pos,
        plScore: plPercent ?? plValue ?? 0,
        plPercent,
      };
    })
    .sort((a, b) => (b.plScore || 0) - (a.plScore || 0));

  const biggestWinner = sortedByPl[0];
  const biggestLoser = sortedByPl[sortedByPl.length - 1];

  const stuckPositions = positionsData.filter((pos) => {
    const plPercent =
      pos?.unrealizedPlPercent ?? pos?.unrealized_pl_percent ?? pos?.unrealizedPlPct;
    if (plPercent == null) return false;
    const heldSeconds = pos?.heldSeconds ?? pos?.held_seconds;
    if (heldSeconds != null) return plPercent < -1.5 && heldSeconds > 3600;
    return plPercent < -3;
  });

  const dayPl =
    accountData?.dayPl ??
    accountData?.day_pl ??
    accountData?.dayPL ??
    accountData?.pnlDay ??
    null;

  const dayPlTone =
    dayPl == null
      ? theme.neutral
      : Number(dayPl) > 0
        ? theme.success
        : Number(dayPl) < 0
          ? theme.danger
          : theme.neutral;

  const dataAgeSeconds = lastSuccessAt
    ? Math.floor((Date.now() - lastSuccessAt.getTime()) / 1000)
    : null;

  const friendlyError = !anySuccess
    ? hasMissingBase
      ? 'Set your backend URL in Settings ⚙️'
      : 'Offline right now. Check your connection or backend URL and try again.'
    : null;

  const rawDetails = {
    health: responses.health,
    status: responses.status,
    account: responses.account,
    positions: responses.positions,
    orders: responses.orders,
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={['#0C1222', '#090E1A']} style={styles.gradient}>
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl tintColor={theme.text} refreshing={refreshing} onRefresh={onRefresh} />}
        >
          <View style={styles.header}>
            <View style={styles.headerRow}>
              <View>
                <Text style={styles.title}>✨ Magic Money Dashboard</Text>
                <Text style={styles.subtitle}>
                  {baseUrl ? `Backend: ${baseUrl}` : 'Backend: set in Settings ⚙️'}
                </Text>
              </View>
              <Pressable onPress={openSettings} style={styles.settingsButton}>
                <Text style={styles.settingsButtonText}>⚙️ Settings</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.statusRow}>
            <Text style={[styles.statusLabel, { color: overallTone === 'success' ? theme.success : overallTone === 'warning' ? theme.warning : theme.danger }]}>
              Overall Status: {overallText}
            </Text>
            <Text style={styles.statusMeta}>
              Data age: {dataAgeSeconds != null ? `${dataAgeSeconds}s` : '—'}
            </Text>
          </View>

          {friendlyError ? <Text style={styles.offline}>{friendlyError}</Text> : null}

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

          <Card title="Portfolio Snapshot">
            <Text style={styles.bigValue}>{formatCurrency(accountData?.equity)}</Text>
            <Text style={styles.bigLabel}>Equity</Text>
            <View style={styles.divider} />
            <MetricRow
              label="Buying Power / Cash"
              value={formatCurrency(accountData?.buyingPower ?? accountData?.cash ?? accountData?.buying_power)}
            />
            <MetricRow
              label="Day P/L"
              value={dayPl == null ? '—' : formatCurrency(dayPl)}
              valueStyle={{ color: dayPlTone, fontWeight: '700' }}
            />
          </Card>

          <Card title="Positions Summary">
            <MetricRow label="Positions" value={formatMaybeNumber(positionsCount)} />
            <MetricRow
              label="Biggest Winner"
              value={
                biggestWinner
                  ? `${biggestWinner.symbol ?? biggestWinner.asset ?? '—'} ${formatPercent(biggestWinner.plPercent) ?? ''}`.trim()
                  : '—'
              }
            />
            <MetricRow
              label="Biggest Loser"
              value={
                biggestLoser
                  ? `${biggestLoser.symbol ?? biggestLoser.asset ?? '—'} ${formatPercent(biggestLoser.plPercent) ?? ''}`.trim()
                  : '—'
              }
            />
            <MetricRow label="Stuck Positions" value={formatMaybeNumber(stuckPositions.length)} />
          </Card>

          <Card title="Bot Activity">
            <MetricRow label="Last Run" value={formatTimestamp(statusData?.lastLoopAt ?? statusData?.lastRunAt)} />
            <MetricRow label="Last Action" value={statusData?.lastAction ?? statusData?.lastDecision ?? statusData?.lastDecision?.action ?? '—'} />
            <MetricRow label="Last Skip" value={statusData?.lastSkipReason ?? statusData?.skipReason ?? '—'} />
            <MetricRow label="Open Orders" value={formatMaybeNumber(openOrdersCount)} />
          </Card>

          <Pressable onPress={() => setDetailsOpen((prev) => !prev)} style={styles.detailsToggle}>
            <Text style={styles.detailsToggleText}>{detailsOpen ? 'Hide Details' : 'Show Details'}</Text>
            <Text style={styles.detailsToggleHint}>Raw JSON</Text>
          </Pressable>
          {detailsOpen ? (
            <View style={styles.detailsBox}>
              <Text style={styles.detailsText}>{JSON.stringify(rawDetails, null, 2)}</Text>
            </View>
          ) : null}

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
                onChangeText={setDraftBase}
                placeholder="https://your-backend-url.com"
                placeholderTextColor={theme.soft}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                textContentType="URL"
              />
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

  header: { marginBottom: 16 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { color: theme.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: theme.muted, fontSize: 12, marginTop: 6 },
  settingsButton: {
    backgroundColor: theme.cardElevated,
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
  statusLabel: { fontSize: 15, fontWeight: '700' },
  statusMeta: { color: theme.soft, fontSize: 12 },
  offline: { color: theme.warning, fontSize: 12, marginBottom: 10 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },

  card: {
    backgroundColor: theme.card,
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 16,
  },
  cardTitle: { color: theme.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.2 },
  bigValue: { color: theme.text, fontSize: 32, fontWeight: '800', marginTop: 10 },
  bigLabel: { color: theme.soft, fontSize: 12, marginTop: 4 },
  divider: { height: 1, backgroundColor: theme.border, marginVertical: 12 },

  metricRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  metricLabel: { color: theme.muted, fontSize: 12 },
  metricValue: { color: theme.text, fontSize: 13, fontWeight: '600', maxWidth: '55%', textAlign: 'right' },

  detailsToggle: {
    backgroundColor: theme.cardElevated,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: theme.border,
    marginTop: 4,
  },
  detailsToggleText: { color: theme.text, fontSize: 13, fontWeight: '700' },
  detailsToggleHint: { color: theme.soft, fontSize: 11, marginTop: 4 },

  detailsBox: {
    backgroundColor: 'rgba(10,16,28,0.9)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 12,
    marginTop: 8,
  },
  detailsText: { color: theme.soft, fontSize: 10, fontFamily: 'Courier', lineHeight: 16 },

  footer: { color: theme.soft, fontSize: 12, textAlign: 'center', marginTop: 20 },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(8,11,20,0.7)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContainer: { flex: 1, justifyContent: 'center' },
  modalCard: {
    backgroundColor: theme.card,
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
    backgroundColor: theme.cardElevated,
    fontSize: 13,
  },
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
    backgroundColor: theme.cardElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  modalButtonPrimaryText: { color: theme.text, fontSize: 12, fontWeight: '700' },
});
