import React from 'react';
import { SafeAreaView, StyleSheet, View, StatusBar } from 'react-native';
import StageDashboardScreen from './src/screens/StageDashboardScreen';

export default function App() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <StageDashboardScreen />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0b0b0f',
  },
  container: {
    flex: 1,
    backgroundColor: '#0b0b0f',
  },
});
