import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import theme from '../theme';

const resolveTone = (status) => {
  const value = String(status || '').toLowerCase();
  if (['connected', 'ok', 'active', 'live', 'open'].includes(value)) {
    return { text: theme.colors.positive, bg: 'rgba(46, 230, 133, 0.14)' };
  }
  if (['error', 'offline', 'closed', 'disconnected', 'failed'].includes(value)) {
    return { text: theme.colors.negative, bg: 'rgba(255, 93, 133, 0.16)' };
  }
  return { text: theme.colors.warning, bg: 'rgba(255, 184, 77, 0.16)' };
};

function StatusPill({ label, status }) {
  const tone = resolveTone(status || label);

  return (
    <View style={[styles.pill, { backgroundColor: tone.bg }]}>
      <Text style={[styles.text, { color: tone.text }]}>{label || 'Unknown'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 999,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  text: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.caption,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});

export default React.memo(StatusPill);
