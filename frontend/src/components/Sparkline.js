import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { theme } from '../theme';
import {
  buildLinePath,
  calculateDomain,
  filterHistoryPoints,
  safePercentChange,
  toFiniteNumber,
  toValueSeries,
} from '../utils/chartUtils';

const WIDTH = 124;
const HEIGHT = 40;

function usd(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '0.00%';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export default function Sparkline({
  points,
  rangeMs,
  nowMs,
  currentPrice,
  style,
}) {
  const chart = useMemo(() => {
    const visible = filterHistoryPoints(points, rangeMs, nowMs);
    const valueSeries = toValueSeries(visible, 'raw');
    const domain = calculateDomain([valueSeries], { min: 0, max: 1 });
    const path = buildLinePath(valueSeries, WIDTH, HEIGHT, domain, 3);

    const first = valueSeries[0]?.value;
    const last = valueSeries[valueSeries.length - 1]?.value;
    const changePct = safePercentChange(first, last);
    return {
      path,
      valueSeries,
      changePct,
      first,
      last,
    };
  }, [points, rangeMs, nowMs]);

  const displayPrice = Number.isFinite(toFiniteNumber(currentPrice))
    ? toFiniteNumber(currentPrice)
    : chart.last;

  const isPositive = chart.changePct >= 0;
  const stroke = isPositive ? theme.colors.positive : theme.colors.negative;

  return (
    <View style={[styles.wrap, style]}>
      <Svg width={WIDTH} height={HEIGHT}>
        <Line
          x1="0"
          y1={HEIGHT / 2}
          x2={WIDTH}
          y2={HEIGHT / 2}
          stroke="rgba(255,255,255,0.07)"
          strokeWidth="1"
        />
        {chart.path ? (
          <Path d={chart.path} stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
        ) : (
          <Line
            x1="3"
            y1={HEIGHT / 2}
            x2={WIDTH - 3}
            y2={HEIGHT / 2}
            stroke="rgba(255,255,255,0.16)"
            strokeWidth="2"
          />
        )}
      </Svg>

      <View style={styles.meta}>
        <Text style={styles.price}>{usd(displayPrice)}</Text>
        <Text style={[styles.change, { color: stroke }]}>{pct(chart.changePct)}</Text>
      </View>

      {chart.valueSeries.length < 2 ? <Text style={styles.waiting}>Waiting for live data</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
  },
  meta: {
    marginTop: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  price: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: '800',
  },
  change: {
    fontSize: 11,
    fontWeight: '900',
  },
  waiting: {
    marginTop: 2,
    color: theme.colors.muted,
    fontSize: 10,
    fontWeight: '700',
  },
});
