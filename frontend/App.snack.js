import React from "react";
import { SafeAreaView, StatusBar, StyleSheet, View } from "react-native";

import StageDashboardScreen from "./StageDashboardScreen.snack";

const App = () => (
  <SafeAreaView style={styles.safeArea}>
    <StatusBar barStyle="light-content" />
    <View style={styles.container}>
      <StageDashboardScreen />
    </View>
  </SafeAreaView>
);

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0b0b0d",
  },
  container: {
    flex: 1,
    backgroundColor: "#0b0b0d",
  },
});

export default App;
