import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatCurrency, formatNumber, formatSignedCurrency, formatSignedPercent } from '../utils/format';
import theme from '../theme';

function InfoPair({ label, value, tone }) {
  return (
    <View style={styles.infoPair}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, tone && { color: tone }]}>{value}</Text>
    </View>
  );
}

function PositionCard({ position }) {
  const pnl = Number(position?.unrealizedPl);
  const tone = Number.isFinite(pnl) ? (pnl >= 0 ? theme.colors.positive : theme.colors.negative) : theme.colors.textPrimary;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.symbol}>{position?.symbol || '—'}</Text>
        <View style={styles.metaRow}>
          {position?.side ? <Text style={styles.meta}>{String(position.side).toUpperCase()}</Text> : null}
          {position?.status ? <Text style={styles.meta}>{String(position.status).toUpperCase()}</Text> : null}
        </View>
      </View>

      <View style={styles.grid}>
        <InfoPair label="Qty" value={formatNumber(position?.qty)} />
        <InfoPair label="Price" value={formatCurrency(position?.currentPrice)} />
        <InfoPair label="Avg Entry" value={formatCurrency(position?.avgEntryPrice)} />
        <InfoPair label="Market Value" value={formatCurrency(position?.marketValue)} />
        <InfoPair label="Unrealized P/L" value={formatSignedCurrency(position?.unrealizedPl)} tone={tone} />
        <InfoPair label="Unrealized P/L %" value={formatSignedPercent(position?.unrealizedPlPct)} tone={tone} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  symbol: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.h3,
    fontWeight: '800',
  },
  metaRow: {
    flexDirection: 'row',
    gap: theme.spacing.xs,
  },
  meta: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    fontWeight: '700',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: theme.spacing.sm,
  },
  infoPair: {
    width: '50%',
    paddingRight: theme.spacing.sm,
  },
  label: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
  value: {
    color: theme.colors.textPrimary,
    marginTop: 3,
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
});

export default React.memo(PositionCard);
