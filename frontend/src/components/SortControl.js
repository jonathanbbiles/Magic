import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

const options = [
  { key: 'closest', label: 'Closest to target' },
  { key: 'best', label: 'Best P/L' },
  { key: 'oldest', label: 'Oldest' },
];

export function SortControl({ selected, onSelect }) {
  return (
    <View style={styles.row}>
      {options.map((option) => {
        const active = option.key === selected;
        return (
          <Pressable
            key={option.key}
            onPress={() => onSelect(option.key)}
            style={[styles.btn, active ? styles.btnActive : null]}
          >
            <Text style={[styles.btnText, active ? styles.btnTextActive : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  btn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: '#111A2A',
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  btnActive: {
    backgroundColor: '#1A2D52',
    borderColor: colors.accent,
  },
  btnText: {
    color: colors.muted,
    fontWeight: '600',
    fontSize: 12,
  },
  btnTextActive: {
    color: colors.text,
  },
});
