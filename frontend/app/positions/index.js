import { ScrollView, StyleSheet } from 'react-native';
import TargetRailCard from '../../components/TargetRailCard';
import EmptyStateCard from '../../components/EmptyStateCard';
import { useMagicDashboard } from '../../hooks/useMagicDashboard';
import { spacing } from '../../theme';

export default function PositionsScreen() {
  const { dashboard } = useMagicDashboard();
  return (
    <ScrollView contentContainerStyle={styles.container}>
      {dashboard.positions.length ? (
        dashboard.positions.map((position) => <TargetRailCard key={position.symbol} position={position} />)
      ) : (
        <EmptyStateCard title="No positions" message="Positions route is ready and waiting for backend positions[]." />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ container: { padding: spacing.md, gap: spacing.md } });
