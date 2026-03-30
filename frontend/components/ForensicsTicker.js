import { ScrollView, Text, StyleSheet } from 'react-native';
import SectionCard from './SectionCard';
import { colors, spacing, typography } from '../theme';

const summarize = (positions) =>
  (positions || []).slice(0, 8).map((p) => {
    const keys = Object.keys(p.forensics || {});
    const snapshot = keys.slice(0, 2).map((key) => `${key}:${String(p.forensics[key])}`).join(' • ');
    return `${p.symbol} · ${snapshot || 'No forensics hints yet'}`;
  });

export default function ForensicsTicker({ positions }) {
  const events = summarize(positions);
  return (
    <SectionCard title="Forensics Ticker">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.text}>{events.length ? events.join('    |    ') : 'No forensics events available.'}</Text>
      </ScrollView>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  text: { ...typography.body, color: colors.textMuted, paddingRight: spacing.xl },
});
