import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';
import {
  formatCurrency,
  formatHeldDuration,
  formatPercent,
  formatPrice,
  formatSignedCurrency,
  resolveTargetDistancePct,
  toNumber,
} from '../utils/format';

function valueColor(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return colors.text;
  if (n > 0) return colors.positive;
  if (n < 0) return colors.negative;
  return colors.text;
}

function Metric({ label, value, color }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

export function PositionCard({ position }) {
  const pl = toNumber(position?.unrealized_pl);
  const plpc = toNumber(position?.unrealized_plpc);
  const distancePct = resolveTargetDistancePct(position);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.symbol}>{String(position?.symbol || '—').toUpperCase()}</Text>
        <View style={styles.plBox}>
          <Text style={[styles.plValue, { color: valueColor(pl) }]}>{formatSignedCurrency(pl)}</Text>
          <Text style={[styles.plPct, { color: valueColor(plpc) }]}>{formatPercent(plpc, { valueIsRatio: true })}</Text>
        </View>
      </View>

      <View style={styles.metricsRow}>
        <Metric label="Current" value={formatPrice(position?.current_price)} />
        <Metric label="Qty" value={String(position?.qty ?? '—')} />
        <Metric label="Mkt Value" value={formatCurrency(position?.market_value)} />
      </View>
      <View style={styles.metricsRow}>
        <Metric label="To Target" value={formatPercent(distancePct)} color={valueColor(distancePct)} />
        <Metric label="Held" value={formatHeldDuration(position?.heldSeconds)} />
        <Metric label="Sell" value={formatPrice(position?.sell?.activeLimit ?? position?.bot?.targetPrice)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  symbol: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  plBox: {
    alignItems: 'flex-end',
  },
  plValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  plPct: {
    fontSize: 12,
    fontWeight: '600',
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  metric: {
    flex: 1,
    gap: 4,
  },
  metricLabel: {
    color: colors.muted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
  metricValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
});
