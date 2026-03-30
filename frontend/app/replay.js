import { ScrollView, Text, StyleSheet } from 'react-native';
import SectionCard from '../components/SectionCard';
import EquityGlowChart from '../components/EquityGlowChart';
import { useMagicDashboard } from '../hooks/useMagicDashboard';
import { colors, spacing, typography } from '../theme';

export default function ReplayScreen() {
  const { chartSeries } = useMagicDashboard();
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <SectionCard title="Replay Mission (Placeholder)">
        <Text style={styles.text}>
          Replay will visualize historical bot decisions and timeline scrubbing once a dedicated replay backend endpoint exists.
        </Text>
      </SectionCard>
      <EquityGlowChart history={chartSeries} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.md, gap: spacing.md },
  text: { ...typography.body, color: colors.textMuted },
});
