import React from "react";
import { StyleSheet, Text, View } from "react-native";

const metrics = [
  { label: "Portfolio Value", value: "$124,580" },
  { label: "Day P/L", value: "+$1,240" },
  { label: "Buying Power", value: "$32,900" },
  { label: "Status", value: "Active" },
];

const StageDashboardScreen = () => (
  <View style={styles.screen}>
    <Text style={styles.title}>MagicMoney – Stage Dashboard</Text>
    <Text style={styles.subtitle}>Live staging overview for today’s rehearsal.</Text>
    <View style={styles.grid}>
      {metrics.map((metric) => (
        <View key={metric.label} style={styles.card}>
          <Text style={styles.cardLabel}>{metric.label}</Text>
          <Text style={styles.cardValue}>{metric.value}</Text>
        </View>
      ))}
    </View>
  </View>
);

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0b0b0d",
    paddingHorizontal: 20,
    paddingTop: 32,
  },
  title: {
    color: "#f5f5f7",
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: {
    color: "#9a9aa1",
    fontSize: 15,
    marginBottom: 24,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  card: {
    width: "48%",
    backgroundColor: "#1a1a1f",
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#2a2a31",
  },
  cardLabel: {
    color: "#8d8d96",
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 10,
  },
  cardValue: {
    color: "#f4f4f8",
    fontSize: 20,
    fontWeight: "700",
  },
});

export default StageDashboardScreen;
