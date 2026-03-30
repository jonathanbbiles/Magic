import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { fetchDashboard } from './src/api/dashboard';
import PortfolioHero from './src/components/PortfolioHero';
import PositionCard from './src/components/PositionCard';
import ScreenHeader from './src/components/ScreenHeader';
import SortControl from './src/components/SortControl';
import StatCard from './src/components/StatCard';
import EmptyState from './src/components/EmptyState';
import theme from './src/theme';

const AUTO_REFRESH_MS = 15000;

const defaultDashboard = {
  portfolioValue: 0,
  buyingPower: 0,
  dayChange: 0,
  dayChangePct: 0,
  unrealizedPl: 0,
  status: 'unknown',
  positions: [],
};

export default function App() {
  const [dashboard, setDashboard] = useState(defaultDashboard);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sortBy, setSortBy] = useState('pl_desc');
  const inFlightRef = useRef(false);

  const refreshDashboard = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setIsRefreshing(true);
    setError('');

    try {
      const data = await fetchDashboard();
      setDashboard(data);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err?.message || 'Unable to load dashboard.');
    } finally {
      inFlightRef.current = false;
      setIsRefreshing(false);
      setIsInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      refreshDashboard();
    }, AUTO_REFRESH_MS);

    return () => clearInterval(intervalId);
  }, [refreshDashboard]);

  const stats = useMemo(() => {
    const positions = Array.isArray(dashboard.positions) ? dashboard.positions : [];
    const winnerCount = positions.filter((p) => Number(p.unrealizedPl) > 0).length;
    const loserCount = positions.filter((p) => Number(p.unrealizedPl) < 0).length;

    const statusTone = String(dashboard.status || '').toLowerCase().includes('error')
      ? 'negative'
      : ['connected', 'ok', 'active', 'live'].includes(String(dashboard.status || '').toLowerCase())
        ? 'positive'
        : 'warning';

    return [
      { key: 'positions', label: 'Positions', value: String(positions.length), tone: 'neutral' },
      {
        key: 'winners',
        label: 'Winners',
        value: positions.length ? String(winnerCount) : '—',
        tone: winnerCount > 0 ? 'positive' : 'neutral',
      },
      {
        key: 'losers',
        label: 'Losers',
        value: positions.length ? String(loserCount) : '—',
        tone: loserCount > 0 ? 'negative' : 'neutral',
      },
      { key: 'status', label: 'Status', value: dashboard.status || '—', tone: statusTone },
    ];
  }, [dashboard.positions, dashboard.status]);

  const sortedPositions = useMemo(() => {
    const positions = [...(Array.isArray(dashboard.positions) ? dashboard.positions : [])];

    switch (sortBy) {
      case 'pl_asc':
        return positions.sort((a, b) => (Number(a.unrealizedPl) || 0) - (Number(b.unrealizedPl) || 0));
      case 'symbol':
        return positions.sort((a, b) => String(a.symbol || '').localeCompare(String(b.symbol || '')));
      case 'value_desc':
        return positions.sort((a, b) => (Number(b.marketValue) || 0) - (Number(a.marketValue) || 0));
      case 'pl_desc':
      default:
        return positions.sort((a, b) => (Number(b.unrealizedPl) || 0) - (Number(a.unrealizedPl) || 0));
    }
  }, [dashboard.positions, sortBy]);

  const handleManualRefresh = useCallback(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  const renderHeader = useCallback(
    () => (
      <View style={styles.content}>
        <ScreenHeader
          status={dashboard.status}
          isRefreshing={isRefreshing}
          lastUpdated={lastUpdated}
          onRefresh={handleManualRefresh}
        />
        <PortfolioHero
          portfolioValue={dashboard.portfolioValue}
          dayChange={dashboard.dayChange}
          dayChangePct={dashboard.dayChangePct}
          buyingPower={dashboard.buyingPower}
          unrealizedPl={dashboard.unrealizedPl}
        />

        <View style={styles.statsGrid}>
          {stats.map((stat) => (
            <View key={stat.key} style={styles.statCell}>
              <StatCard label={stat.label} value={stat.value} tone={stat.tone} />
            </View>
          ))}
        </View>

        <View style={styles.positionsHeader}>
          <Text style={styles.sectionTitle}>Positions</Text>
          <SortControl selected={sortBy} onChange={setSortBy} />
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Unable to load live dashboard</Text>
            <Text style={styles.errorText}>{error}</Text>
            <Text onPress={handleManualRefresh} style={styles.retryText}>
              Tap to retry
            </Text>
          </View>
        ) : null}
      </View>
    ),
    [dashboard, error, handleManualRefresh, isRefreshing, lastUpdated, sortBy, stats],
  );

  if (isInitialLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={styles.loadingText}>Loading dashboard…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <FlatList
        data={sortedPositions}
        keyExtractor={(item, idx) => item?.id || `${item?.symbol || 'position'}-${idx}`}
        renderItem={({ item }) => <PositionCard position={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListHeaderComponent={renderHeader}
        ListHeaderComponentStyle={styles.headerSpacing}
        ListFooterComponent={<View style={styles.footerSpace} />}
        ListEmptyComponent={
          <EmptyState
            title="No open positions"
            description="Your account currently has no active positions to display. Pull down or tap refresh to check again."
          />
        }
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleManualRefresh}
            tintColor={theme.colors.accent}
            progressBackgroundColor={theme.colors.backgroundElevated}
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  loadingText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
  },
  listContainer: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
  content: {
    gap: theme.spacing.md,
  },
  headerSpacing: {
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -theme.spacing.xs,
  },
  statCell: {
    width: '50%',
    paddingHorizontal: theme.spacing.xs,
    paddingBottom: theme.spacing.sm,
  },
  positionsHeader: {
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.h3,
    fontWeight: '700',
  },
  separator: {
    height: theme.spacing.sm,
  },
  footerSpace: {
    height: theme.spacing.xl,
  },
  errorCard: {
    backgroundColor: 'rgba(255, 93, 133, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 93, 133, 0.35)',
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  errorTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  errorText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.label,
  },
  retryText: {
    marginTop: theme.spacing.xs,
    color: theme.colors.warning,
    fontWeight: '700',
    fontSize: theme.typography.label,
  },
});
