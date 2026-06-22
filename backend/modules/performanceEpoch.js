// Performance epoch — a non-destructive "point 0" for tracking the reality of a
// strategy change.
//
// THE PROBLEM. The all-time scorecard mixes every closed trade ever, so a fresh
// strategy's true performance is buried under hundreds of old-strategy trades
// (e.g. 274 legacy mean-reversion losers dragging expectancy to -0.04/trade).
// You can't see whether the NEW thing is working.
//
// WHAT THIS DOES. Marks an epoch timestamp + a baseline equity. Downstream, the
// dashboard computes a "since reset" scorecard (closed trades with ts >= epoch)
// and a since-reset P&L (currentEquity vs baselineEquity). NOTHING is deleted —
// the full history stays on disk and the all-time scorecard is unchanged. To
// reset again, bump PERFORMANCE_EPOCH_AT and redeploy.
//
// HONESTY SPLIT. `pnlUsd` (equity delta) folds in deposits/withdrawals and
// unrealized P&L, so it is NOT a strategy-performance number. buildSinceEpoch
// also surfaces `realizedTradingPnlUsd` (deposit-free, from the closed-trade
// scorecard), `externalFlowUsd` (the unexplained remainder = deposits/withdrawals
// + unrealized), and `externalFlowSuspected` (true when the equity move is
// dominated by flows, i.e. a "+X%" tile that's really a wallet top-up).
//
// CONFIG-DRIVEN. The epoch is whatever PERFORMANCE_EPOCH_AT (ISO) resolves to.
// On boot we reconcile: if the configured epoch differs from the persisted one,
// we adopt the new epoch and clear the baseline (a real reset). The baseline
// equity is captured lazily — the first finite equity reading at/after boot is
// stamped + persisted, so "% since reset" has a stable anchor even if the equity
// snapshot file is later pruned.
//
// PURITY. All fs access goes through an injectable fsImpl + explicit filePath so
// the tests drive it hermetically against a temp dir.

const fs = require('fs');
const { resolveStoragePaths } = require('./storagePaths');

let _filePath = (() => {
  try { return resolveStoragePaths().paths.performanceEpochFile || null; } catch (_) { return null; }
})();

// In-memory epoch state. epochStartMs null => no epoch configured (feature off).
let _epoch = {
  epochStartMs: null,
  epochStartIso: null,
  baselineEquity: null,
  baselineEquityTs: null,
  note: null,
};

function readFile(fsImpl, filePath) {
  try {
    if (!filePath || !fsImpl.existsSync(filePath)) return null;
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function writeFile(fsImpl, filePath, obj) {
  try {
    if (!filePath) return false;
    const tmp = `${filePath}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fsImpl.renameSync(tmp, filePath);
    return true;
  } catch (_) { return false; }
}

function parseEpochMs(epochAtIso) {
  if (epochAtIso == null || String(epochAtIso).trim() === '') return null;
  const ms = Date.parse(String(epochAtIso).trim());
  return Number.isFinite(ms) ? ms : null;
}

// Reconcile the configured epoch with whatever is persisted. If the config epoch
// differs from the persisted epoch (a reset), adopt it and drop the baseline.
// Returns the resolved epoch state. Pure given its inputs.
function loadEpoch({ epochAtIso, fsImpl = fs, filePath = _filePath } = {}) {
  const configuredMs = parseEpochMs(epochAtIso);
  const persisted = readFile(fsImpl, filePath);

  if (configuredMs == null) {
    // No epoch configured → feature off. Keep any persisted state for reference
    // but report inactive.
    _epoch = persisted && Number.isFinite(persisted.epochStartMs)
      ? { ...persisted }
      : { epochStartMs: null, epochStartIso: null, baselineEquity: null, baselineEquityTs: null, note: null };
    return getEpoch();
  }

  if (persisted && persisted.epochStartMs === configuredMs) {
    // Same epoch → keep the persisted baseline (don't re-anchor on restart).
    _epoch = {
      epochStartMs: configuredMs,
      epochStartIso: new Date(configuredMs).toISOString(),
      baselineEquity: Number.isFinite(persisted.baselineEquity) ? persisted.baselineEquity : null,
      baselineEquityTs: persisted.baselineEquityTs || null,
      note: persisted.note ?? null,
    };
  } else {
    // New/changed epoch → reset: adopt it, clear the baseline (captured lazily).
    _epoch = {
      epochStartMs: configuredMs,
      epochStartIso: new Date(configuredMs).toISOString(),
      baselineEquity: null,
      baselineEquityTs: null,
      note: 'reset',
    };
    writeFile(fsImpl, filePath, _epoch);
  }
  return getEpoch();
}

// Stamp the baseline equity the first time we have a finite reading after the
// epoch is active. Idempotent — once set, it never moves (until the next reset).
function ensureBaseline(equity, { nowMs = null, fsImpl = fs, filePath = _filePath } = {}) {
  if (!Number.isFinite(_epoch.epochStartMs)) return getEpoch();
  if (Number.isFinite(_epoch.baselineEquity)) return getEpoch();
  const e = Number(equity);
  if (!Number.isFinite(e) || e <= 0) return getEpoch();
  const tsMs = Number.isFinite(nowMs) ? nowMs : null;
  _epoch.baselineEquity = e;
  _epoch.baselineEquityTs = tsMs != null ? new Date(tsMs).toISOString() : new Date(_epoch.epochStartMs).toISOString();
  writeFile(fsImpl, filePath, _epoch);
  return getEpoch();
}

function getEpoch() { return { ..._epoch, active: Number.isFinite(_epoch.epochStartMs) }; }

function epochStartMs() { return Number.isFinite(_epoch.epochStartMs) ? _epoch.epochStartMs : null; }

// Filter closed-trade records (each with an ISO `ts`) to those at/after the
// epoch. Returns all records when no epoch is active.
function filterRecordsByEpoch(records) {
  if (!Array.isArray(records)) return [];
  const ms = epochStartMs();
  if (ms == null) return records.slice();
  return records.filter((r) => {
    const t = Date.parse(r?.ts);
    return Number.isFinite(t) && t >= ms;
  });
}

// Assemble the since-reset performance block for the dashboard. `scorecardFn`
// is closedTradeStats.buildScorecard (called with the epoch sinceMs). Returns
// null when no epoch is active.
function buildSinceEpoch({ scorecardFn, currentEquity } = {}) {
  const ms = epochStartMs();
  if (ms == null) return null;
  const baseline = Number.isFinite(_epoch.baselineEquity) ? _epoch.baselineEquity : null;
  const cur = Number(currentEquity);
  const haveCur = Number.isFinite(cur);
  const pnlUsd = (baseline != null && haveCur) ? cur - baseline : null;
  const pctChange = (baseline != null && baseline > 0 && haveCur) ? ((cur - baseline) / baseline) * 100 : null;
  let scorecard = null;
  try { scorecard = typeof scorecardFn === 'function' ? scorecardFn(5000, ms) : null; } catch (_) { scorecard = null; }

  // Honesty split. `pnlUsd` is the raw equity delta (currentEquity vs baseline),
  // which silently folds in deposits/withdrawals AND unrealized P&L on still-open
  // positions — so it is NOT a measure of whether the strategy made money. The
  // scorecard already carries the deposit-free realized trading P&L (sum of every
  // closed trade's net P&L since the epoch); surface it explicitly so a +equity
  // tile driven by a wallet top-up can't masquerade as performance.
  const avgNet = Number(scorecard?.avgNetPnlUsd);
  const closed = Number(scorecard?.totalClosedTrades);
  const realizedTradingPnlUsd = (Number.isFinite(avgNet) && Number.isFinite(closed))
    ? avgNet * closed
    : null;
  // Everything in the equity delta NOT explained by realized trading P&L:
  // deposits/withdrawals + unrealized on open positions. Approximate by design.
  const externalFlowUsd = (pnlUsd != null && realizedTradingPnlUsd != null)
    ? pnlUsd - realizedTradingPnlUsd
    : null;
  // Flag when the equity move is dominated by external flows rather than trading,
  // i.e. the headline "+X%" is mostly deposits. Material = ≥ $1 AND larger in
  // magnitude than the realized trading P&L it's being mistaken for.
  const externalFlowSuspected = (externalFlowUsd != null && realizedTradingPnlUsd != null)
    ? (Math.abs(externalFlowUsd) >= 1 && Math.abs(externalFlowUsd) > Math.abs(realizedTradingPnlUsd))
    : null;

  return {
    active: true,
    epochStartIso: _epoch.epochStartIso,
    epochStartMs: ms,
    baselineEquity: baseline,
    baselineEquityTs: _epoch.baselineEquityTs,
    currentEquity: haveCur ? cur : null,
    pnlUsd,
    pctChange,
    realizedTradingPnlUsd,
    externalFlowUsd,
    externalFlowSuspected,
    scorecard,
  };
}

// Test hook: reset module-level state.
function _resetForTest(filePath = null) {
  _epoch = { epochStartMs: null, epochStartIso: null, baselineEquity: null, baselineEquityTs: null, note: null };
  if (filePath !== null) _filePath = filePath;
}

module.exports = {
  loadEpoch,
  ensureBaseline,
  getEpoch,
  epochStartMs,
  filterRecordsByEpoch,
  buildSinceEpoch,
  parseEpochMs,
  _resetForTest,
};
