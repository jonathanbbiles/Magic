import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

export default function DonutOrStackedBar({ segments, height = 18 }) {
  const items = Array.isArray(segments) ? segments.filter((seg) => seg?.value > 0) : [];
  const total = items.reduce((sum, seg) => sum + seg.value, 0);

  if (!total) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No allocation data</Text>
      </View>
    );
  }

  let xOffset = 0;
  return (
    <View style={styles.container}>
      <Svg width="100%" height={height} viewBox="0 0 100 10" preserveAspectRatio="none">
        {items.map((seg, idx) => {
          const width = (seg.value / total) * 100;
          const rect = (
            <Rect
              key={`${seg.label}-${idx}`}
              x={xOffset}
              y={0}
              width={width}
              height={10}
              fill={seg.color}
            />
          );
          xOffset += width;
          return rect;
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#0f0f16',
    borderRadius: 999,
    overflow: 'hidden',
  },
  empty: {
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#141420',
    alignItems: 'center',
  },
  emptyText: {
    color: '#6f7086',
    fontSize: 12,
  },
});
