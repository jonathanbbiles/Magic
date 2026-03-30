import { Text, StyleSheet } from 'react-native';
import SectionCard from './SectionCard';
import { colors, typography } from '../theme';

const moodColor = {
  hunting: colors.accentCyan,
  holding: colors.profit,
  'cooling down': colors.accentViolet,
  caution: colors.caution,
  disconnected: colors.disconnected,
};

export default function BotMoodBadge({ mood }) {
  return (
    <SectionCard title="Bot Mood">
      <Text style={[styles.mood, { color: moodColor[mood] || colors.textMuted }]}>{String(mood || 'unknown').toUpperCase()}</Text>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  mood: { ...typography.title, letterSpacing: 1.2 },
});
