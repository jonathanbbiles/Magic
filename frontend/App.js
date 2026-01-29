import React from 'react';
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native';
import DashboardScreen from './src/screens/DashboardScreen.js';
import theme from './src/styles/theme';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <DashboardScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
});
