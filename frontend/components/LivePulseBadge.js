import { Text, View, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';
import { colors, radius, spacing, typography } from '../theme';

export default function LivePulseBadge({ stale, disconnected }) {
  const state = disconnected ? 'Disconnected' : stale ? 'Stale' : 'Live';
  const color = disconnected ? colors.disconnected : stale ? colors.caution : colors.profit;

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: withRepeat(withTiming(disconnected ? 0.5 : 0.9, { duration: 900 }), -1, true),
  }));

  return (
    <View style={[styles.wrap, { borderColor: `${color}88` }]}>
      <Animated.View style={[styles.dot, pulseStyle, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }]}>{state}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.cardSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  text: { ...typography.caption, fontWeight: '700' },
});
