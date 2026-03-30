import { useMemo } from 'react';
import { ScrollView, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMagicDashboard } from '../../hooks/useMagicDashboard';
import PositionBossSheet from '../../components/PositionBossSheet';
import EquityGlowChart from '../../components/EquityGlowChart';
import EmptyStateCard from '../../components/EmptyStateCard';
import { colors, spacing, typography } from '../../theme';

export default function PositionDetailScreen() {
  const params = useLocalSearchParams();
  const symbol = String(params.symbol || '').toUpperCase();
  const { dashboard, chartSeries } = useMagicDashboard();

  const position = useMemo(() => dashboard.positions.find((p) => p.symbol === symbol), [dashboard.positions, symbol]);

  if (!position) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <EmptyStateCard title="Position unavailable" message={`No live position found for ${symbol || 'selected symbol'}.`} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.header}>{position.symbol}</Text>
      <PositionBossSheet position={position} />
      <EquityGlowChart history={chartSeries} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.md, gap: spacing.md },
  header: { ...typography.hero, color: colors.text },
});
