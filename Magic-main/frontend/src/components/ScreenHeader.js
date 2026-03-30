import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatTimestamp } from '../utils/format';
import theme from '../theme';
import StatusPill from './StatusPill';

function ScreenHeader({ status, isRefreshing, lastUpdated, onRefresh }) {
  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <View>
          <Text style={styles.title}>Magic</Text>
          <Text style={styles.subtitle}>Live trading dashboard</Text>
        </View>
        <Pressable onPress={onRefresh} style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}>
          <Text style={styles.refreshText}>{isRefreshing ? 'Refreshing…' : 'Refresh'}</Text>
        </Pressable>
      </View>

      <View style={styles.bottomRow}>
        <StatusPill label={status || 'Unknown'} status={status} />
        <Text style={styles.timestamp}>Updated {formatTimestamp(lastUpdated)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.sm,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: theme.typography.h2,
    color: theme.colors.textPrimary,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: theme.typography.label,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  refreshButton: {
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
  },
  pressed: {
    opacity: 0.8,
  },
  refreshText: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
    fontSize: theme.typography.label,
  },
  timestamp: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
});

export default React.memo(ScreenHeader);
