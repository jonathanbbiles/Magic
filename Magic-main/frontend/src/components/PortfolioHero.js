import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from '../utils/format';
import theme from '../theme';

function PortfolioHero({ portfolioValue, dayChange, dayChangePct, buyingPower, unrealizedPl }) {
  const positive = Number(dayChange) >= 0;

  return (
    <LinearGradient colors={['#0e1a39', '#0a1330', '#091024']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
      <Text style={styles.label}>Portfolio Value</Text>
      <Text style={styles.value}>{formatCurrency(portfolioValue, { maximumFractionDigits: 0 })}</Text>
      <Text style={[styles.change, { color: positive ? theme.colors.positive : theme.colors.negative }]}>
        {formatSignedCurrency(dayChange)} ({formatSignedPercent(dayChangePct)})
      </Text>

      <View style={styles.row}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Buying Power</Text>
          <Text style={styles.metricValue}>{formatCurrency(buyingPower)}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Unrealized P/L</Text>
          <Text style={[styles.metricValue, { color: Number(unrealizedPl) >= 0 ? theme.colors.positive : theme.colors.negative }]}>
            {formatSignedCurrency(unrealizedPl)}
          </Text>
        </View>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radii.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.label,
    letterSpacing: 0.4,
  },
  value: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.h1,
    fontWeight: '800',
  },
  change: {
    fontSize: theme.typography.body,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    gap: theme.spacing.md,
  },
  metric: {
    flex: 1,
    backgroundColor: 'rgba(16, 26, 48, 0.6)',
    borderRadius: theme.radii.md,
    padding: theme.spacing.sm,
  },
  metricLabel: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
  metricValue: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    marginTop: 4,
    fontWeight: '700',
  },
});

export default React.memo(PortfolioHero);
