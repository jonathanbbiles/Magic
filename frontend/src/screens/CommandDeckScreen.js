import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { EventFeed } from '../components/EventFeed';
import { PositionCard } from '../components/PositionCard';
import { SystemHealthPanel } from '../components/SystemHealthPanel';
import { ActionPill, LivePulse, Metric, Panel, StatusChip } from '../components/ui';
import { gradients, tokens } from '../theme/tokens';
import { pct, signedUsd, toNum, usd } from '../utils/formatters';

export function CommandDeckScreen({ data, mood, onOpenPosition, onOpenDiagnostics }) {
  const weeklyPct = toNum(data.dashboard?.meta?.weeklyChangePct);
  const openPLPct = useMemo(() => {
    const mv = data.positions.reduce((sum, p) => sum + (toNum(p?.market_value) || 0), 0);
    if (!mv) return null;
    return (data.openPL / mv) * 100;
  }, [data.positions, data.openPL]);

  return (
    <View>
      <LinearGradient colors={gradients.hero} style={styles.hero}>
        <View style={styles.heroTop}>
          <Text style={styles.brand}>MISSION CONTROL · COMMAND DECK</Text>
          <LivePulse online={!data.error && !data.isStale} label={data.error ? 'Degraded' : 'Streaming'} />
        </View>

        <Text style={styles.heroEquity}>{usd(data.equity)}</Text>
        <Text style={styles.heroSub}>Portfolio equity</Text>

        <View style={styles.heroMetrics}>
          <Metric label="Open P/L" value={`${signedUsd(data.openPL)} (${pct(openPLPct)})`} tone={data.openPL >= 0 ? 'good' : 'bad'} />
          <Metric label="Weekly drift" value={pct(weeklyPct)} tone={(weeklyPct || 0) >= 0 ? 'good' : 'bad'} />
        </View>

        <View style={styles.chipsRow}>
          <StatusChip label={mood.label} tone={mood.tone} />
          <StatusChip label={`${data.positions.length} open`} tone="info" />
          <StatusChip label={data.isStale ? 'stale feed' : 'fresh feed'} tone={data.isStale ? 'warn' : 'good'} />
        </View>

        <View style={styles.actionRow}>
          <ActionPill label="System diagnostics" onPress={onOpenDiagnostics} />
        </View>
      </LinearGradient>

      {data.error ? (
        <Panel title="Connection Warning" right={<StatusChip label="caution" tone="warn" />}>
          <Text style={styles.errText}>{data.error}</Text>
          <Text style={styles.errHint}>Check EXPO_PUBLIC_BACKEND_URL and EXPO_PUBLIC_API_TOKEN values.</Text>
        </Panel>
      ) : null}

      {data.loading ? <ActivityIndicator color={tokens.colors.info} style={{ marginVertical: 20 }} /> : null}

      <Panel title="Open Positions Observatory" right={<StatusChip label={data.positions.length ? 'active' : 'idle'} tone={data.positions.length ? 'good' : 'info'} />}>
        {data.positions.length === 0 ? <Text style={styles.empty}>No open positions. Bot appears to be hunting for setups.</Text> : null}
      </Panel>

      {data.positions.map((position) => (
        <PositionCard key={position?.symbol || `${Math.random()}`} position={position} onPress={() => onOpenPosition(position)} />
      ))}

      <EventFeed positions={data.positions} diagnostics={data.diagnostics} />
      <SystemHealthPanel diagnostics={data.diagnostics} staleMinutes={data.staleMinutes || 0} lastSuccessAt={data.lastSuccessAt} />

      <Pressable style={styles.footerAction} onPress={onOpenDiagnostics}>
        <Text style={styles.footerActionText}>Open full diagnostics center</Text>
      </Pressable>
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
    backgroundColor: tokens.colors.panel,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: tokens.colors.textMuted, fontWeight: '800', letterSpacing: 1, fontSize: tokens.type.tiny },
  heroEquity: { color: tokens.colors.text, fontSize: tokens.type.hero, fontWeight: '900', marginTop: 8 },
  heroSub: { color: tokens.colors.textMuted, fontSize: 12 },
  heroMetrics: { flexDirection: 'row', gap: tokens.spacing.md, marginTop: tokens.spacing.sm },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: tokens.spacing.sm },
  actionRow: { flexDirection: 'row', marginTop: tokens.spacing.md },
  errText: { color: tokens.colors.bad, fontWeight: '900' },
  errHint: { color: tokens.colors.textMuted, marginTop: 5 },
  empty: { color: tokens.colors.textMuted },
  footerAction: {
    borderWidth: 1,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.md,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: tokens.spacing.sm,
  },
  footerActionText: { color: tokens.colors.info, fontWeight: '800' },
});
