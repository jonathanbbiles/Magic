import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import theme from '../theme';

function EmptyState({ title, description }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  description: {
    color: theme.colors.textSecondary,
    textAlign: 'center',
    fontSize: theme.typography.label,
    lineHeight: 20,
  },
});

export default React.memo(EmptyState);
