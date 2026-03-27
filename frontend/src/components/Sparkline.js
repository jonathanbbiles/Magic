import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { theme } from '../theme';
import {
  buildLinePath,
  calculateDomain,
  filterHistoryPoints,
  safePercentChange,
  toValueSeries,
} from '../utils/chartUtils';

const WIDTH = 140;
const HEIGHT = 44;

function pct(v) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export default function Sparkline({ points, rangeMs, nowMs, mode = 'raw', showDelta = true }) {
  const chart = useMemo(() => {
    const visible = filterHistoryPoints(points, rangeMs, nowMs);
    const series = toValueSeries(visible, mode);
    const domain = calculateDomain([series], mode === 'normalized' ? { min: 98, max: 102 } : { min: 0, max: 1 });
    const path = buildLinePath(series, WIDTH, HEIGHT, domain, 3);

    const first = series[0]?.value;
    const last = series[series.length - 1]?.value;
    const changePct = safePercentChange(first, last);
    return { path, changePct, hasEnough: series.length >= 2 };
  }, [points, rangeMs, nowMs, mode]);

  const positive = chart.changePct >= 0;
  const stroke = positive ? theme.colors.accentMint : theme.colors.accentBlush;

  return (
    <View style={styles.wrap}>
      <Svg width={WIDTH} height={HEIGHT}>
        <Line
          x1="0"
          y1={HEIGHT / 2}
          x2={WIDTH}
          y2={HEIGHT / 2}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="1"
        />
        {chart.path ? (
          <Path d={chart.path} stroke={stroke} strokeWidth="2.3" fill="none" strokeLinecap="round" />
        ) : (
          <Line
            x1="3"
            y1={HEIGHT / 2}
            x2={WIDTH - 3}
            y2={HEIGHT / 2}
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="2"
          />
        )}
      </Svg>
      {showDelta ? <Text style={[styles.delta, { color: stroke }]}>{pct(chart.changePct)}</Text> : null}
      {!chart.hasEnough ? <Text style={styles.waiting}>Live data incoming</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
  },
  delta: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: '900',
  },
  waiting: {
    marginTop: 3,
    color: theme.colors.muted,
    fontSize: 10,
    fontWeight: '700',
  },
});
