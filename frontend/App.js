import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { EventFeed } from './components/EventFeed';
import { PortfolioHero } from './components/PortfolioHero';
import { PositionCard } from './components/PositionCard';
import { SystemHealthPanel } from './components/SystemHealthPanel';
import { fetchMissionControlSnapshot } from './lib/api';
import { theme } from './lib/theme';

export default function App() {
  const [mode, setMode] = useState('deck');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const next = await fetchMissionControlSnapshot();
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || 'Failed to load mission control snapshot.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const selectedPosition = useMemo(
    () => snapshot?.positions?.find((position) => position.symbol === selectedSymbol) || null,
    [snapshot?.positions, selectedSymbol]
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={theme.colors.text} />}
      >
        <View style={styles.segment}>
          <Pressable style={[styles.segmentBtn, mode === 'deck' && styles.segmentBtnActive]} onPress={() => setMode('deck')}><Text style={styles.segmentText}>Command Deck</Text></Pressable>
          <Pressable style={[styles.segmentBtn, mode === 'diagnostics' && styles.segmentBtnActive]} onPress={() => setMode('diagnostics')}><Text style={styles.segmentText}>Diagnostics</Text></Pressable>
        </View>

        {!snapshot && !error ? <ActivityIndicator color={theme.colors.text} style={{ marginTop: 40 }} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {snapshot ? (
          <>
            <PortfolioHero
              accountValue={snapshot.accountValue}
              botState={snapshot.botState}
              lastUpdated={snapshot.dashboardTs}
              staleSeconds={snapshot.staleSeconds}
            />

            {mode === 'deck' ? (
              <>
                <Text style={styles.sectionTitle}>Open Positions</Text>
                {snapshot.positions.length ? snapshot.positions.map((position) => (
                  <PositionCard
                    key={position.symbol}
                    position={position}
                    onPress={() => setSelectedSymbol(selectedSymbol === position.symbol ? null : position.symbol)}
                    expanded={selectedSymbol === position.symbol}
                  />
                )) : <Text style={styles.empty}>No open positions.</Text>}

                <EventFeed events={snapshot.events} />
                <SystemHealthPanel diagnostics={snapshot.diagnostics} />
              </>
            ) : (
              <SystemHealthPanel diagnostics={snapshot.diagnostics} />
            )}

            {selectedPosition ? (
              <View style={styles.detailBanner}>
                <Text style={styles.detailTitle}>Position Detail Mode: {selectedPosition.symbol}</Text>
                <Text style={styles.detailSub}>Tap the card again to collapse details.</Text>
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  screen: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl },
  segment: {
    flexDirection: 'row',
    backgroundColor: theme.colors.panel,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: 4,
    marginBottom: theme.spacing.md,
  },
  segmentBtn: { flex: 1, paddingVertical: 10, borderRadius: theme.radius.sm },
  segmentBtnActive: { backgroundColor: theme.colors.panelAlt },
  segmentText: { color: theme.colors.text, textAlign: 'center', fontWeight: '600' },
  sectionTitle: { color: theme.colors.text, fontWeight: '700', marginBottom: 10, marginTop: 6 },
  empty: { color: theme.colors.textMuted, marginBottom: 14 },
  error: { color: theme.colors.danger, marginVertical: 16 },
  detailBanner: {
    borderWidth: 1,
    borderColor: theme.colors.info,
    borderRadius: theme.radius.md,
    backgroundColor: '#0a1a33',
    padding: theme.spacing.md,
  },
  detailTitle: { color: theme.colors.text, fontWeight: '700' },
  detailSub: { color: theme.colors.textMuted, marginTop: 4, fontSize: 12 },
});
