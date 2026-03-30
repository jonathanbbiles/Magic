import { ScrollView, View, StyleSheet } from 'react-native';
import PortfolioReactorHero from '../components/PortfolioReactorHero';
import LivePulseBadge from '../components/LivePulseBadge';
import BotMoodBadge from '../components/BotMoodBadge';
import TargetRailCard from '../components/TargetRailCard';
import ForensicsTicker from '../components/ForensicsTicker';
import SafetyWall from '../components/SafetyWall';
import EquityGlowChart from '../components/EquityGlowChart';
import EmptyStateCard from '../components/EmptyStateCard';
import { useMagicDashboard } from '../hooks/useMagicDashboard';
import { spacing } from '../theme';

export default function DeckScreen() {
  const { dashboard, diagnostics, chartSeries, botMood, stale, errors, lastUpdatedMs } = useMagicDashboard();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <PortfolioReactorHero
        equity={dashboard.equity}
        weeklyChangePct={dashboard.weeklyChangePct}
        buyingPower={dashboard.buyingPower}
        lastUpdatedMs={lastUpdatedMs}
        mood={botMood}
      />
      <View style={styles.badges}>
        <LivePulseBadge stale={stale} disconnected={Boolean(errors.health)} />
      </View>
      <BotMoodBadge mood={botMood} />
      {dashboard.positions.length ? (
        dashboard.positions.map((position) => <TargetRailCard key={position.symbol} position={position} />)
      ) : (
        <EmptyStateCard title="No Active Positions" message="When backend sends positions[], target rails will appear here." />
      )}
      <ForensicsTicker positions={dashboard.positions} />
      <SafetyWall diagnostics={diagnostics} stale={stale} errors={errors} />
      <EquityGlowChart history={chartSeries} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  badges: { flexDirection: 'row', justifyContent: 'flex-end' },
});
