import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../theme';

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usd(value) {
  const v = num(value);
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value) {
  const v = num(value);
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function bps(value) {
  const v = num(value);
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(1)} bps`;
}

function ageLabel(seconds) {
  const s = num(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  const mins = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${mins}m ${rem}s`;
}

function signedUsd(value) {
  const v = num(value);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v >= 0 ? '+' : '-'}$${abs}`;
}

export default function PositionCard({ position }) {
  const upnl = num(position?.unrealized_pl);
  const upnlPct = num(position?.unrealized_plpc);
  const upnlPctDisplay = Number.isFinite(upnlPct) ? upnlPct * 100 : null;
  const pnlPositive = (upnl || 0) >= 0;

  return (
    <LinearGradient colors={[theme.colors.cardAlt, theme.colors.card]} style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.symbol}>{position?.symbol || '—'}</Text>
        <Text style={styles.qty}>Qty {position?.qty ?? '—'}</Text>
      </View>

      <View style={styles.row}>
        <Stat label="Avg Entry" value={usd(position?.avg_entry_price)} />
        <Stat label="Current" value={usd(position?.current_price)} />
      </View>

      <View style={styles.row}>
        <Stat
          label="Unrealized P/L"
          value={`${signedUsd(upnl)} (${pct(upnlPctDisplay)})`}
          valueStyle={{ color: pnlPositive ? theme.colors.positive : theme.colors.negative }}
        />
      </View>

      <View style={styles.row}>
        <Stat label="SELL LIMIT" value={usd(position?.sell?.activeLimit)} playful="🎯" />
        <Stat label="To Sell" value={pct(position?.sell?.expectedMovePct)} />
      </View>

      <View style={styles.row}>
        <Stat label="Entry Spread" value={bps(position?.bot?.entrySpreadBpsUsed)} />
        <Stat label="Required Exit" value={bps(position?.bot?.requiredExitBps)} />
      </View>

      <View style={styles.row}>
        <Stat label="Age" value={ageLabel(position?.heldSeconds)} playful="⏳" />
        <Stat label="Sell Source" value={position?.sell?.source || '—'} />
      </View>
    </LinearGradient>
  );
}

function Stat({ label, value, valueStyle, playful }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{playful ? `${playful} ` : ''}{label}</Text>
      <Text style={[styles.value, valueStyle]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: '#34245E',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: theme.spacing.sm,
  },
  symbol: {
    color: theme.colors.text,
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: 1,
  },
  qty: {
    color: theme.colors.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  stat: {
    flex: 1,
  },
  label: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  value: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
});
