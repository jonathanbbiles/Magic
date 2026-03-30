import { useWindowDimensions, View, Text, StyleSheet } from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import SectionCard from './SectionCard';
import { buildChartPoints } from '../lib/chartMath';
import { colors, typography } from '../theme';

export default function EquityGlowChart({ history }) {
  const { width } = useWindowDimensions();
  const chartWidth = Math.max(220, width - 64);
  const chartHeight = 140;
  const points = buildChartPoints(history, chartWidth, chartHeight);

  if (points.length < 2) {
    return (
      <SectionCard title="Equity Glow Chart">
        <Text style={styles.message}>Need at least two snapshots for chart rendering.</Text>
      </SectionCard>
    );
  }

  const path = Skia.Path.Make();
  path.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((p) => path.lineTo(p.x, p.y));

  return (
    <SectionCard title="Equity Glow Chart">
      <View style={{ height: chartHeight }}>
        <Canvas style={{ flex: 1 }}>
          <Path path={path} color={colors.accentCyan} style="stroke" strokeWidth={3} />
        </Canvas>
      </View>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  message: { ...typography.body, color: colors.textMuted },
});
