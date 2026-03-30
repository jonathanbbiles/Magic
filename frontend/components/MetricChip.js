import { Text, View, StyleSheet } from 'react-native';
import { colors, radius, spacing, typography } from '../theme';

export default function MetricChip({ label, value, tone = 'default' }) {
  const toneColor = tone === 'profit' ? colors.profit : tone === 'loss' ? colors.loss : colors.accentCyan;
  return (
    <View style={[styles.chip, { borderColor: `${toneColor}66` }]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, { color: toneColor }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: colors.cardSoft,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xxs,
  },
  label: { ...typography.caption, color: colors.textMuted },
  value: { ...typography.label, color: colors.accentCyan },
});
