import React, { useEffect, useMemo, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";

const BACKEND_BASE_URL = "http://192.168.1.100:3001";
// Replace with your backend machine IP.
// Do NOT use localhost if testing from Expo Go on a phone.
// If using an Android emulator, localhost is usually http://10.0.2.2:3001
// If using iOS simulator on the same Mac, localhost may work.

export default function App() {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);

  const status = useMemo(() => {
    if (loading) return "CHECKING";
    if (error) return "DOWN";
    if (health && dashboard) return "UP";
    if (health && !dashboard) return "DEGRADED";
    return "DOWN";
  }, [loading, error, health, dashboard]);

  const statusColor = useMemo(() => {
    switch (status) {
      case "UP":
        return "#16a34a";
      case "DEGRADED":
        return "#d97706";
      case "DOWN":
        return "#dc2626";
      default:
        return "#2563eb";
    }
  }, [status]);

  async function fetchJson(path) {
    const res = await fetch(`${BACKEND_BASE_URL}${path}`);
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      throw new Error(`${path} failed with ${res.status}`);
    }

    return data;
  }

  async function runChecks() {
    setLoading(true);
    setError(null);
    setHealth(null);
    setDashboard(null);

    try {
      const healthResult = await fetchJson("/health");
      setHealth(healthResult);

      try {
        const dashboardResult = await fetchJson("/dashboard");
        setDashboard(dashboardResult);
      } catch (dashboardErr) {
        setDashboard({ error: dashboardErr.message });
      }

      setLastChecked(new Date().toLocaleString());
    } catch (err) {
      setError(err.message || "Unknown error");
      setLastChecked(new Date().toLocaleString());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    runChecks();
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Backend Status</Text>
        <Text style={styles.subtitle}>{BACKEND_BASE_URL}</Text>

        <View style={[styles.card, { borderColor: statusColor }]}> 
          <Text style={styles.label}>Overall Status</Text>
          <Text style={[styles.status, { color: statusColor }]}>{status}</Text>

          {loading ? (
            <ActivityIndicator size="large" color={statusColor} style={{ marginTop: 12 }} />
          ) : (
            <>
              <Text style={styles.meta}>Last checked: {lastChecked || "—"}</Text>
              {error ? <Text style={styles.error}>Error: {error}</Text> : null}
            </>
          )}
        </View>

        <Pressable style={styles.button} onPress={runChecks}>
          <Text style={styles.buttonText}>Check Again</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>/health response</Text>
          <Text style={styles.code}>{health ? JSON.stringify(health, null, 2) : "No response"}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>/dashboard response</Text>
          <Text style={styles.code}>{dashboard ? JSON.stringify(dashboard, null, 2) : "No response"}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>How to read this</Text>
          <Text style={styles.body}>UP = /health and /dashboard both responded.</Text>
          <Text style={styles.body}>DEGRADED = /health worked, but /dashboard did not.</Text>
          <Text style={styles.body}>DOWN = backend could not be reached.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  container: {
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#f8fafc",
  },
  subtitle: {
    color: "#94a3b8",
    marginTop: 4,
    marginBottom: 8,
  },
  card: {
    backgroundColor: "#111827",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  label: {
    color: "#94a3b8",
    fontSize: 14,
    marginBottom: 8,
  },
  status: {
    fontSize: 36,
    fontWeight: "800",
  },
  meta: {
    color: "#cbd5e1",
    marginTop: 10,
  },
  error: {
    color: "#fca5a5",
    marginTop: 8,
  },
  button: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "white",
    fontWeight: "700",
    fontSize: 16,
  },
  sectionTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
  },
  body: {
    color: "#cbd5e1",
    marginBottom: 8,
    lineHeight: 20,
  },
  code: {
    color: "#93c5fd",
    fontFamily: "monospace",
    fontSize: 12,
  },
});
