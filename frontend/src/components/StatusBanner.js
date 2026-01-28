import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function StatusBanner({ status, message }) {
  const variant = status || 'neutral';
  return (
    <View style={[styles.banner, styles[variant]]}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignSelf: 'flex-start',
    marginTop: 10,
  },
  text: {
    color: '#0b0b0f',
    fontWeight: '700',
    letterSpacing: 1.2,
    fontSize: 12,
  },
  ok: {
    backgroundColor: '#21d4d2',
  },
  warn: {
    backgroundColor: '#f7b733',
  },
  error: {
    backgroundColor: '#ff5f6d',
  },
  neutral: {
    backgroundColor: '#c9c9d4',
  },
});
