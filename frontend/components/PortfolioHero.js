import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatMoney, isoAgo } from '../lib/format';
import { theme } from '../lib/theme';
import { BotStatusChip } from './BotStatusChip';

export function PortfolioHero({ accountValue, botState, lastUpdated, staleSeconds }) {
  const staleLabel = Number.isFinite(staleSeconds) ? `${staleSeconds}s stale` : 'stale unknown';
  return (
    <View style={styles.card}>
      <Text style={styles.kicker}>MISSION CONTROL</Text>
      <Text style={styles.value}>{formatMoney(accountValue)}</Text>
      <Text style={styles.sub}>Last payload {isoAgo(lastUpdated)} · {staleLabel}</Text>
      <View style={styles.row}>
        <BotStatusChip state={botState} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  kicker: { color: theme.colors.textMuted, fontSize: 12, letterSpacing: 1.6, fontWeight: '700' },
  value: { color: theme.colors.text, fontSize: 42, fontWeight: '800', marginTop: 8 },
  sub: { color: theme.colors.textMuted, marginTop: 8 },
  row: { marginTop: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
