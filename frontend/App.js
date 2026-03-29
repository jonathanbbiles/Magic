import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { EventFeed } from './src/components/EventFeed';
import { PositionCard } from './src/components/PositionCard';
import { ProgressTrack } from './src/components/ProgressTrack';
import { SystemHealthPanel } from './src/components/SystemHealthPanel';
import { LivePulse, Metric, Panel, StatusChip } from './src/components/ui';
import { useMissionControlData } from './src/hooks/useMissionControlData';
import { gradients, tokens } from './src/theme/tokens';
import { ageLabel, deriveBotMood, getHoldSeconds, getProgressModel, pct, signedUsd, toNum, usd } from './src/utils/formatters';

const TABS = ['Command Deck', 'Diagnostics'];

export default function App() {
  const [tab, setTab] = useState('Command Deck');
  const [selectedPosition, setSelectedPosition] = useState(null);
  const data = useMissionControlData();

  const mood = useMemo(
    () => deriveBotMood({ positions: data.positions, diagnostics: data.diagnostics, staleMinutes: data.staleMinutes }),
    [data.positions, data.diagnostics, data.staleMinutes]
  );

  const weeklyPct = toNum(data.dashboard?.meta?.weeklyChangePct);
  const openPLPct = useMemo(() => {
    const mv = data.positions.reduce((sum, p) => sum + (toNum(p?.market_value) || 0), 0);
    if (!mv) return null;
    return (data.openPL / mv) * 100;
  }, [data.positions, data.openPL]);

  const header = (
    <View>
      <LinearGradient colors={gradients.hero} style={styles.hero}>
        <View style={styles.heroTop}>
          <Text style={styles.brand}>MISSION CONTROL</Text>
          <LivePulse online={!data.error && !data.isStale} label={data.error ? 'Degraded' : 'Streaming'} />
        </View>

        <Text style={styles.heroEquity}>{usd(data.equity)}</Text>
        <Text style={styles.heroSub}>Total Equity</Text>

        <View style={styles.heroMetrics}>
          <Metric label="Open P/L" value={`${signedUsd(data.openPL)} (${pct(openPLPct)})`} tone={data.openPL >= 0 ? 'good' : 'bad'} />
          <Metric label="Weekly" value={pct(weeklyPct)} tone={(weeklyPct || 0) >= 0 ? 'good' : 'bad'} />
        </View>

        <View style={styles.chipsRow}>
          <StatusChip label={mood.label} tone={mood.tone} />
          <StatusChip label={`${data.positions.length} open`} tone="info" />
          <StatusChip label={data.isStale ? 'stale feed' : 'fresh feed'} tone={data.isStale ? 'warn' : 'good'} />
        </View>
      </LinearGradient>

      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable key={t} style={[styles.tabBtn, tab === t && styles.tabBtnActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {data.error ? (
        <Panel title="Connection Warning">
          <Text style={styles.errText}>{data.error}</Text>
          <Text style={styles.errHint}>Check EXPO_PUBLIC_BACKEND_URL and EXPO_PUBLIC_API_TOKEN values.</Text>
        </Panel>
      ) : null}

      {data.loading ? <ActivityIndicator color={tokens.colors.info} style={{ marginVertical: 20 }} /> : null}

      {selectedPosition ? (
        <PositionDetail position={selectedPosition} onBack={() => setSelectedPosition(null)} />
      ) : tab === 'Command Deck' ? (
        <>
          <Panel title="Open Positions Observatory">
            {data.positions.length === 0 ? <Text style={styles.empty}>No open positions. Engine appears to be hunting.</Text> : null}
          </Panel>

          {data.positions.map((position) => (
            <PositionCard key={position?.symbol || Math.random()} position={position} onPress={() => setSelectedPosition(position)} />
          ))}

          <EventFeed positions={data.positions} diagnostics={data.diagnostics} />
          <SystemHealthPanel diagnostics={data.diagnostics} staleMinutes={data.staleMinutes || 0} lastSuccessAt={data.lastSuccessAt} />
        </>
      ) : (
        <DiagnosticsScreen data={data} />
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={gradients.screen} style={styles.screen}>
        <FlatList
          data={[]}
          renderItem={null}
          ListHeaderComponent={header}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refresh} tintColor="#fff" />}
        />
      </LinearGradient>
    </SafeAreaView>
  );
}

function PositionDetail({ position, onBack }) {
  const model = getProgressModel(position);
  const pl = toNum(position?.unrealized_pl);
  const up = (pl || 0) >= 0;

  return (
    <Panel title={`${position?.symbol || 'Position'} • Detail`} right={<StatusChip label="Detail" tone="info" />}>
      <Pressable onPress={onBack}><Text style={styles.backBtn}>← Back to deck</Text></Pressable>

      <Text style={[styles.detailPL, { color: up ? tokens.colors.good : tokens.colors.bad }]}>
        {signedUsd(pl)} ({pct(position?.unrealized_plpc, { ratio: true })})
      </Text>

      <View style={styles.detailMetricsWrap}>
        <Metric label="Hold" value={ageLabel(getHoldSeconds(position))} />
        <Metric label="Fee bps RT" value={String(toNum(position?.bot?.feeBpsRoundTrip) ?? '—')} />
      </View>

      <ProgressTrack model={model} />

      <Panel title="Forensics + Bot Reasoning" style={{ marginTop: tokens.spacing.sm, marginBottom: 0 }}>
        <Text style={styles.metaLine}>Label: {position?.forensics?.label || '—'}</Text>
        <Text style={styles.metaLine}>Reason: {position?.forensics?.reason || position?.forensics?.summary || '—'}</Text>
        <Text style={styles.metaLine}>Sell Order Id: {position?.bot?.sellOrderId || '—'}</Text>
        <Text style={styles.metaLine}>Required Exit: {pct((toNum(position?.bot?.requiredExitBps) || 0) / 100)}</Text>
      </Panel>
    </Panel>
  );
}

function DiagnosticsScreen({ data }) {
  const status = data.diagnostics;
  return (
    <>
      <Panel title="Backend Connectivity">
        <View style={styles.detailMetricsWrap}>
          <Metric label="Alpaca Auth" value={status?.alpaca?.alpacaAuthOk ? 'OK' : 'Missing'} tone={status?.alpaca?.alpacaAuthOk ? 'good' : 'bad'} />
          <Metric label="API Token" value={status?.env?.apiTokenSet ? 'Set' : 'Missing'} tone={status?.env?.apiTokenSet ? 'good' : 'bad'} />
        </View>
      </Panel>

      <Panel title="Polling Health">
        <View style={styles.detailMetricsWrap}>
          <Metric label="Poll interval" value={`${Math.round((data.pollMs || 0) / 1000)}s`} />
          <Metric label="Stale" value={data.isStale ? 'Yes' : 'No'} tone={data.isStale ? 'warn' : 'good'} />
        </View>
      </Panel>

      <Panel title="Safety and Limits">
        <Text style={styles.metaLine}>Entry manager: {status?.trading?.entryManagerRunning ? 'running' : 'stopped'}</Text>
        <Text style={styles.metaLine}>Exit manager: {status?.trading?.exitManagerRunning ? 'running' : 'stopped'}</Text>
        <Text style={styles.metaLine}>Active slots: {status?.diagnostics?.activeSlotsUsed ?? '—'} / {status?.diagnostics?.capMaxEffective ?? '—'}</Text>
        <Text style={styles.metaLine}>Rate window: {status?.limiter?.windowMs ?? '—'} ms</Text>
      </Panel>

      <SystemHealthPanel diagnostics={status} staleMinutes={data.staleMinutes || 0} lastSuccessAt={data.lastSuccessAt} />
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: tokens.colors.bg0 },
  screen: { flex: 1 },
  content: { padding: tokens.spacing.md, paddingBottom: 80 },
  hero: {
    borderRadius: tokens.radius.xl,
    borderWidth: 1,
    borderColor: tokens.colors.border,
    padding: tokens.spacing.lg,
    marginBottom: tokens.spacing.md,
    backgroundColor: tokens.colors.panel,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: {
    color: tokens.colors.textMuted,
    fontWeight: '800',
    letterSpacing: 1,
    fontSize: tokens.type.tiny,
  },
  heroEquity: { color: tokens.colors.text, fontSize: tokens.type.title, fontWeight: '900', marginTop: 8 },
  heroSub: { color: tokens.colors.textMuted, fontSize: 12 },
  heroMetrics: { flexDirection: 'row', gap: tokens.spacing.md, marginTop: tokens.spacing.sm },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: tokens.spacing.sm },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: tokens.colors.panelSoft,
    borderRadius: 999,
    padding: 4,
    marginBottom: tokens.spacing.md,
  },
  tabBtn: { flex: 1, paddingVertical: 10, borderRadius: 999, alignItems: 'center' },
  tabBtnActive: { backgroundColor: 'rgba(74,216,255,0.2)' },
  tabText: { color: tokens.colors.textMuted, fontWeight: '700' },
  tabTextActive: { color: tokens.colors.text, fontWeight: '900' },
  errText: { color: tokens.colors.bad, fontWeight: '900' },
  errHint: { color: tokens.colors.textMuted, marginTop: 5 },
  empty: { color: tokens.colors.textMuted },
  backBtn: { color: tokens.colors.info, marginBottom: tokens.spacing.sm, fontWeight: '700' },
  detailPL: { fontWeight: '900', fontSize: 20, marginBottom: tokens.spacing.sm },
  detailMetricsWrap: { flexDirection: 'row', gap: tokens.spacing.sm, marginBottom: tokens.spacing.sm },
  metaLine: { color: tokens.colors.textMuted, marginBottom: 4 },
});
