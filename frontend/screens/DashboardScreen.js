import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import PortfolioHero from '../src/components/PortfolioHero';
import HeldPositionsHeroChart from '../src/components/HeldPositionsHeroChart';
import PositionVisualCard from '../src/components/PositionVisualCard';
import { theme } from '../src/theme';
import { extractSymbol, RANGE_OPTIONS } from '../src/utils/chartUtils';

export default function DashboardScreen({
  positions,
  dashboard,
  historyBySymbol,
  selectedRangeMs,
  onSelectRange,
  chartMode,
  onChartMode,
  tickNowMs,
  loading,
  refreshing,
  onRefresh,
  error,
  portfolioValue,
  dayChangePct,
  buyingPower,
}) {
  return (
    <LinearGradient colors={[theme.colors.bg, theme.colors.bgAlt]} style={styles.screen}>
      <FlatList
        data={positions}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        keyExtractor={(item, idx) => `${extractSymbol(item) || 'unknown'}-${idx}`}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
        ListHeaderComponent={
          <View>
            <PortfolioHero
              portfolioValue={portfolioValue}
              dayChangePct={dayChangePct}
              buyingPower={buyingPower}
              hasError={Boolean(error)}
            />

            <HeldPositionsHeroChart
              positions={positions}
              historyBySymbol={historyBySymbol}
              rangeOptions={RANGE_OPTIONS}
              selectedRange={selectedRangeMs}
              onSelectRange={onSelectRange}
              mode={chartMode}
              onModeChange={onChartMode}
              nowMs={tickNowMs}
            />

            {error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {loading ? <ActivityIndicator color="#fff" style={styles.loader} /> : null}
            {!loading && positions.length === 0 ? <Text style={styles.empty}>No active positions.</Text> : null}

            <Text style={styles.sectionTitle}>Positions</Text>
          </View>
        }
        renderItem={({ item, index }) => {
          const symbol = extractSymbol(item);
          const historyPoints = historyBySymbol?.[symbol]?.points || [];
          return (
            <PositionVisualCard
              position={item}
              historyPoints={historyPoints}
              rangeMs={selectedRangeMs}
              nowMs={tickNowMs}
              index={index}
            />
          );
        }}
      />
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: theme.spacing.md, paddingBottom: 120 },
  gridRow: {
    justifyContent: 'space-between',
    gap: 10,
  },
  sectionTitle: {
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: '900',
  },
  errorBanner: {
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.errorBg,
    borderColor: '#8A2A3C',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
  },
  errorText: { color: theme.colors.errorText, fontWeight: '900' },
  loader: { marginVertical: theme.spacing.md },
  empty: {
    color: theme.colors.muted,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
    fontWeight: '800',
  },
});
