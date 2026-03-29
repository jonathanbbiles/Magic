import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../lib/theme';

const toneByState = {
  hunting: theme.colors.info,
  holding: theme.colors.success,
  caution: theme.colors.caution,
  offline: theme.colors.offline,
};

export function BotStatusChip({ state = 'offline' }) {
  const tone = toneByState[state] || theme.colors.offline;
  return (
    <View style={[styles.wrap, { borderColor: tone, backgroundColor: `${tone}1f` }]}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={styles.label}>{String(state).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { color: theme.colors.text, fontWeight: '700', letterSpacing: 0.6, fontSize: 12 },
});
