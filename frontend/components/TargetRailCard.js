import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import SectionCard from './SectionCard';
import MetricChip from './MetricChip';
import { colors, spacing, typography } from '../theme';
import { formatBps, formatCurrency } from '../utils/formatters';

export default function TargetRailCard({ position }) {
  const router = useRouter();
  const progressPct = `${Math.round((position.progress || 0) * 100)}%`;
  return (
    <Pressable onPress={() => router.push(`/positions/${position.symbol}`)}>
      <SectionCard title={position.symbol} right={<Text style={styles.qty}>{position.qty}</Text>}>
        <View style={styles.row}>
          <MetricChip label="Entry" value={formatCurrency(position.entryPrice)} />
          <MetricChip label="Current" value={formatCurrency(position.currentPrice)} />
          <MetricChip label="Breakeven" value={formatCurrency(position.bot.breakevenPrice)} />
          <MetricChip label="Target" value={formatCurrency(position.bot.targetPrice)} tone="profit" />
        </View>
        <View style={styles.row}>
          <MetricChip label="Required Exit" value={formatBps(position.bot.requiredExitBps)} />
          <MetricChip label="Move Remaining" value={formatBps(position.sell.expectedMoveBps)} />
          <MetricChip label="Progress" value={progressPct} tone={position.progress >= 1 ? 'profit' : 'default'} />
        </View>
      </SectionCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  qty: { ...typography.caption, color: colors.textMuted },
});
