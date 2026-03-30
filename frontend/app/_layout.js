import 'react-native-gesture-handler';
import { Tabs } from 'expo-router';
import { colors } from '../theme';

export default function RootLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarStyle: { backgroundColor: '#080812', borderTopColor: colors.stroke },
        tabBarActiveTintColor: colors.accentCyan,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Deck' }} />
      <Tabs.Screen name="positions/index" options={{ title: 'Positions' }} />
      <Tabs.Screen name="replay" options={{ title: 'Replay' }} />
      <Tabs.Screen name="system" options={{ title: 'System' }} />
      <Tabs.Screen name="positions/[symbol]" options={{ href: null, title: 'Position Detail' }} />
    </Tabs>
  );
}
