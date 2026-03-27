import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../theme';
import { toFiniteNumber } from '../utils/chartUtils';

function usd(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export default function PortfolioHero({ portfolioValue, dayChangePct, buyingPower, hasError }) {
  const positive = (toFiniteNumber(dayChangePct) || 0) >= 0;

  return (
    <LinearGradient
      colors={['rgba(155,108,255,0.28)', 'rgba(83,216,255,0.12)', 'rgba(255,141,189,0.08)']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.card}
    >
      <Text style={styles.eyebrow}>Magic Portfolio</Text>
      <Text style={styles.balance}>{usd(portfolioValue)}</Text>

      <View style={styles.metaRow}>
        <View style={styles.metaPill}>
          <View style={[styles.dot, { backgroundColor: positive ? theme.colors.positive : theme.colors.negative }]} />
          <Text style={[styles.metaValue, { color: positive ? theme.colors.positive : theme.colors.negative }]}>
            {pct(dayChangePct)} today
          </Text>
        </View>

        <View style={styles.metaPill}>
          <Text style={styles.metaLabel}>Buying power</Text>
          <Text style={styles.metaValueMuted}>{usd(buyingPower)}</Text>
        </View>
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, { backgroundColor: hasError ? theme.colors.negative : theme.colors.positive }]} />
        <Text style={styles.statusText}>{hasError ? 'Connection degraded' : 'Live polling active'}</Text>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    padding: theme.spacing.lg,
    shadowColor: theme.colors.glowCard,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 16,
    elevation: 5,
  },
  eyebrow: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  balance: {
    marginTop: 8,
    color: theme.colors.text,
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  metaRow: {
    marginTop: theme.spacing.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  metaLabel: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  metaValue: {
    fontSize: 12,
    fontWeight: '900',
  },
  metaValueMuted: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  statusRow: {
    marginTop: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  statusText: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
});
