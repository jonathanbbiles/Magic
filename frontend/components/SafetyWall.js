import { View, Text, StyleSheet } from 'react-native';
import SectionCard from './SectionCard';
import MetricChip from './MetricChip';
import { spacing, typography, colors } from '../theme';

export default function SafetyWall({ diagnostics, stale, errors }) {
  return (
    <SectionCard title="Safety Wall">
      <View style={styles.row}>
        <MetricChip label="Auth" value={String(diagnostics.authStatus)} />
        <MetricChip label="Broker" value={String(diagnostics.brokerStatus)} />
        <MetricChip label="Limiter" value={String(diagnostics.limiterState)} />
        <MetricChip label="Stale Risk" value={stale ? 'HIGH' : 'LOW'} tone={stale ? 'loss' : 'profit'} />
      </View>
      {(errors.health || errors.diagnostics) ? (
        <Text style={styles.error}>System issue: {errors.health || errors.diagnostics}</Text>
      ) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  error: { ...typography.caption, color: colors.loss },
});
