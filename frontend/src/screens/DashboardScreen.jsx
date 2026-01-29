import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { firstWorking, getBaseUrl } from '../api/client';
import Section from '../components/Section';
import MetricCard from '../components/MetricCard';
import LogList from '../components/LogList';
import theme from '../styles/theme';

const POLL_MS = 2000;

const METRICS_PATHS = [
  '/metrics',
  '/status',
  '/summary',
  '/dashboard',
  '/api/metrics',
  '/api/status',
  '/api/summary',
  '/api/dashboard',
  '/health',
];

const LOGS_PATHS = [
  '/logs',
  '/live-logs',
  '/api/logs',
  '/api/live-logs',
];

const initialStreamState = {
  loading: true,
  ok: false,
  sourceUrl: null,
  data: null,
  error: null,
  updatedAt: null,
};

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function normalizeMetrics(data) {
  if (!data) {
    return [{ label: 'Status', value: 'No data' }];
  }

  if (typeof data === 'string') {
    return [{ label: 'Message', value: data }];
  }

  if (Array.isArray(data)) {
    return [{ label: 'Items', value: String(data.length) }];
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return [{ label: 'Status', value: 'No metrics available' }];
    }

    return entries.map(([key, value]) => {
      const displayValue =
        value && typeof value === 'object' ? safeStringify(value) : String(value);
      return { label: key, value: displayValue };
    });
  }

  return [{ label: 'Value', value: String(data) }];
}

function normalizeLogs(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data.map((item) => String(item)).reverse();
  }

  if (typeof data === 'string') {
    return data
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();
  }

  return [safeStringify(data)];
}

export default function DashboardScreen() {
  const [metricsState, setMetricsState] = useState(initialStreamState);
  const [logsState, setLogsState] = useState(initialStreamState);
  const metricsInFlight = useRef(false);
  const logsInFlight = useRef(false);

  const baseUrl = useMemo(() => getBaseUrl(), []);

  useEffect(() => {
    let isMounted = true;

    const loadMetrics = async () => {
      if (metricsInFlight.current) {
        return;
      }
      metricsInFlight.current = true;
      try {
        setMetricsState((prev) => ({ ...prev, loading: true }));
        const result = await firstWorking(METRICS_PATHS);
        if (!isMounted) {
          return;
        }
        setMetricsState({
          loading: false,
          ok: result.ok,
          sourceUrl: result.url,
          data: result.data,
          error: result.ok ? null : result.error,
          updatedAt: new Date(),
        });
      } finally {
        metricsInFlight.current = false;
      }
    };

    const loadLogs = async () => {
      if (logsInFlight.current) {
        return;
      }
      logsInFlight.current = true;
      try {
        setLogsState((prev) => ({ ...prev, loading: true }));
        const result = await firstWorking(LOGS_PATHS);
        if (!isMounted) {
          return;
        }
        setLogsState({
          loading: false,
          ok: result.ok,
          sourceUrl: result.url,
          data: result.data,
          error: result.ok ? null : result.error,
          updatedAt: new Date(),
        });
      } finally {
        logsInFlight.current = false;
      }
    };

    loadMetrics();
    loadLogs();

    const intervalId = setInterval(() => {
      loadMetrics();
      loadLogs();
    }, POLL_MS);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  const metricsItems = normalizeMetrics(metricsState.data);
  const logLines = normalizeLogs(logsState.data);
  const hasConnection = metricsState.ok || logsState.ok;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Magic $$ Dashboard</Text>
      <View style={styles.subheader}>
        <Text style={styles.baseUrl}>Base URL: {baseUrl}</Text>
        <Text style={styles.editNote}>Edit in code</Text>
        <Text style={[styles.status, hasConnection ? styles.good : styles.bad]}>
          {hasConnection ? 'Connected' : 'Backend unreachable'}
        </Text>
      </View>

      <Section title="Metrics">
        {metricsState.loading && !metricsState.updatedAt ? (
          <Text style={styles.loading}>Loading metrics...</Text>
        ) : null}
        {metricsState.error ? (
          <Text style={styles.error}>{metricsState.error}</Text>
        ) : null}
        {metricsItems.map((item) => (
          <MetricCard key={item.label} label={item.label} value={item.value} />
        ))}
        {metricsState.updatedAt ? (
          <Text style={styles.timestamp}>
            Updated {metricsState.updatedAt.toLocaleTimeString()}
          </Text>
        ) : null}
      </Section>

      <Section title="Logs">
        {logsState.loading && !logsState.updatedAt ? (
          <Text style={styles.loading}>Loading logs...</Text>
        ) : null}
        {logsState.error ? (
          <Text style={styles.error}>{logsState.error}</Text>
        ) : null}
        <LogList lines={logLines} />
        {logsState.updatedAt ? (
          <Text style={styles.timestamp}>
            Updated {logsState.updatedAt.toLocaleTimeString()}
          </Text>
        ) : null}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  content: {
    padding: 20,
    paddingBottom: 32,
  },
  title: {
    color: theme.text,
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  subheader: {
    marginBottom: 20,
  },
  baseUrl: {
    color: theme.muted,
    fontSize: 13,
  },
  editNote: {
    color: theme.muted,
    fontSize: 12,
    marginTop: 2,
  },
  status: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  good: {
    color: theme.good,
  },
  bad: {
    color: theme.danger,
  },
  loading: {
    color: theme.muted,
    fontSize: 12,
    marginBottom: 6,
  },
  error: {
    color: theme.danger,
    fontSize: 12,
    marginBottom: 6,
  },
  timestamp: {
    color: theme.muted,
    fontSize: 11,
    marginTop: 10,
  },
});
