import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Sparkline from './Sparkline';
import { theme } from '../theme';
import {
  extractCurrentPrice,
  extractSymbol,
  extractUnrealizedPl,
  filterHistoryPoints,
  safePercentChange,
  toFiniteNumber,
} from '../utils/chartUtils';

const CARD_GRADIENTS = [
  ['rgba(155,108,255,0.26)', 'rgba(83,216,255,0.12)'],
  ['rgba(123,255,216,0.22)', 'rgba(83,216,255,0.08)'],
  ['rgba(255,192,138,0.22)', 'rgba(255,141,189,0.08)'],
  ['rgba(255,141,189,0.2)', 'rgba(155,108,255,0.1)'],
];

function signedUsd(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${abs}`;
}

export default function PositionVisualCard({ position, historyPoints, rangeMs, nowMs, index }) {
  const symbol = extractSymbol(position) || '—';
  const currentPrice = extractCurrentPrice(position);
  const upl = extractUnrealizedPl(position);

  const relativeMove = useMemo(() => {
    const visible = filterHistoryPoints(historyPoints, rangeMs, nowMs);
    const first = visible[0]?.price;
    const last = visible[visible.length - 1]?.price;
    return safePercentChange(first, last);
  }, [historyPoints, rangeMs, nowMs]);

  const positive = relativeMove >= 0;
  const color = positive ? theme.colors.accentMint : theme.colors.accentBlush;
  const gradients = CARD_GRADIENTS[index % CARD_GRADIENTS.length];

  return (
    <LinearGradient colors={gradients} style={styles.card}>
      <View style={styles.topRow}>
        <Text style={styles.symbol}>{symbol}</Text>
        <Text style={[styles.badge, { color }]}>{`${relativeMove >= 0 ? '+' : ''}${relativeMove.toFixed(2)}%`}</Text>
      </View>

      <Text style={styles.price}>${Number.isFinite(currentPrice) ? currentPrice.toFixed(2) : '—'}</Text>
      <Sparkline points={historyPoints} rangeMs={rangeMs} nowMs={nowMs} mode="raw" showDelta={false} />

      <Text style={styles.secondary}>P/L {signedUsd(upl)}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 160,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    padding: 12,
    marginBottom: 10,
    shadowColor: 'rgba(83,216,255,0.6)',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 3,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  symbol: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  badge: {
    fontSize: 12,
    fontWeight: '900',
  },
  price: {
    marginTop: 4,
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: '800',
  },
  secondary: {
    marginTop: 4,
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },
});
