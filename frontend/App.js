import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  ScrollView,
  View,
  Text,
} from 'react-native';

const theme = {
  background: '#070A12',
  card: '#0B1220',
  border: 'rgba(255,255,255,0.10)',
  text: 'rgba(255,255,255,0.92)',
  muted: 'rgba(255,255,255,0.55)',
  danger: 'rgba(255,120,120,0.95)',
};

const POLL_MS = 2000;

const initial = {
  loading: true,
  ok: false,
  status: 0,
  data: null,
  error: null,
  url: null,
  updatedAt: null,
};

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function getBaseUrl() {
  const env =
    process.env.EXPO_PUBLIC_BACKEND_URL ||
    process.env.EXPO_PUBLIC_API_BASE_URL ||
    process.env.BACKEND_BASE_URL ||
    process.env.BACKEND_URL ||
    process.env.API_BASE_URL ||
    '';

  const raw = String(env || '').trim();

  if (raw) {
    const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (/^https?:\/\//i.test(normalized)) return normalized;
    return `https://${normalized}`;
  }

  // HARD DEFAULT — never empty
  return 'https://magic-lw8t.onrender.com';
}

function getApiToken() {
  const v =
    process.env.EXPO_PUBLIC_API_TOKEN ||
    process.env.API_TOKEN ||
    process.env.AUTH_TOKEN ||
    '';
  return String(v || '').trim();
}

async function fetchJson(path, timeoutMs = 6000) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      url: null,
      status: 0,
      data: null,
      error:
        'Backend URL missing. Set EXPO_PUBLIC_BACKEND_URL (or BACKEND_BASE_URL) to your Render https URL.',
    };
  }

  const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { Accept: 'application/json' };
  const token = getApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const status = res.status;
    const text = await res.text();

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
    }

    if (!res.ok) {
      const hint =
        status === 401
          ? 'Unauthorized (token missing/mismatch). Ensure EXPO_PUBLIC_API_TOKEN or API_TOKEN matches backend.'
          : '';
      return {
        ok: false,
        url,
        status,
        data,
        error: `HTTP ${status}${hint ? ` — ${hint}` : ''}`,
      };
    }

    return { ok: true, url, status, data, error: null };
  } catch (e) {
    const msg =
      e?.name === 'AbortError'
        ? 'Request timed out'
        : e?.message || 'Network request failed';
    return { ok: false, url, status: 0, data: null, error: msg };
  } finally {
    clearTimeout(timeoutId);
  }
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>
        {String(value ?? '—')}
      </Text>
    </View>
  );
}

function summarize(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'object') {
    if (value?.equity != null) return `Equity: ${value.equity}`;
    if (value?.cash != null) return `Cash: ${value.cash}`;
    if (value?.buying_power != null) return `BP: ${value.buying_power}`;
    return `${Object.keys(value).length} fields`;
  }
  return String(value);
}

export default function App() {
  const baseUrl = useMemo(() => getBaseUrl(), []);
  const [health, setHealth] = useState(initial);
  const [account, setAccount] = useState(initial);
  const [positions, setPositions] = useState(initial);
  const [orders, setOrders] = useState(initial);

  const inFlight = useRef({});

  const load = async (key, path, setter) => {
    if (inFlight.current[key]) return;
    inFlight.current[key] = true;
    try {
      setter((p) => ({ ...p, loading: true }));
      const res = await fetchJson(path);
      setter({
        loading: false,
        ok: res.ok,
        status: res.status || 0,
        data: res.data,
        error: res.ok ? null : res.error,
        url: res.url,
        updatedAt: new Date(),
      });
    } finally {
      inFlight.current[key] = false;
    }
  };

  useEffect(() => {
    let mounted = true;

    const tick = () => {
      if (!mounted) return;
      load('health', '/health', setHealth);
      load('account', '/account', setAccount);
      load('positions', '/positions', setPositions);
      load('orders', '/orders', setOrders);
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const updatedAt =
    health.updatedAt || account.updatedAt || positions.updatedAt || orders.updatedAt;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Magic Money</Text>
        <Text style={styles.subtitle}>
          {baseUrl ? `Backend: ${baseUrl}` : 'Backend: (not set) — set EXPO_PUBLIC_BACKEND_URL'}
        </Text>
        <Text style={styles.updated}>
          Updated: {updatedAt ? updatedAt.toLocaleTimeString() : '—'}
        </Text>

        <View style={styles.cardsRow}>
          <View style={styles.cardWrap}>
            <Text style={styles.cardTitle}>Health</Text>
            <Text style={styles.cardValue}>{health.ok ? 'OK' : 'ERR'}</Text>
            <Text style={styles.cardHint}>via /health</Text>
          </View>
          <View style={styles.cardWrap}>
            <Text style={styles.cardTitle}>Positions</Text>
            <Text style={styles.cardValue}>
              {positions.ok ? summarize(positions.data) : '—'}
            </Text>
            <Text style={styles.cardHint}>via /positions</Text>
          </View>
          <View style={styles.cardWrap}>
            <Text style={styles.cardTitle}>Orders</Text>
            <Text style={styles.cardValue}>{orders.ok ? summarize(orders.data) : '—'}</Text>
            <Text style={styles.cardHint}>via /orders</Text>
          </View>
        </View>

        <Section title="Health details">
          <Row label="Endpoint" value="/health" />
          <Row label="Status" value={health.status || 0} />
          <Row label="Body" value={health.ok ? summarize(health.data) : (health.error || '—')} />
        </Section>

        <Section title="Portfolio summary">
          {!account.ok ? (
            <Text style={styles.errorLine}>{account.error || 'Error: Network request failed'}</Text>
          ) : null}
          {account.ok ? (
            <>
              <Row label="Equity" value={account.data?.equity} />
              <Row label="Cash" value={account.data?.cash} />
              <Row label="Buying Power" value={account.data?.buying_power} />
            </>
          ) : null}
        </Section>

        <Section title="Positions">
          {!positions.ok ? (
            <Text style={styles.errorLine}>{positions.error || 'Error: Network request failed'}</Text>
          ) : null}
          {positions.ok ? <Row label="Positions" value={summarize(positions.data)} /> : null}
        </Section>

        <Section title="Open orders">
          {!orders.ok ? (
            <Text style={styles.errorLine}>{orders.error || 'Error: Network request failed'}</Text>
          ) : null}
          {orders.ok ? <Row label="Orders" value={summarize(orders.data)} /> : null}
        </Section>

        <Text style={styles.footer}>
          Display-only dashboard. No trading controls.
          {'\n'}
          Uses EXPO_PUBLIC_BACKEND_URL / BACKEND_BASE_URL and EXPO_PUBLIC_API_TOKEN / API_TOKEN automatically.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  content: { padding: 20, paddingBottom: 34 },

  title: { color: theme.text, fontSize: 36, fontWeight: '800', marginBottom: 6 },
  subtitle: { color: theme.muted, fontSize: 13, marginBottom: 2 },
  updated: { color: theme.muted, fontSize: 12, marginBottom: 16 },

  cardsRow: { flexDirection: 'row', gap: 12, marginBottom: 18 },
  cardWrap: {
    flex: 1,
    backgroundColor: theme.card,
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.border,
  },
  cardTitle: { color: theme.muted, fontSize: 13, marginBottom: 8 },
  cardValue: { color: theme.text, fontSize: 26, fontWeight: '800' },
  cardHint: { color: theme.muted, fontSize: 12, marginTop: 6 },

  section: { marginBottom: 14 },
  sectionTitle: { color: theme.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  sectionCard: {
    backgroundColor: theme.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
  },

  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 8 },
  rowLabel: { color: theme.muted, fontSize: 12 },
  rowValue: { color: theme.text, fontSize: 12, flex: 1, textAlign: 'right' },

  errorLine: { color: theme.danger, fontSize: 12, marginBottom: 8 },
  footer: { color: theme.muted, fontSize: 12, marginTop: 12, textAlign: 'center' },
});
