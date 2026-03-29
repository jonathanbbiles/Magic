import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDuration, formatMoney, formatPercent, formatSignedMoney } from '../lib/format';
import { theme } from '../lib/theme';
import { TargetProgressBar } from './TargetProgressBar';

function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function PositionCard({ position, onPress, expanded = false }) {
  const plPositive = (position?.unrealizedPl ?? 0) >= 0;
  return (
    <Pressable onPress={onPress} style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.symbol}>{position.symbol}</Text>
        <Text style={[styles.pl, { color: plPositive ? theme.colors.success : theme.colors.danger }]}>{formatSignedMoney(position.unrealizedPl)}</Text>
      </View>
      <Text style={styles.sub}>{formatPercent(position.unrealizedPlPct)} unrealized · held {formatDuration(position.heldSeconds)}</Text>
      <View style={styles.grid}>
        <Row label="Entry" value={formatMoney(position.entry)} />
        <Row label="Current" value={formatMoney(position.current)} />
        <Row label="Breakeven" value={formatMoney(position.breakeven)} />
        <Row label="Target" value={formatMoney(position.target)} />
      </View>
      <TargetProgressBar progress={position.progress} />
      {expanded ? (
        <View style={styles.detail}>
          <Text style={styles.detailTitle}>Diagnostics</Text>
          <Text style={styles.detailText}>Fee bps: {position?.bot?.feeBpsRoundTrip ?? '—'}</Text>
          <Text style={styles.detailText}>Required exit bps: {position?.bot?.requiredExitBps ?? '—'}</Text>
          <Text style={styles.detailText}>Forensics reason: {position?.forensics?.reason || '—'}</Text>
          <Text style={styles.detailText}>Forensics decision: {position?.forensics?.decision || '—'}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.panelAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  symbol: { color: theme.colors.text, fontSize: 22, fontWeight: '800' },
  pl: { fontWeight: '700', fontSize: 16 },
  sub: { color: theme.colors.textMuted, marginTop: 4, marginBottom: 12 },
  grid: { gap: 8, marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: theme.colors.textMuted },
  rowValue: { color: theme.colors.text, fontWeight: '600' },
  detail: { marginTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10, gap: 4 },
  detailTitle: { color: theme.colors.text, fontWeight: '700' },
  detailText: { color: theme.colors.textMuted, fontSize: 12 },
});
