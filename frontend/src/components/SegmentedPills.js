import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export default function SegmentedPills({ options, selectedValue, onSelect, compact = false }) {
  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      {(Array.isArray(options) ? options : []).map((option) => {
        const value = option?.value ?? option?.key;
        const active = value === selectedValue;
        return (
          <Pressable
            key={String(value)}
            onPress={() => onSelect?.(value)}
            style={[styles.pill, compact && styles.pillCompact, active && styles.activePill]}
          >
            <Text style={[styles.label, active && styles.activeLabel]}>{option?.label ?? String(value)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  rowCompact: {
    gap: 6,
  },
  pill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  pillCompact: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  activePill: {
    borderColor: 'rgba(83,216,255,0.75)',
    backgroundColor: 'rgba(83,216,255,0.16)',
    shadowColor: theme.colors.accentB,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
    shadowOpacity: 0.4,
    elevation: 4,
  },
  label: {
    color: theme.colors.muted,
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.3,
  },
  activeLabel: {
    color: theme.colors.text,
  },
});
