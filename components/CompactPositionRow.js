import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../constants/theme';
import { ageLabelShort, distToTargetPct, pct, signedUsd, toNum } from '../utils/formatters';

export default function CompactPositionRow({ position }) {
  const symbol = position?.symbol || '—';

  const upnl = toNum(position?.unrealized_pl);
  const upnlPctRaw = toNum(position?.unrealized_plpc);
  const upnlPct = Number.isFinite(upnlPctRaw) ? upnlPctRaw * 100 : null;
  const pnlPositive = (upnl || 0) >= 0;

  const dist = distToTargetPct(position);

  const distText = Number.isFinite(dist) ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '—';
  const pnlDollar = signedUsd(upnl);
  const pnlPercent = pct(upnlPct);
  const timeShort = ageLabelShort(position);

  const glow = pnlPositive ? theme.colors.glowPos : theme.colors.glowNeg;

  return (
    <View style={[styles.tile, { borderColor: glow }]}>
      <View style={styles.line1}>
        <Text style={styles.sym} numberOfLines={1} ellipsizeMode="tail">
          {symbol}
        </Text>
        <Text style={styles.delta} numberOfLines={1} ellipsizeMode="tail">
          Δ🎯 {distText}
        </Text>
      </View>

      <View style={styles.line2}>
        <Text
          style={[styles.pnl, { color: pnlPositive ? theme.colors.positive : theme.colors.negative }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          📌 {pnlDollar} ({pnlPercent})
        </Text>

        <Text style={styles.timeInline} numberOfLines={1} ellipsizeMode="tail">
          ⏱️ {timeShort}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    borderWidth: 1.1,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    minHeight: 0,
  },
  line1: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  line2: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  sym: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  delta: {
    color: theme.colors.warning,
    fontSize: 12,
    fontWeight: '900',
  },
  pnl: {
    flex: 1,
    fontSize: 12,
    fontWeight: '900',
  },
  timeInline: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '800',
  },
});
