import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Panel, StatusChip } from './ui';
import { tokens } from '../theme/tokens';
import { ageLabel, getHoldSeconds, getProgressModel, pct, signedUsd, toNum } from '../utils/formatters';
import { ProgressTrack } from './ProgressTrack';

export function PositionCard({ position, onPress }) {
  const symbol = position?.symbol || '—';
  const pl = toNum(position?.unrealized_pl);
  const plpc = toNum(position?.unrealized_plpc);
  const isUp = (pl || 0) >= 0;
  const hold = ageLabel(getHoldSeconds(position));
  const progressModel = getProgressModel(position);

  return (
    <Pressable onPress={onPress}>
      <Panel
        title={symbol}
        right={<StatusChip label={isUp ? 'green' : 'pressure'} tone={isUp ? 'good' : 'bad'} />}
        style={styles.panel}
      >
        <View style={styles.topRow}>
          <Text style={[styles.pnl, { color: isUp ? tokens.colors.good : tokens.colors.bad }]}>
            {signedUsd(pl)} ({pct(plpc, { ratio: true })})
          </Text>
          <Text style={styles.hold}>⏱ {hold}</Text>
        </View>

        <ProgressTrack model={progressModel} />

        <Text style={styles.source}>
          Exit source: {position?.sell?.source || '—'} • Req exit: {pct(position?.bot?.requiredExitBps / 100)}
        </Text>
      </Panel>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: { marginBottom: tokens.spacing.sm },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: tokens.spacing.sm,
  },
  pnl: { fontSize: 16, fontWeight: '900' },
  hold: { color: tokens.colors.textMuted, fontWeight: '700' },
  source: { color: tokens.colors.textFaint, marginTop: tokens.spacing.xs, fontSize: 12 },
});
