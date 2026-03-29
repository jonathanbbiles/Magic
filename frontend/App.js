import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, SafeAreaView, StatusBar, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useMissionControlData } from './src/hooks/useMissionControlData';
import { gradients, tokens } from './src/theme/tokens';
import { deriveBotMood } from './src/utils/formatters';
import { CommandDeckScreen } from './src/screens/CommandDeckScreen';
import { PositionDetailScreen } from './src/screens/PositionDetailScreen';
import { SystemDiagnosticsScreen } from './src/screens/SystemDiagnosticsScreen';

export default function App() {
  const [screen, setScreen] = useState('deck');
  const [selectedPosition, setSelectedPosition] = useState(null);
  const data = useMissionControlData();

  const mood = useMemo(
    () => deriveBotMood({ positions: data.positions, diagnostics: data.diagnostics, staleMinutes: data.staleMinutes }),
    [data.positions, data.diagnostics, data.staleMinutes]
  );

  const openPosition = (position) => {
    setSelectedPosition(position);
    setScreen('detail');
  };

  const closePosition = () => {
    setSelectedPosition(null);
    setScreen('deck');
  };

  const header =
    screen === 'detail' ? (
      <PositionDetailScreen position={selectedPosition} data={data} mood={mood} onBack={closePosition} onOpenDiagnostics={() => setScreen('diagnostics')} />
    ) : screen === 'diagnostics' ? (
      <SystemDiagnosticsScreen data={data} mood={mood} onBack={() => setScreen('deck')} />
    ) : (
      <CommandDeckScreen data={data} mood={mood} onOpenPosition={openPosition} onOpenDiagnostics={() => setScreen('diagnostics')} />
    );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={gradients.screen} style={styles.screen}>
        <FlatList
          data={[]}
          renderItem={null}
          ListHeaderComponent={header}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refresh} tintColor={tokens.colors.text} />}
        />
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: tokens.colors.bg0 },
  screen: { flex: 1 },
  content: { padding: tokens.spacing.md, paddingBottom: tokens.spacing.xxl },
});
