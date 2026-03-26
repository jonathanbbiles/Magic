import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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

const CHART_WIDTH = 340;
const CHART_HEIGHT = 170;

const PALETTE = ['#8C52FF', '#1AD4FF', '#35F7A6', '#FFB347', '#FF6B88', '#88A0FF'];

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

export default function HeldPositionsLiveChart({
  positions,
  historyBySymbol,
  rangeOptions,
  selectedRange,
  onSelectRange,
  mode,
  onModeChange,
  nowMs,
}) {
  const activePositions = Array.isArray(positions) ? positions : [];

  const data = useMemo(() => {
    const lines = [];
    const legend = [];

    activePositions.forEach((position, index) => {
      const symbol = String(position?.symbol || '').toUpperCase().trim();
      if (!symbol) return;
      const history = historyBySymbol?.[symbol]?.points || [];
      const visible = filterHistoryPoints(history, selectedRange, nowMs);
      const valueSeries = toValueSeries(visible, mode);
      const lineColor = PALETTE[index % PALETTE.length];

      const path = valueSeries.length >= 2 ? { symbol, points: valueSeries, color: lineColor } : null;
      if (path) lines.push(path);

      const firstRaw = visible[0]?.price;
      const lastRaw = visible[visible.length - 1]?.price;
      const currentPrice = toFiniteNumber(position?.current_price) ?? lastRaw;

      legend.push({
        symbol,
        color: lineColor,
        currentPrice,
        changePct: safePercentChange(firstRaw, lastRaw),
        hasEnoughData: valueSeries.length >= 2,
      });
    });

    const domain = calculateDomain(lines.map((line) => line.points), mode === 'normalized' ? { min: 98, max: 102 } : { min: 0, max: 1 });

    return { lines, legend, domain };
  }, [activePositions, historyBySymbol, selectedRange, nowMs, mode]);

  if (activePositions.length === 0) {
    return null;
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Held Positions Live</Text>
        <View style={styles.modeRow}>
          {['normalized', 'raw'].map((itemMode) => {
            const active = mode === itemMode;
            return (
              <Pressable
                key={itemMode}
                onPress={() => onModeChange(itemMode)}
                style={[styles.modePill, active && styles.modePillActive]}
              >
                <Text style={[styles.modeText, active && styles.modeTextActive]}>
                  {itemMode === 'normalized' ? 'Normalized' : 'Raw'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.rangeRow}>
        {rangeOptions.map((item) => {
          const active = selectedRange === item.ms;
          return (
            <Pressable
              key={item.key}
              onPress={() => onSelectRange(item.ms)}
              style={[styles.rangePill, active && styles.rangePillActive]}
            >
              <Text style={[styles.rangeText, active && styles.rangeTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.chartWrap}>
        <Svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}>
          <Line
            x1="0"
            y1={CHART_HEIGHT / 2}
            x2={CHART_WIDTH}
            y2={CHART_HEIGHT / 2}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="1"
          />
          {data.lines.map((line) => {
            const d = buildLinePath(line.points, CHART_WIDTH, CHART_HEIGHT, data.domain, 8);
            if (!d) return null;
            return <Path key={line.symbol} d={d} stroke={line.color} strokeWidth="2" fill="none" strokeLinecap="round" />;
          })}
        </Svg>

        {data.lines.length === 0 ? <Text style={styles.waiting}>Waiting for live data</Text> : null}
      </View>

      <View style={styles.legendWrap}>
        {data.legend.map((item) => {
          const positive = item.changePct >= 0;
          return (
            <View key={item.symbol} style={styles.legendRow}>
              <View style={styles.legendSymWrap}>
                <View style={[styles.legendDot, { backgroundColor: item.color }]} />
                <Text style={styles.legendSymbol}>{item.symbol}</Text>
              </View>

              <Text style={styles.legendPrice}>{usd(item.currentPrice)}</Text>
              <Text
                style={[
                  styles.legendChange,
                  { color: positive ? theme.colors.positive : theme.colors.negative },
                ]}
              >
                {pct(item.changePct)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.035)',
    padding: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '900',
  },
  modeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  modePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  modePillActive: {
    borderColor: 'rgba(26,212,255,0.55)',
    backgroundColor: 'rgba(26,212,255,0.15)',
  },
  modeText: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  modeTextActive: {
    color: theme.colors.text,
  },
  rangeRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 6,
  },
  rangePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  rangePillActive: {
    borderColor: 'rgba(140,82,255,0.7)',
    backgroundColor: 'rgba(140,82,255,0.2)',
  },
  rangeText: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  rangeTextActive: {
    color: theme.colors.text,
  },
  chartWrap: {
    marginTop: 10,
    minHeight: CHART_HEIGHT,
    justifyContent: 'center',
  },
  waiting: {
    marginTop: 8,
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  legendWrap: {
    marginTop: 10,
    gap: 6,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  legendSymWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 99,
  },
  legendSymbol: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: '900',
  },
  legendPrice: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  legendChange: {
    width: 58,
    textAlign: 'right',
    fontSize: 12,
    fontWeight: '900',
  },
});
