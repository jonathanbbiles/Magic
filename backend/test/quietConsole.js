'use strict';

const level = String(process.env.TEST_LOG_LEVEL || 'normal').toLowerCase();

if (level !== 'quiet') {
  return;
}

const noisyPrefixes = [
  'marketdata_rate_limit',
  'config_warning',
  'config_summary',
  'config_drift_warning',
  'runtime_config_effective',
  'entry_manager_runtime_config',
  'entry_manager_started',
  'entry_notional_cap',
  'entry_orderbook_adaptive_thresholds',
  'entry_scan_tick_skipped',
  'supported_pairs_fetch_failed',
  'http_error',
];

const keepPatterns = [/passed/i, /failed/i, /error/i, /ok$/i];

function shouldKeep(message) {
  if (!message) return false;
  if (keepPatterns.some((pattern) => pattern.test(message))) {
    return true;
  }
  return !noisyPrefixes.some((prefix) => message.startsWith(prefix));
}

function wrap(method) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    const first = args[0];
    const text =
      typeof first === 'string' ? first : first && typeof first.message === 'string' ? first.message : '';

    if (method === 'error' || shouldKeep(text)) {
      original(...args);
    }
  };
}

wrap('log');
wrap('info');
wrap('warn');
