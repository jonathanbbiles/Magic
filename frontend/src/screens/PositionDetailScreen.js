import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ProgressTrack } from '../components/ProgressTrack';
import { ActionPill, Metric, Panel, StatusChip } from '../components/ui';
import { gradients, tokens } from '../theme/tokens';
import { ageLabel, getHoldSeconds, getProgressModel, pct, signedUsd, toNum, usd } from '../utils/formatters';

export function PositionDetailScreen({ position, mood, onBack, onOpenDiagnostics }) {
  if (!position) {
    return (
      <Panel title="Position Detail">
        <Text style={styles.empty}>No position selected.</Text>
        <Pressable onPress={onBack}><Text style={styles.backBtn}>← Back to deck</Text></Pressable>
      </Panel>
    );
  }

  const model = getProgressModel(position);
  const pl = toNum(position?.unrealized_pl);
  const up = (pl || 0) >= 0;

  return (
    <View>
      <LinearGradient colors={gradients.hero} style={styles.hero}>
        <Text style={styles.symbol}>{position?.symbol || 'Position'}</Text>
        <Text style={[styles.detailPL, { color: up ? tokens.colors.good : tokens.colors.bad }]}>
          {signedUsd(pl)} ({pct(position?.unrealized_plpc, { ratio: true })})
        </Text>

        <View style={styles.chipsRow}>
          <StatusChip label={mood?.label || 'bot'} tone={mood?.tone || 'info'} />
          <StatusChip label={`held ${ageLabel(getHoldSeconds(position))}`} tone="info" />
        </View>
      </LinearGradient>

      <View style={styles.topActions}>
        <ActionPill label="← Back to command deck" onPress={onBack} />
        <ActionPill label="Diagnostics" onPress={onOpenDiagnostics} />
      </View>

      <Panel title="Exit Trajectory">
        <ProgressTrack model={model} />
      </Panel>

      <Panel title="Price Ladder">
        <View style={styles.grid}>
          <Metric label="Entry" value={usd(model.entry)} />
          <Metric label="Current" value={usd(model.current)} />
          <Metric label="Breakeven" value={usd(model.breakeven)} />
          <Metric label="Target" value={usd(model.target)} />
        </View>
      </Panel>

      <Panel title="Diagnostics / Forensics">
        <Text style={styles.metaLine}>Reason label: {position?.forensics?.label || '—'}</Text>
        <Text style={styles.metaLine}>Reason detail: {position?.forensics?.reason || position?.forensics?.summary || '—'}</Text>
        <Text style={styles.metaLine}>Sell order id: {position?.bot?.sellOrderId || '—'}</Text>
        <Text style={styles.metaLine}>Required exit: {pct((toNum(position?.bot?.requiredExitBps) || 0) / 100)}</Text>
      </Panel>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: tokens.radius.xl,
    borderWidth: 1,
    borderColor: tokens.colors.border,
    padding: tokens.spacing.lg,
    marginBottom: tokens.spacing.md,
  },
  symbol: { color: tokens.colors.text, fontSize: 36, fontWeight: '900', letterSpacing: 1 },
  detailPL: { fontWeight: '900', fontSize: 24, marginTop: 6 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: tokens.spacing.sm },
  topActions: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: tokens.spacing.md },
  grid: { flexDirection: 'row', gap: tokens.spacing.sm, flexWrap: 'wrap' },
  metaLine: { color: tokens.colors.textMuted, marginBottom: 5 },
  backBtn: { color: tokens.colors.info, marginTop: tokens.spacing.sm, fontWeight: '700' },
  empty: { color: tokens.colors.textMuted },
});
