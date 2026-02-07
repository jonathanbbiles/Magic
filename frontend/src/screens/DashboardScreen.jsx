import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { fetchJson, getBaseUrl } from '../api/client';
import Section from '../components/Section';
import MetricCard from '../components/MetricCard';
import theme from '../styles/theme';

const POLL_MS = 2000;

const initial = { loading: true, ok: false, status: 0, data: null, error: null, url: null, updatedAt: null };

function summarizeValue(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'object') {
    if (value.equity) return `Equity: ${value.equity}`;
    if (value.cash) return `Cash: ${value.cash}`;
    if (value.buying_power) return `Buying Power: ${value.buying_power}`;
    if (value.ok === true) return 'ok';
    if (value.error) return String(value.error);
    return `${Object.keys(value).length} fields`;
  }
  return String(value);
}

export default function DashboardScreen() {
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
      setter((prev) => ({ ...prev, loading: true }));
      const res = await fetchJson(path, 4500);
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

  const backendLine = baseUrl
    ? `Backend: ${baseUrl}`
    : 'Backend: (not set) — set EXPO_PUBLIC_BACKEND_URL to your https Render URL';

  const updatedAt =
    health.updatedAt || account.updatedAt || positions.updatedAt || orders.updatedAt;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Magic Money</Text>
      <Text style={styles.subtitle}>{backendLine}</Text>
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
          <Text style={styles.cardValue}>{positions.ok ? summarizeValue(positions.data) : '—'}</Text>
          <Text style={styles.cardHint}>via /positions</Text>
        </View>
        <View style={styles.cardWrap}>
          <Text style={styles.cardTitle}>Orders</Text>
          <Text style={styles.cardValue}>{orders.ok ? summarizeValue(orders.data) : '—'}</Text>
          <Text style={styles.cardHint}>via /orders</Text>
        </View>
      </View>

      <Section title="Health details">
        <MetricCard label="Endpoint" value="/health" />
        <MetricCard label="Status" value={String(health.status || 0)} />
        <MetricCard label="Body" value={health.ok ? summarizeValue(health.data) : (health.error || '—')} />
      </Section>

      <Section title="Portfolio summary">
        <Text style={styles.errorLine}>{account.ok ? '' : (account.error || 'Error: Network request failed')}</Text>
        {account.ok ? (
          <>
            <MetricCard label="Equity" value={summarizeValue(account.data?.equity)} />
            <MetricCard label="Cash" value={summarizeValue(account.data?.cash)} />
            <MetricCard label="Buying Power" value={summarizeValue(account.data?.buying_power)} />
          </>
        ) : null}
      </Section>

      <Section title="Positions">
        <Text style={styles.errorLine}>{positions.ok ? '' : (positions.error || 'Error: Network request failed')}</Text>
        {positions.ok ? <MetricCard label="Positions" value={summarizeValue(positions.data)} /> : null}
      </Section>

      <Section title="Open orders">
        <Text style={styles.errorLine}>{orders.ok ? '' : (orders.error || 'Error: Network request failed')}</Text>
        {orders.ok ? <MetricCard label="Orders" value={summarizeValue(orders.data)} /> : null}
      </Section>

      <Text style={styles.footer}>
        Display-only dashboard. No trading controls.
        {'\n'}
        Set EXPO_PUBLIC_BACKEND_URL (https) and EXPO_PUBLIC_API_TOKEN (if server uses API_TOKEN).
      </Text>
    </ScrollView>
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

  errorLine: { color: theme.danger, fontSize: 12, marginBottom: 8 },
  footer: { color: theme.muted, fontSize: 12, marginTop: 14, textAlign: 'center' },
});
