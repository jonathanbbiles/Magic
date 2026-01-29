import React from 'react';
import { ScrollView, Text, StyleSheet, View } from 'react-native';
import theme from '../styles/theme';

export default function LogList({ lines }) {
  if (!lines || lines.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No logs to display.</Text>
      </View>
    );
  }

  const trimmed = lines.slice(0, 80);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {trimmed.map((line, index) => (
        <Text key={`${index}-${line}`} style={styles.line}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    maxHeight: 280,
  },
  content: {
    paddingBottom: 8,
  },
  line: {
    color: theme.muted,
    fontSize: 12,
    marginBottom: 6,
  },
  empty: {
    paddingVertical: 12,
  },
  emptyText: {
    color: theme.muted,
    fontSize: 12,
  },
});
