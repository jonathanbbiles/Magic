import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { tokens } from '../theme/tokens';

export function Panel({ title, right, children, style }) {
  return (
    <View style={[styles.panel, style]}>
      {(title || right) ? (
        <View style={styles.panelHeader}>
          {title ? <Text style={styles.panelTitle}>{title}</Text> : <View />}
          {right ? <View>{right}</View> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function StatusChip({ label, tone = 'info' }) {
  const colorMap = {
    good: tokens.colors.good,
    bad: tokens.colors.bad,
    warn: tokens.colors.warn,
    info: tokens.colors.info,
    offline: tokens.colors.offline,
  };
  const color = colorMap[tone] || tokens.colors.info;
  return (
    <View style={[styles.chip, { borderColor: color, backgroundColor: `${color}26` }]}>
      <Text style={[styles.chipText, { color }]}>{String(label || '').toUpperCase()}</Text>
    </View>
  );
}

export function LivePulse({ online = true, label }) {
  const anim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3, duration: 850, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  return (
    <View style={styles.pulseRow}>
      <Animated.View
        style={[
          styles.pulse,
          { backgroundColor: online ? tokens.colors.good : tokens.colors.bad, opacity: anim },
        ]}
      />
      <Text style={styles.pulseText}>{label}</Text>
    </View>
  );
}

export function Metric({ label, value, tone = 'default' }) {
  const color = tone === 'good' ? tokens.colors.good : tone === 'bad' ? tokens.colors.bad : tone === 'warn' ? tokens.colors.warn : tokens.colors.text;
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
    </View>
  );
}

export function ActionPill({ label, onPress }) {
  return (
    <Pressable onPress={onPress} style={styles.actionPill}>
      <Text style={styles.actionPillText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    borderColor: tokens.colors.border,
    padding: tokens.spacing.md,
    backgroundColor: tokens.colors.panel,
    marginBottom: tokens.spacing.md,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: tokens.spacing.sm,
  },
  panelTitle: {
    color: tokens.colors.text,
    fontSize: tokens.type.h2,
    fontWeight: '800',
  },
  chip: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: {
    fontSize: tokens.type.tiny,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  pulseRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.xs },
  pulse: { width: 10, height: 10, borderRadius: 99 },
  pulseText: { color: tokens.colors.textMuted, fontWeight: '700' },
  metric: { flex: 1, minWidth: '46%', marginBottom: tokens.spacing.xs },
  metricLabel: { color: tokens.colors.textFaint, fontSize: tokens.type.tiny, marginBottom: 2 },
  metricValue: { color: tokens.colors.text, fontSize: tokens.type.body, fontWeight: '800' },
  actionPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(102,216,255,0.35)',
    backgroundColor: 'rgba(102,216,255,0.15)',
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  actionPillText: { color: tokens.colors.text, fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },
});
