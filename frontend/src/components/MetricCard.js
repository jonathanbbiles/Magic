import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

const ACCENTS = ['#ff5fd7', '#7c6cff', '#21d4d2', '#f7b733'];

export default function MetricCard({ label, value, subvalue, index = 0 }) {
  const accent = ACCENTS[index % ACCENTS.length];
  return (
    <View style={styles.card}>
      <View style={[styles.accent, { backgroundColor: accent }]} />
      <View style={styles.content}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{value}</Text>
        {subvalue ? <Text style={styles.subvalue}>{subvalue}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: '#141420',
    borderRadius: 16,
    overflow: 'hidden',
    minHeight: 110,
  },
  accent: {
    height: 6,
    width: '100%',
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  label: {
    color: '#c9c9d4',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
    marginBottom: 8,
  },
  value: {
    color: '#f5f5f8',
    fontSize: 24,
    fontWeight: '700',
  },
  subvalue: {
    color: '#9fa0b5',
    fontSize: 12,
    marginTop: 6,
  },
});
