import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../lib/theme';

const toneColor = {
  info: theme.colors.info,
  success: theme.colors.success,
  caution: theme.colors.caution,
  danger: theme.colors.danger,
};

export function EventFeed({ events }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Event / Forensics Feed</Text>
      {events?.length ? events.map((event) => (
        <View key={event.id} style={styles.item}>
          <View style={[styles.dot, { backgroundColor: toneColor[event.tone] || theme.colors.info }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.itemTitle}>{event.title}</Text>
            <Text style={styles.itemDetail}>{event.detail}</Text>
          </View>
        </View>
      )) : <Text style={styles.empty}>No events yet.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  title: { color: theme.colors.text, fontWeight: '700', marginBottom: 10 },
  item: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 99, marginTop: 6 },
  itemTitle: { color: theme.colors.text, fontWeight: '600', fontSize: 13 },
  itemDetail: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  empty: { color: theme.colors.textMuted, fontSize: 12 },
});
