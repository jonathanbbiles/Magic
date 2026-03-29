import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Panel } from './ui';
import { tokens } from '../theme/tokens';
import { sinceLabel } from '../utils/formatters';

export function EventFeed({ positions, diagnostics }) {
  const events = [];
  (positions || []).forEach((p) => {
    if (p?.forensics?.label) {
      events.push({
        id: `${p.symbol}-forensics`,
        symbol: p.symbol,
        title: p.forensics.label,
        detail: p.forensics.reason || p.forensics.summary || 'No detail',
        ts: p.forensics.ts,
      });
    }
  });

  if (diagnostics?.lastHttpError?.errorMessage) {
    events.unshift({
      id: 'http-error',
      symbol: 'NET',
      title: diagnostics.lastHttpError.errorCode || 'HTTP issue',
      detail: diagnostics.lastHttpError.errorMessage,
      ts: diagnostics.serverTime,
    });
  }

  const top = events.slice(0, 8);

  return (
    <Panel title="Forensics Feed">
      {top.length === 0 ? <Text style={styles.empty}>No recent reasoning events.</Text> : null}
      {top.map((e) => (
        <View key={e.id} style={styles.item}>
          <Text style={styles.title}>{e.symbol} · {e.title}</Text>
          <Text style={styles.detail} numberOfLines={2}>{e.detail}</Text>
          <Text style={styles.ts}>{sinceLabel(e.ts)}</Text>
        </View>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  empty: { color: tokens.colors.textMuted },
  item: {
    paddingVertical: tokens.spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  title: { color: tokens.colors.text, fontWeight: '800' },
  detail: { color: tokens.colors.textMuted, marginTop: 2 },
  ts: { color: tokens.colors.textFaint, fontSize: 11, marginTop: 3 },
});
