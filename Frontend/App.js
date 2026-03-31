import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Constants from 'expo-constants';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
  TextInput,
} from 'react-native';

const REQUEST_TIMEOUT_MS = 12000;

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/$/, '');
}

function isLikelyPrivateIpUrl(url) {
  if (!url) return false;
  return /(https?:\/\/)?(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(url);
}

async function fetchEndpoint(baseUrl, path, options = {}) {
  const endpointUrl = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpointUrl, {
      method: 'GET',
      headers: options.headers || {},
      signal: controller.signal,
    });

    const rawText = await response.text();
    let parsed;

    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: endpointUrl,
      json: parsed,
      rawText,
      networkError: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      statusText: null,
      url: endpointUrl,
      json: null,
      rawText: '',
      networkError: error?.message || 'Network request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getEndpointDisplay(result) {
  if (!result) return 'Not requested yet.';
  if (result.networkError) {
    return `ERROR: ${result.networkError}\nURL: ${result.url}`;
  }

  const payload = result.json ?? result.rawText;
  return `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}\nURL: ${result.url}\n\n${typeof payload === 'string' ? payload : safeStringify(payload)}`;
}

function deriveSummary(healthResult, authResult, dashboardResult) {
  if (!healthResult) {
    return { label: 'NOT RUN', color: '#94a3b8', reachability: 'Not checked' };
  }

  if (healthResult.networkError) {
    return { label: 'BACKEND DOWN', color: '#ef4444', reachability: 'Unreachable' };
  }

  const healthOk = healthResult.ok;
  const authValue = authResult?.json?.apiTokenSet;

  if (!healthOk) {
    return { label: 'DEGRADED', color: '#f59e0b', reachability: 'Reachable' };
  }

  if (!authResult || authResult.networkError || authResult.status == null) {
    return {
      label: 'BACKEND UP / AUTH UNKNOWN',
      color: '#f59e0b',
      reachability: 'Reachable',
    };
  }

  const dashboardNetworkFail = Boolean(dashboardResult?.networkError);

  if (authValue === false) {
    if (dashboardResult?.ok) {
      return {
        label: 'BACKEND UP / AUTH NOT REQUIRED',
        color: '#22c55e',
        reachability: 'Reachable',
      };
    }

    if (dashboardNetworkFail) {
      return { label: 'DEGRADED', color: '#f59e0b', reachability: 'Reachable' };
    }

    return { label: 'DEGRADED', color: '#f59e0b', reachability: 'Reachable' };
  }

  if (authValue === true) {
    if (dashboardResult?.ok) {
      return {
        label: 'BACKEND UP / AUTH REQUIRED / TOKEN OK',
        color: '#22c55e',
        reachability: 'Reachable',
      };
    }

    if (dashboardResult?.status === 401) {
      return {
        label: 'BACKEND UP / AUTH REQUIRED / TOKEN MISSING OR BAD',
        color: '#ef4444',
        reachability: 'Reachable',
      };
    }

    return { label: 'DEGRADED', color: '#f59e0b', reachability: 'Reachable' };
  }

  return { label: 'DEGRADED', color: '#f59e0b', reachability: 'Reachable' };
}

export default function App() {
  const constantsExtra = Constants?.expoConfig?.extra || Constants?.manifest2?.extra || {};
  const backendUrl = normalizeBaseUrl(
    process.env.EXPO_PUBLIC_BACKEND_URL || constantsExtra.EXPO_PUBLIC_BACKEND_URL || ''
  );
  const apiToken = (
    process.env.EXPO_PUBLIC_API_TOKEN || constantsExtra.EXPO_PUBLIC_API_TOKEN || ''
  ).trim();
  const tokenPresent = Boolean(apiToken);
  const authMode = tokenPresent ? 'Bearer + x-api-key' : 'No auth headers';

  const [isRunning, setIsRunning] = useState(false);
  const [healthResult, setHealthResult] = useState(null);
  const [authResult, setAuthResult] = useState(null);
  const [dashboardResult, setDashboardResult] = useState(null);
  const [lastRunAt, setLastRunAt] = useState(null);

  const runChecks = useCallback(async () => {
    if (!backendUrl) return;

    setIsRunning(true);

    const health = await fetchEndpoint(backendUrl, '/health');
    const auth = await fetchEndpoint(backendUrl, '/debug/auth');

    const dashboardHeaders = tokenPresent
      ? {
          Authorization: `Bearer ${apiToken}`,
          'x-api-key': apiToken,
        }
      : {};

    const dashboard = await fetchEndpoint(backendUrl, '/dashboard', {
      headers: dashboardHeaders,
    });

    setHealthResult(health);
    setAuthResult(auth);
    setDashboardResult(dashboard);
    setLastRunAt(new Date().toISOString());
    setIsRunning(false);
  }, [backendUrl, tokenPresent, apiToken]);

  useEffect(() => {
    runChecks();
  }, [runChecks]);

  const summary = deriveSummary(healthResult, authResult, dashboardResult);

  const healthStatus = healthResult
    ? healthResult.networkError
      ? 'Request failed'
      : `HTTP ${healthResult.status}`
    : 'Not checked';

  const authStatus = authResult
    ? authResult.networkError
      ? 'Request failed'
      : `HTTP ${authResult.status} (apiTokenSet: ${String(authResult?.json?.apiTokenSet)})`
    : 'Not checked';

  const dashboardStatus = dashboardResult
    ? dashboardResult.networkError
      ? 'Request failed'
      : `HTTP ${dashboardResult.status}`
    : 'Not checked';

  const diagnosticsText = useMemo(() => {
    const lines = [
      `Timestamp: ${new Date().toISOString()}`,
      `Backend URL: ${backendUrl || '(missing EXPO_PUBLIC_BACKEND_URL)'}`,
      `Token present: ${tokenPresent ? 'yes' : 'no'}`,
      `Auth mode: ${authMode}`,
      `Overall status: ${summary.label}`,
      `Reachability: ${summary.reachability}`,
      `Health status: ${healthStatus}`,
      `Auth status: ${authStatus}`,
      `Dashboard status: ${dashboardStatus}`,
      '',
      '[Raw /health]',
      getEndpointDisplay(healthResult),
      '',
      '[Raw /debug/auth]',
      getEndpointDisplay(authResult),
      '',
      '[Raw /dashboard]',
      getEndpointDisplay(dashboardResult),
    ];

    return lines.join('\n');
  }, [
    backendUrl,
    tokenPresent,
    authMode,
    summary.label,
    summary.reachability,
    healthStatus,
    authStatus,
    dashboardStatus,
    healthResult,
    authResult,
    dashboardResult,
  ]);

  const hints = useMemo(() => {
    const hintList = [];

    if (!backendUrl) {
      hintList.push('Set EXPO_PUBLIC_BACKEND_URL in your Expo environment before running checks.');
      return hintList;
    }

    if (healthResult?.networkError) {
      hintList.push('Network request failed for /health. Verify backend host, port, and device connectivity.');
    }

    if (!tokenPresent) {
      hintList.push('No frontend token configured (EXPO_PUBLIC_API_TOKEN missing). /dashboard may return 401 when backend auth is enabled.');
    }

    if (dashboardResult?.status === 401) {
      hintList.push('Dashboard returned 401: token is missing, expired, or does not match backend API_TOKEN.');
    }

    if (dashboardResult?.status === 403) {
      hintList.push('Dashboard returned 403: request may be blocked by backend CORS policy or origin restrictions.');
    }

    if (healthResult?.ok && dashboardResult && !dashboardResult.ok && !dashboardResult.networkError) {
      hintList.push('Health succeeded but dashboard failed, so backend is up but protected or degraded on /dashboard.');
    }

    if (isLikelyPrivateIpUrl(backendUrl)) {
      hintList.push('Backend URL uses a private LAN IP. This works only when phone and backend are on the same LAN/VPN; cellular usually cannot reach it.');
    }

    if (hintList.length === 0) {
      hintList.push('No common issues detected from the latest checks.');
    }

    return hintList;
  }, [backendUrl, healthResult, dashboardResult, tokenPresent]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Backend Diagnostic</Text>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Connection Summary</Text>
          <Text style={[styles.statusLabel, { color: summary.color }]}>{summary.label}</Text>
          <Text style={styles.row}>Backend URL: {backendUrl || 'Missing EXPO_PUBLIC_BACKEND_URL'}</Text>
          <Text style={styles.row}>Token present: {tokenPresent ? 'yes' : 'no'}</Text>
          <Text style={styles.row}>Auth mode: {authMode}</Text>
          <Text style={styles.row}>Reachability: {summary.reachability}</Text>
          <Text style={styles.row}>Health status: {healthStatus}</Text>
          <Text style={styles.row}>Auth status: {authStatus}</Text>
          <Text style={styles.row}>Dashboard status: {dashboardStatus}</Text>
          <Text style={styles.subtle}>Last run: {lastRunAt || 'not yet run'}</Text>
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.button, styles.primaryButton, (!backendUrl || isRunning) && styles.disabledButton]}
            onPress={runChecks}
            disabled={!backendUrl || isRunning}
          >
            <Text style={styles.buttonText}>{isRunning ? 'Running…' : 'Run Checks'}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Endpoint Results</Text>

          <Text style={styles.endpointTitle}>/health</Text>
          <Text style={styles.code}>{getEndpointDisplay(healthResult)}</Text>

          <Text style={styles.endpointTitle}>/debug/auth</Text>
          <Text style={styles.code}>{getEndpointDisplay(authResult)}</Text>

          <Text style={styles.endpointTitle}>/dashboard</Text>
          <Text style={styles.code}>{getEndpointDisplay(dashboardResult)}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Helpful Diagnostics</Text>
          {hints.map((hint) => (
            <Text key={hint} style={styles.hintLine}>{`• ${hint}`}</Text>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Copy Diagnostics</Text>
          <Text style={styles.subtle}>
            Clipboard helper is intentionally omitted to keep dependencies minimal. Copy from the text box below.
          </Text>
          <TextInput
            style={styles.diagnosticsBox}
            multiline
            editable={false}
            selectTextOnFocus
            value={diagnosticsText}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#020617',
  },
  container: {
    padding: 16,
    gap: 12,
  },
  title: {
    color: '#e2e8f0',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  card: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  sectionTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
  },
  statusLabel: {
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 8,
  },
  row: {
    color: '#cbd5e1',
    marginBottom: 5,
  },
  subtle: {
    color: '#94a3b8',
    marginTop: 8,
  },
  buttonRow: {
    gap: 8,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#2563eb',
  },
  disabledButton: {
    backgroundColor: '#334155',
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  endpointTitle: {
    color: '#e2e8f0',
    marginTop: 10,
    marginBottom: 6,
    fontWeight: '700',
  },
  code: {
    color: '#93c5fd',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  hintLine: {
    color: '#cbd5e1',
    marginBottom: 6,
    lineHeight: 18,
  },
  diagnosticsBox: {
    marginTop: 8,
    minHeight: 240,
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    padding: 10,
    color: '#bae6fd',
    backgroundColor: '#020617',
    textAlignVertical: 'top',
    fontFamily: 'monospace',
    fontSize: 12,
  },
});
