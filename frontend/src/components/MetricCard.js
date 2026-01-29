import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import theme from '../styles/theme';

export default function MetricCard({ label, value }) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  label: {
    color: theme.muted,
    fontSize: 12,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: {
    color: theme.text,
    fontSize: 16,
    fontFamily: 'Courier',
  },
});
