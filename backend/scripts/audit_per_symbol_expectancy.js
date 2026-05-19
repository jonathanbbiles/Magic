// CLI wrapper around modules/perSymbolExpectancyAudit. Reads recent
// closed-trade records from closed_trade_stats.jsonl and prints the
// (symbol × signalVersion) expectancy grid + outliers to stdout.
//
// Usage:
//   node backend/scripts/audit_per_symbol_expectancy.js
//   node backend/scripts/audit_per_symbol_expectancy.js --min-entries=10 --outlier-bps=-30
//
// The dashboard already surfaces this at /dashboard.meta.perSymbolExpectancy;
// the CLI is for ad-hoc analysis when an operator wants to slice the data
// without standing up the server.

const fs = require('fs');
const path = require('path');
const { buildAudit } = require('../modules/perSymbolExpectancyAudit');
const { resolveStoragePaths } = require('../modules/storagePaths');

function parseArgValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function readClosedTrades() {
  const storage = resolveStoragePaths();
  const file = storage?.paths?.closedTradeStatsFile;
  if (!file) {
    console.error('storage_paths_unresolved');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.warn('closed_trade_stats_file_missing', { file });
    return [];
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && rec.type === 'closed_trade') records.push(rec);
    } catch (_) {
      // Skip malformed lines silently — they're not worth crashing over.
    }
  }
  return records;
}

const minEntries = Math.max(1, Number(parseArgValue('min-entries')) || 5);
const outlierBps = Number.isFinite(Number(parseArgValue('outlier-bps')))
  ? Number(parseArgValue('outlier-bps'))
  : -20;

const records = readClosedTrades();
const audit = buildAudit({ records, config: { minEntries, outlierBps } });

console.log(JSON.stringify(audit, null, 2));
process.exit(0);
