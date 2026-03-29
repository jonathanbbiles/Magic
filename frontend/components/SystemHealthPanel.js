import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDuration, isoAgo } from '../lib/format';
import { theme } from '../lib/theme';

function line(label, value) {
  return `${label}: ${value ?? '—'}`;
}

export function SystemHealthPanel({ diagnostics }) {
  const staleWarn = (diagnostics?.staleSeconds ?? 9999) > 120;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>System Health</Text>
      <Text style={styles.item}>{line('Connectivity', diagnostics?.online ? 'online' : 'offline')}</Text>
      <Text style={styles.item}>{line('Backend version', diagnostics?.backendVersion)}</Text>
      <Text style={styles.item}>{line('Server time', diagnostics?.serverTime ? isoAgo(diagnostics.serverTime) : 'unknown')}</Text>
      <Text style={styles.item}>{line('Staleness', Number.isFinite(diagnostics?.staleSeconds) ? formatDuration(diagnostics.staleSeconds) : 'unknown')}</Text>
      <Text style={styles.item}>{line('Trading enabled', diagnostics?.system?.tradingEnabled ? 'yes' : 'no')}</Text>
      <Text style={styles.item}>{line('API token', diagnostics?.system?.apiTokenSet ? 'set' : 'missing')}</Text>
      <Text style={styles.item}>{line('Alpaca auth', diagnostics?.system?.alpacaAuthOk ? 'ok' : 'not ready')}</Text>
      <Text style={[styles.warn, { color: staleWarn ? theme.colors.caution : theme.colors.success }]}>
        {staleWarn ? 'Warning: dashboard data is stale.' : 'Freshness status healthy.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.xl,
  },
  title: { color: theme.colors.text, fontWeight: '700', marginBottom: 10 },
  item: { color: theme.colors.textMuted, marginBottom: 4, fontSize: 12 },
  warn: { marginTop: 8, fontWeight: '700' },
});
