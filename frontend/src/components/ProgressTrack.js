import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { tokens } from '../theme/tokens';
import { usd } from '../utils/formatters';

export function ProgressTrack({ model }) {
  const marks = model?.marks || {};
  const fill = Number.isFinite(model?.progress) ? `${Math.max(0, Math.min(1, model.progress)) * 100}%` : '0%';

  const pts = [
    { key: 'entry', color: tokens.colors.info, label: 'Entry', value: model?.entry },
    { key: 'breakeven', color: tokens.colors.warn, label: 'B/E', value: model?.breakeven },
    { key: 'current', color: tokens.colors.neonC, label: 'Now', value: model?.current },
    { key: 'target', color: tokens.colors.neonB, label: 'Target', value: model?.target },
  ];

  return (
    <View>
      <View style={styles.rail}>
        <View style={[styles.fill, { width: fill }]} />
        {pts.map((p) => {
          const left = Number.isFinite(marks[p.key]) ? `${marks[p.key] * 100}%` : null;
          if (!left) return null;
          return <View key={p.key} style={[styles.dot, { left, borderColor: p.color }]} />;
        })}
      </View>

      <View style={styles.labelsWrap}>
        {pts.map((p) => (
          <View key={p.key} style={styles.labelItem}>
            <Text style={[styles.k, { color: p.color }]}>{p.label}</Text>
            <Text style={styles.v}>{usd(p.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: 'relative',
    height: 8,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'visible',
    marginBottom: 10,
  },
  fill: {
    height: 8,
    borderRadius: 99,
    backgroundColor: 'rgba(75,255,168,0.75)',
  },
  dot: {
    position: 'absolute',
    top: -4,
    marginLeft: -6,
    width: 12,
    height: 12,
    borderRadius: 99,
    borderWidth: 2,
    backgroundColor: tokens.colors.bg1,
  },
  labelsWrap: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  labelItem: { minWidth: '22%' },
  k: { fontSize: 11, fontWeight: '800' },
  v: { color: tokens.colors.textMuted, fontSize: 11, marginTop: 2 },
});
