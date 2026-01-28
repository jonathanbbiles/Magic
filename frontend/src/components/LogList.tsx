import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

type LogItem = {
  id: string;
  title: string;
  subtitle?: string;
  timestamp?: string;
};

type LogListProps = {
  title: string;
  items: LogItem[];
  emptyLabel?: string;
};

export default function LogList({ title, items, emptyLabel = 'No logs yet.' }: LogListProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {items.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : (
        items.map((item) => (
          <View key={item.id} style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{item.title}</Text>
              {item.subtitle ? <Text style={styles.rowSubtitle}>{item.subtitle}</Text> : null}
            </View>
            <Text style={styles.rowTime}>{item.timestamp || '—'}</Text>
          </View>
        ))
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
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  empty: {
    color: '#7d7f95',
    fontSize: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#1f1f2f',
  },
  rowText: {
    flex: 1,
    marginRight: 12,
  },
  rowTitle: {
    color: '#f5f5f8',
    fontSize: 13,
    fontWeight: '600',
  },
  rowSubtitle: {
    color: '#9fa0b5',
    fontSize: 12,
    marginTop: 4,
  },
  rowTime: {
    color: '#7d7f95',
    fontSize: 11,
  },
});
