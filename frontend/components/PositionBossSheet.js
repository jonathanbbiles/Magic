import { View, Text, StyleSheet } from 'react-native';
import SectionCard from './SectionCard';
import MetricChip from './MetricChip';
import { spacing, typography, colors } from '../theme';
import { formatBps, formatCurrency } from '../utils/formatters';

export default function PositionBossSheet({ position }) {
  return (
    <SectionCard title={`${position.symbol} Control Surface`}>
      <View style={styles.row}>
        <MetricChip label="Entry" value={formatCurrency(position.entryPrice)} />
        <MetricChip label="Current" value={formatCurrency(position.currentPrice)} />
        <MetricChip label="Breakeven" value={formatCurrency(position.bot.breakevenPrice)} />
        <MetricChip label="Target" value={formatCurrency(position.bot.targetPrice)} tone="profit" />
      </View>
      <View style={styles.row}>
        <MetricChip label="Hold Age" value={`${Math.round(position.heldSeconds)}s`} />
        <MetricChip label="Req Exit" value={formatBps(position.bot.requiredExitBps)} />
        <MetricChip label="Spread Used" value={formatBps(position.bot.entrySpreadBpsUsed)} />
      </View>
      <Text style={styles.forensicsTitle}>Forensics</Text>
      <Text style={styles.forensics}>{JSON.stringify(position.forensics, null, 2)}</Text>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  forensicsTitle: { ...typography.label, color: colors.text, marginTop: spacing.sm },
  forensics: { ...typography.caption, color: colors.textMuted },
});
