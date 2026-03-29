import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ProgressTrack } from './ProgressTrack';
import { StatusChip } from './ui';
import { tokens } from '../theme/tokens';
import { ageLabel, getHoldSeconds, getProgressModel, pct, signedUsd, toNum } from '../utils/formatters';

function positionState(position) {
  if (position?.sell?.pendingReplace) return { label: 'retuning exit', tone: 'warn' };
  if (position?.sell?.activeLimit) return { label: 'target armed', tone: 'good' };
  if (toNum(position?.unrealized_pl) < 0) return { label: 'pressure', tone: 'bad' };
  return { label: 'tracking', tone: 'info' };
}

export function PositionCard({ position, onPress }) {
  const symbol = position?.symbol || '—';
  const pl = toNum(position?.unrealized_pl);
  const plpc = toNum(position?.unrealized_plpc);
  const isUp = (pl || 0) >= 0;
  const hold = ageLabel(getHoldSeconds(position));
  const progressModel = getProgressModel(position);
  const state = positionState(position);

  return (
    <Pressable onPress={onPress} style={styles.pressable}>
      <View style={styles.card}>
        <View style={styles.headRow}>
          <View>
            <Text style={styles.symbol}>{symbol}</Text>
            <Text style={styles.hold}>Hold clock · {hold}</Text>
          </View>
          <StatusChip label={state.label} tone={state.tone} />
        </View>

        <Text style={[styles.pnl, { color: isUp ? tokens.colors.good : tokens.colors.bad }]}>
          {signedUsd(pl)} ({pct(plpc, { ratio: true })})
        </Text>

        <ProgressTrack model={progressModel} />

        <View style={styles.footerRow}>
          <Text style={styles.footerText}>Exit source: {position?.sell?.source || '—'}</Text>
          <Text style={styles.footerText}>Tap for detail →</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { marginBottom: tokens.spacing.sm },
  card: {
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    borderColor: tokens.colors.border,
    backgroundColor: tokens.colors.panel,
    padding: tokens.spacing.md,
  },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.xs },
  symbol: { color: tokens.colors.text, fontSize: 24, fontWeight: '900', letterSpacing: 0.8 },
  hold: { color: tokens.colors.textMuted, fontWeight: '700', marginTop: 2 },
  pnl: { fontWeight: '900', fontSize: 20, marginBottom: tokens.spacing.sm },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: tokens.spacing.xs },
  footerText: { color: tokens.colors.textFaint, fontSize: 12 },
});
