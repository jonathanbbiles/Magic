import { ScrollView, Text, StyleSheet, View } from 'react-native';
import SectionCard from '../components/SectionCard';
import MetricChip from '../components/MetricChip';
import EmptyStateCard from '../components/EmptyStateCard';
import { useMagicDashboard } from '../hooks/useMagicDashboard';
import { formatSecondsAgo } from '../utils/formatters';
import { colors, spacing, typography } from '../theme';

export default function SystemScreen() {
  const { diagnostics, errors, stale, lastUpdatedMs } = useMagicDashboard();
  const hasError = errors.health || errors.dashboard || errors.diagnostics;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <SectionCard title="System Status">
        <View style={styles.row}>
          <MetricChip label="Health" value={errors.health ? 'FAIL' : 'OK'} tone={errors.health ? 'loss' : 'profit'} />
          <MetricChip label="Diagnostics" value={errors.diagnostics ? 'FAIL' : 'OK'} tone={errors.diagnostics ? 'loss' : 'profit'} />
          <MetricChip label="Freshness" value={formatSecondsAgo(lastUpdatedMs)} tone={stale ? 'loss' : 'profit'} />
        </View>
        <View style={styles.row}>
          <MetricChip label="Server Time" value={String(diagnostics.serverTime || 'n/a')} />
          <MetricChip label="Uptime" value={String(diagnostics.uptime || 'n/a')} />
          <MetricChip label="Limiter" value={String(diagnostics.limiterState)} />
          <MetricChip label="Auth" value={String(diagnostics.authStatus)} />
          <MetricChip label="Broker" value={String(diagnostics.brokerStatus)} />
        </View>
      </SectionCard>

      {hasError ? <EmptyStateCard title="Connection Error" message={hasError} /> : null}

      <SectionCard title="Connection Info">
        <Text style={styles.text}>{JSON.stringify(diagnostics.connectionInfo || {}, null, 2)}</Text>
      </SectionCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  text: { ...typography.caption, color: colors.textMuted },
});
