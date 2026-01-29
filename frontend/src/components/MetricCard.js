import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export default function MetricCard({ label, value, subvalue }) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
      {subvalue ? <Text style={styles.subvalue}>{subvalue}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#141420',
    borderRadius: 16,
    padding: 16,
  },
  label: {
    color: '#9fa0b5',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  value: {
    color: '#f5f5f8',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 10,
  },
  subvalue: {
    color: '#7d7f95',
    fontSize: 12,
    marginTop: 6,
  },
});
