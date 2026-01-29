import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import theme from '../styles/theme';

export default function Section({ title, children }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  title: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  body: {
    gap: 8,
  },
});
