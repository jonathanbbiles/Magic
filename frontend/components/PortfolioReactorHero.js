import { Text, View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MetricChip from './MetricChip';
import { colors, radius, spacing, typography, shadows } from '../theme';
import { formatCurrency, formatPercent, formatSecondsAgo } from '../utils/formatters';

export default function PortfolioReactorHero({ equity, weeklyChangePct, buyingPower, lastUpdatedMs, mood }) {
  const tone = weeklyChangePct >= 0 ? 'profit' : 'loss';
  return (
    <LinearGradient colors={['#101025', '#0c0c1f', '#121232']} style={styles.wrap}>
      <Text style={styles.label}>Portfolio Reactor</Text>
      <Text style={styles.equity}>{formatCurrency(equity)}</Text>
      <View style={styles.row}>
        <MetricChip label="Weekly" value={formatPercent(weeklyChangePct)} tone={tone} />
        <MetricChip label="Buying Power" value={formatCurrency(buyingPower)} />
        <MetricChip label="Freshness" value={formatSecondsAgo(lastUpdatedMs)} tone={lastUpdatedMs ? 'profit' : 'loss'} />
      </View>
      <Text style={styles.mood}>Mission Mood: {String(mood || 'unknown').toUpperCase()}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.lg,
    borderColor: colors.stroke,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.glow,
  },
  label: { ...typography.label, color: colors.textMuted },
  equity: { ...typography.hero, color: colors.text },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  mood: { ...typography.caption, color: colors.accentCyan, letterSpacing: 1.1 },
});
