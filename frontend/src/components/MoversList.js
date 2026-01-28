import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { formatPct, formatUsd } from '../utils/format';
import { safeNumber } from '../utils/math';

export default function MoversList({ title, items }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {list.length === 0 ? (
        <Text style={styles.empty}>No movers</Text>
      ) : (
        list.map((item, idx) => {
          const change = safeNumber(item?.unrealized_plpc);
          const pnl = safeNumber(item?.unrealized_pl);
          const value = safeNumber(item?.market_value);
          return (
            <View key={`${item?.symbol || 'sym'}-${idx}`} style={styles.row}>
              <Text style={styles.symbol}>{item?.symbol || '—'}</Text>
              <Text style={styles.stat}>{change == null ? '—' : formatPct(change)}</Text>
              <Text style={styles.stat}>{pnl == null ? '—' : formatUsd(pnl)}</Text>
              <Text style={styles.stat}>{value == null ? '—' : formatUsd(value)}</Text>
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#141420',
    borderRadius: 16,
    padding: 16,
  },
  title: {
    color: '#f5f5f8',
    fontWeight: '700',
    marginBottom: 12,
    fontSize: 13,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e2d',
  },
  symbol: {
    color: '#f5f5f8',
    width: 60,
    fontWeight: '600',
  },
  stat: {
    color: '#c9c9d4',
    width: 80,
    textAlign: 'right',
    fontSize: 12,
  },
  empty: {
    color: '#6f7086',
    fontSize: 12,
  },
});
