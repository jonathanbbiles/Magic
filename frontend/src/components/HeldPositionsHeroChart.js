import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Line, Path } from 'react-native-svg';
import { theme } from '../theme';
import SegmentedPills from './SegmentedPills';
import {
  buildLinePath,
  calculateDomain,
  extractSymbol,
  filterHistoryPoints,
  safePercentChange,
  toValueSeries,
} from '../utils/chartUtils';

const CHART_WIDTH = 360;
const CHART_HEIGHT = 188;
const COLORS = ['#9B6CFF', '#53D8FF', '#7BFFD8', '#FFC08A', '#FF8DBD', '#B5B4FF'];

function pct(v) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export default function HeldPositionsHeroChart({
  positions,
  historyBySymbol,
  selectedRange,
  onSelectRange,
  mode,
  onModeChange,
  nowMs,
  rangeOptions,
}) {
  const data = useMemo(() => {
    const lines = [];
    const legend = [];

    (Array.isArray(positions) ? positions : []).forEach((position, index) => {
      const symbol = extractSymbol(position);
      if (!symbol) return;

      const visible = filterHistoryPoints(historyBySymbol?.[symbol]?.points || [], selectedRange, nowMs);
      const series = toValueSeries(visible, mode);
      const color = COLORS[index % COLORS.length];

      const first = visible[0]?.price;
      const last = visible[visible.length - 1]?.price;
      const delta = safePercentChange(first, last);

      legend.push({ symbol, color, delta, hasData: series.length >= 2 });
      if (series.length >= 2) lines.push({ symbol, color, series });
    });

    const domain = calculateDomain(
      lines.map((line) => line.series),
      mode === 'normalized' ? { min: 98, max: 102 } : { min: 0, max: 1 }
    );

    const drawableLines = lines.map((line) => ({
      ...line,
      path: buildLinePath(line.series, CHART_WIDTH, CHART_HEIGHT, domain, 10),
    }));

    const sorted = [...legend].sort((a, b) => b.delta - a.delta);

    return {
      drawableLines,
      legend,
      strongest: sorted[0] || null,
      weakest: sorted[sorted.length - 1] || null,
    };
  }, [positions, historyBySymbol, selectedRange, nowMs, mode]);

  if (!Array.isArray(positions) || positions.length === 0) {
    return (
      <LinearGradient colors={['rgba(83,216,255,0.12)', 'rgba(155,108,255,0.1)']} style={styles.card}>
        <Text style={styles.title}>Held Positions Live</Text>
        <Text style={styles.empty}>No held positions yet.</Text>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={['rgba(83,216,255,0.14)', 'rgba(155,108,255,0.12)']} style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Held Positions Live</Text>
        <SegmentedPills
          compact
          options={[
            { key: 'normalized', value: 'normalized', label: 'Relative' },
            { key: 'raw', value: 'raw', label: 'Raw' },
          ]}
          selectedValue={mode}
          onSelect={onModeChange}
        />
      </View>

      <SegmentedPills
        compact
        options={(Array.isArray(rangeOptions) ? rangeOptions : []).map((item) => ({
          key: item.key,
          value: item.ms,
          label: item.label,
        }))}
        selectedValue={selectedRange}
        onSelect={onSelectRange}
      />

      <View style={styles.chartWrap}>
        <Svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}>
          <Line
            x1="0"
            y1={CHART_HEIGHT / 2}
            x2={CHART_WIDTH}
            y2={CHART_HEIGHT / 2}
            stroke="rgba(255,255,255,0.12)"
            strokeDasharray="3 5"
            strokeWidth="1"
          />
          {data.drawableLines.map((line) => (
            <Path
              key={line.symbol}
              d={line.path}
              stroke={line.color}
              strokeWidth="2.2"
              fill="none"
              strokeLinecap="round"
            />
          ))}
        </Svg>
        {data.drawableLines.length === 0 ? <Text style={styles.waiting}>Need 2+ live points to draw trend lines.</Text> : null}
      </View>

      <View style={styles.insightRow}>
        <Text style={styles.insightText}>
          Strongest: <Text style={styles.insightValue}>{data.strongest ? `${data.strongest.symbol} ${pct(data.strongest.delta)}` : '—'}</Text>
        </Text>
        <Text style={styles.insightText}>
          Weakest: <Text style={styles.insightValue}>{data.weakest ? `${data.weakest.symbol} ${pct(data.weakest.delta)}` : '—'}</Text>
        </Text>
      </View>

      <View style={styles.legendWrap}>
        {data.legend.map((item) => (
          <View key={item.symbol} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: item.color }]} />
            <Text style={styles.legendSymbol}>{item.symbol}</Text>
            <Text style={[styles.legendDelta, { color: item.delta >= 0 ? theme.colors.accentMint : theme.colors.accentBlush }]}>
              {pct(item.delta)}
            </Text>
          </View>
        ))}
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: theme.spacing.md,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    padding: 14,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  title: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: '900',
  },
  chartWrap: {
    marginTop: 12,
    minHeight: CHART_HEIGHT,
    justifyContent: 'center',
  },
  waiting: {
    marginTop: 8,
    color: theme.colors.muted,
    fontWeight: '700',
    fontSize: 12,
  },
  legendWrap: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  legendSymbol: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  legendDelta: {
    fontSize: 12,
    fontWeight: '900',
  },
  empty: {
    marginTop: 10,
    color: theme.colors.muted,
    fontSize: 14,
    fontWeight: '700',
  },
  insightRow: {
    marginTop: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  insightText: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  insightValue: {
    color: theme.colors.text,
    fontWeight: '900',
  },
});
