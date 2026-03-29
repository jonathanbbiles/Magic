import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Metric, Panel, StatusChip } from './ui';
import { tokens } from '../theme/tokens';
import { sinceLabel } from '../utils/formatters';

export function SystemHealthPanel({ diagnostics, staleMinutes, lastSuccessAt }) {
  const authOk = diagnostics?.alpaca?.alpacaAuthOk;
  const trading = diagnostics?.trading?.TRADING_ENABLED;
  const quoteTs = diagnostics?.diagnostics?.lastQuoteAt;
  const httpErr = diagnostics?.lastHttpError;

  return (
    <Panel
      title="Safety + Health"
      right={<StatusChip label={staleMinutes >= 2 ? 'stale' : 'live'} tone={staleMinutes >= 2 ? 'warn' : 'good'} />}
    >
      <View style={styles.row}>
        <Metric label="Auth" value={authOk ? 'Connected' : 'Missing creds'} tone={authOk ? 'good' : 'bad'} />
        <Metric label="Trading" value={trading ? 'Enabled' : 'Paused'} tone={trading ? 'good' : 'warn'} />
      </View>
      <View style={styles.row}>
        <Metric label="Last refresh" value={sinceLabel(lastSuccessAt)} />
        <Metric label="Last quote" value={sinceLabel(quoteTs)} />
      </View>

      {httpErr?.errorMessage ? (
        <View style={styles.warnBox}>
          <Text style={styles.warnTitle}>Network alert · {httpErr.errorCode || httpErr.statusCode || 'error'}</Text>
          <Text style={styles.warnText}>{httpErr.errorMessage}</Text>
        </View>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: tokens.spacing.sm },
  warnBox: {
    marginTop: tokens.spacing.sm,
    borderWidth: 1,
    borderColor: `${tokens.colors.warn}80`,
    backgroundColor: `${tokens.colors.warn}1A`,
    borderRadius: tokens.radius.md,
    padding: tokens.spacing.sm,
  },
  warnTitle: { color: tokens.colors.warn, fontWeight: '800' },
  warnText: { color: tokens.colors.textMuted, marginTop: 2 },
});
