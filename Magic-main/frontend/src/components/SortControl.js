import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import theme from '../theme';

export const SORT_OPTIONS = [
  { key: 'pl_desc', label: 'P/L ↓' },
  { key: 'pl_asc', label: 'P/L ↑' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'value_desc', label: 'Value ↓' },
];

function SortControl({ selected, onChange }) {
  return (
    <View style={styles.row}>
      {SORT_OPTIONS.map((option) => {
        const active = selected === option.key;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={({ pressed }) => [styles.item, active && styles.itemActive, pressed && styles.pressed]}
          >
            <Text style={[styles.itemText, active && styles.itemTextActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  item: {
    backgroundColor: theme.colors.muted,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 8,
    paddingHorizontal: theme.spacing.sm,
  },
  itemActive: {
    borderColor: theme.colors.accent,
    backgroundColor: '#16234a',
  },
  itemText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    fontWeight: '700',
  },
  itemTextActive: {
    color: theme.colors.textPrimary,
  },
  pressed: {
    opacity: 0.85,
  },
});

export default React.memo(SortControl);
