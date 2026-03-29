import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../lib/theme';

export function TargetProgressBar({ progress }) {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  return (
    <View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round(p * 100)}%` }]} />
      </View>
      <Text style={styles.caption}>Target progress: {Math.round(p * 100)}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 8,
    backgroundColor: '#1d2940',
    borderRadius: 999,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: theme.colors.info },
  caption: { color: theme.colors.textMuted, marginTop: 6, fontSize: 12 },
});
