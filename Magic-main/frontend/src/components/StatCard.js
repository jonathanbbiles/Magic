import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import theme from '../theme';

function StatCard({ label, value, tone = 'neutral' }) {
  const colorMap = {
    neutral: theme.colors.textPrimary,
    positive: theme.colors.positive,
    negative: theme.colors.negative,
    warning: theme.colors.warning,
  };

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, { color: colorMap[tone] || colorMap.neutral }]}>{value ?? '—'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 76,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.md,
    padding: theme.spacing.sm,
    justifyContent: 'space-between',
  },
  label: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
  value: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.h3,
    fontWeight: '700',
  },
});

export default React.memo(StatCard);
