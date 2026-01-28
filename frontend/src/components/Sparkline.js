import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { clamp } from '../utils/math';

export default function Sparkline({ data, height = 70 }) {
  const values = Array.isArray(data) ? data.filter((n) => Number.isFinite(n)) : [];
  if (values.length < 2) {
    return (
      <View style={[styles.container, { height }]}>
        <Text style={styles.placeholder}>No history yet</Text>
      </View>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, idx) => {
    const x = (idx / (values.length - 1)) * 100;
    const y = 100 - clamp(((value - min) / range) * 100, 0, 100);
    return `${x},${y}`;
  });

  return (
    <View style={[styles.container, { height }]}> 
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        <Polyline
          points={points.join(' ')}
          fill="none"
          stroke="#7c6cff"
          strokeWidth={2.2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#10101a',
    borderRadius: 12,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: {
    color: '#6f7086',
    fontSize: 12,
  },
});
