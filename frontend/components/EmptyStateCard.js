import { Text, StyleSheet } from 'react-native';
import SectionCard from './SectionCard';
import { colors, typography } from '../theme';

export default function EmptyStateCard({ title = 'No data yet', message }) {
  return (
    <SectionCard title={title}>
      <Text style={styles.message}>{message || 'Waiting for fresh telemetry from backend endpoints.'}</Text>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  message: { ...typography.body, color: colors.textMuted },
});
