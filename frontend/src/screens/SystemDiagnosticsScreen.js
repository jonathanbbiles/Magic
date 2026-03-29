import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ActionPill, Metric, Panel, StatusChip } from '../components/ui';
import { tokens } from '../theme/tokens';
import { SystemHealthPanel } from '../components/SystemHealthPanel';
import { sinceLabel } from '../utils/formatters';

export function SystemDiagnosticsScreen({ data, mood, onBack }) {
  const status = data.diagnostics || {};

  return (
    <View>
      <Panel title="System / Diagnostics" right={<StatusChip label={mood?.label || 'state'} tone={mood?.tone || 'info'} />}>
        <View style={styles.actions}>
          <ActionPill label="← Back to deck" onPress={onBack} />
        </View>
      </Panel>

      <Panel title="Backend Connectivity">
        <View style={styles.grid}>
          <Metric label="Alpaca auth" value={status?.alpaca?.alpacaAuthOk ? 'OK' : 'Missing'} tone={status?.alpaca?.alpacaAuthOk ? 'good' : 'bad'} />
          <Metric label="API token" value={status?.env?.apiTokenSet ? 'Set' : 'Missing'} tone={status?.env?.apiTokenSet ? 'good' : 'bad'} />
        </View>
      </Panel>

      <Panel title="Polling + Freshness">
        <View style={styles.grid}>
          <Metric label="Poll interval" value={`${Math.round((data.pollMs || 0) / 1000)}s`} />
          <Metric label="Stale feed" value={data.isStale ? 'Yes' : 'No'} tone={data.isStale ? 'warn' : 'good'} />
          <Metric label="Last frontend refresh" value={sinceLabel(data.lastSuccessAt)} />
          <Metric label="Server time" value={status?.serverTime ? sinceLabel(status.serverTime) : '—'} />
        </View>
      </Panel>

      <Panel title="Safety Flags">
        <Text style={styles.metaLine}>Entry manager: {status?.trading?.entryManagerRunning ? 'running' : 'stopped'}</Text>
        <Text style={styles.metaLine}>Exit manager: {status?.trading?.exitManagerRunning ? 'running' : 'stopped'}</Text>
        <Text style={styles.metaLine}>Trading enabled: {status?.trading?.TRADING_ENABLED ? 'yes' : 'no'}</Text>
        <Text style={styles.metaLine}>Active slots: {status?.diagnostics?.activeSlotsUsed ?? '—'} / {status?.diagnostics?.capMaxEffective ?? '—'}</Text>
        <Text style={styles.metaLine}>Rate limit window: {status?.limiter?.windowMs ?? '—'} ms</Text>
      </Panel>

      <SystemHealthPanel diagnostics={status} staleMinutes={data.staleMinutes || 0} lastSuccessAt={data.lastSuccessAt} />
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row' },
  grid: { flexDirection: 'row', gap: tokens.spacing.sm, flexWrap: 'wrap' },
  metaLine: { color: tokens.colors.textMuted, marginBottom: 5 },
});
