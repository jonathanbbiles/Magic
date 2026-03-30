import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

export function StatCard({ label, value, valueColor, subValue }) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, valueColor ? { color: valueColor } : null]}>{value}</Text>
      {subValue ? <Text style={styles.subValue}>{subValue}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: '47%',
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: spacing.md,
    gap: spacing.xs,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  value: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  subValue: {
    color: colors.muted,
    fontSize: 12,
  },
});
