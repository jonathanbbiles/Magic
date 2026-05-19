// Gate-rejection audit: shadow forward-test of every entry candidate the
// bot refuses. For each rejection that has a valid quote, capture
// { symbol, reason, midPx, signalVersion, capturedTsMs }. N minutes later
// (default 20), fetch the 1m close at that horizon and compute the
// realised forward return. Aggregate by reason to grade whether each gate
// rejected losers (gate_justified), winners (gate_costly), or noise.
//
// **Observational only — no live entry path reads this.** The aggregate
// is surfaced at `meta.gateRejectionAudit`. Operators use it to find
// gates with false-positive problems (rejecting candidates that would
// have been profitable) before tuning a gate threshold.
//
// Hard Rule #4 compliance:
// - The consumer is the dashboard meta + the offline analyst reading the
//   `gate_rejection_audit.jsonl` ledger. Not a live decision input.
// - The capture path is wired (trade.js rejectTrade), the grader is wired
//   (index.js setInterval), the aggregator is wired (index.js meta).
// - Doc claims this is observational; code never reads from this module
//   inside scanAndEnter's entry decision path.
//
// What this CANNOT answer (honest limitations):
// - The forward horizon is a single value (default 20 min). For barrier /
//   microstructure signals whose thesis is "TP in 1-6 hours," a 20-min
//   forward window scores them on the wrong unit. Extend the horizon
//   per signal once the operator has evidence one is worth grading
//   separately. Phase 1 ships a single global horizon.
// - "Forward return at horizon" is a directional measure, not a
//   simulation of what the bot's actual trade structure (TP ladder,
//   stop-loss, breakeven decay) would have produced. A gate that
//   rejects a candidate whose mid-price rises +30 bps over 20 min is
//   "gate_costly" by this audit but the actual trade outcome depends on
//   intra-bar path, staircase decay, stop-loss timing, etc.
// - Captures with no valid quote (no_quote, stale_quote,
//   pruned_stale_quotes, invalid_*) are EXCLUDED because there's no
//   trustworthy mid-price to grade against.

const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

const DEFAULT_CONFIG = Object.freeze({
  // Minimum graded sample size before a (reason × signalVersion) cell can
  // be classified as anything other than 'insufficient_sample'. Mirrors
  // the same defensive floor used in perSymbolExpectancyAudit + driftAlerter.
  minEntries: 10,
  // Verdict thresholds in bps. Asymmetric so the "noise" band can be
  // tightened independently of the alert thresholds.
  costlyThresholdBps: 10,    // avgForwardBps > this → gate_costly (gate refused a winner-on-average)
  justifiedThresholdBps: -10, // avgForwardBps < this → gate_justified (gate refused a loser-on-average)
});

// Reasons EXCLUDED from audit. These represent data-quality / capital
// constraints, not price-aware gate decisions. Including them would
// pollute the per-reason aggregates with rejections that no gate tuning
// could fix (the symbol simply had no usable quote).
const EXCLUDED_REASONS = Object.freeze(new Set([
  'no_quote',
  'stale_quote',
  'pruned_stale_quotes',
  'invalid_quote',
  'invalid_ask',
  'invalid_bid',
  'invalid_spread',
  'concurrent_position_cap',  // capital constraint, not a price-aware gate
]));

function isReasonExcluded(reason) {
  return EXCLUDED_REASONS.has(String(reason || ''));
}

const storage = resolveStoragePaths();
const gradedFilePath = storage.paths.gateRejectionAuditFile || null;
const dirPath = gradedFilePath ? path.dirname(gradedFilePath) : null;

const MAX_PENDING = Math.max(100, Number(process.env.GATE_REJECTION_AUDIT_MAX_PENDING) || 5000);
const MAX_GRADED_RECENT = Math.max(100, Number(process.env.GATE_REJECTION_AUDIT_MAX_GRADED_RECENT) || 10000);

// In-memory state. The audit is intentionally NOT crash-safe for pending
// captures — a restart loses ≤ forwardHorizonMs worth (default 20 min).
// Graded records ARE persisted to disk so the dashboard aggregate survives
// across deploys.
const pending = [];   // { symbol, reason, capturedTsMs, midPx, signalVersion, capturedAt }
const graded = [];    // pending + { gradedTsMs, gradedAt, forwardPx, forwardBps, forwardBarTs, forwardHorizonMs }

function ensureFileReady() {
  if (!gradedFilePath || !dirPath) return false;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    if (!fs.existsSync(gradedFilePath)) {
      fs.writeFileSync(gradedFilePath, '', { encoding: 'utf8' });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function appendGradedLine(payload) {
  try {
    if (!ensureFileReady()) return;
    fs.appendFileSync(gradedFilePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8' });
  } catch (err) {
    logOnce('warn', 'gate_audit_write_failed', 'gate_audit_write_failed', { error: err?.message || err });
  }
}

// Tail-read recent graded records from disk into memory so the dashboard
// aggregate is non-empty immediately after restart. Limited to
// MAX_GRADED_RECENT lines; older history stays on disk for offline reads.
function hydrateGradedFromDisk() {
  if (!gradedFilePath) return 0;
  try {
    if (!fs.existsSync(gradedFilePath)) return 0;
    const raw = fs.readFileSync(gradedFilePath, 'utf8');
    if (!raw) return 0;
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-MAX_GRADED_RECENT);
    let loaded = 0;
    for (const line of tail) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === 'gate_audit_graded' && Number.isFinite(Number(obj.forwardBps))) {
          graded.push(obj);
          loaded += 1;
        }
      } catch (_) { /* skip corrupt line */ }
    }
    return loaded;
  } catch (err) {
    logOnce('warn', 'gate_audit_hydrate_failed', 'gate_audit_hydrate_failed', { error: err?.message || err });
    return 0;
  }
}

// Capture a rejection for later grading. Returns the stored record, or
// null when the capture is rejected (excluded reason, bad inputs, etc.).
// NEVER throws — entry-path callers must not be affected by audit
// bookkeeping failures.
function capture({ symbol, reason, midPx, signalVersion = null, ts = null } = {}) {
  try {
    if (!symbol || !reason) return null;
    if (isReasonExcluded(reason)) return null;
    const mid = Number(midPx);
    if (!Number.isFinite(mid) || mid <= 0) return null;
    const tsMs = ts ? Date.parse(ts) : Date.now();
    if (!Number.isFinite(tsMs)) return null;
    const rec = {
      type: 'gate_audit_pending',
      symbol: String(symbol),
      reason: String(reason),
      signalVersion: signalVersion ? String(signalVersion) : null,
      capturedTsMs: tsMs,
      capturedAt: new Date(tsMs).toISOString(),
      midPx: mid,
    };
    pending.push(rec);
    if (pending.length > MAX_PENDING) {
      // Drop oldest pending — they'd expire soon anyway. The ring buffer
      // bound is a safety net for runs that go a long time without the
      // grader making progress (e.g., Alpaca outage).
      pending.splice(0, pending.length - MAX_PENDING);
    }
    return rec;
  } catch (_) {
    return null;
  }
}

function pushGraded(rec) {
  graded.push(rec);
  if (graded.length > MAX_GRADED_RECENT) {
    graded.splice(0, graded.length - MAX_GRADED_RECENT);
  }
  appendGradedLine(rec);
}

// Given chronologically-sorted 1m bars and a target timestamp, return
// the first bar whose `t` is at or after the target. Returns null when
// no bar reaches the target yet (forward horizon hasn't elapsed) or the
// bars array is empty/invalid.
function findBarAtOrAfter(bars, targetTsMs) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  if (!Number.isFinite(targetTsMs)) return null;
  let best = null;
  let bestTs = null;
  for (const bar of bars) {
    if (!bar || !bar.t) continue;
    const barTs = Date.parse(bar.t);
    if (!Number.isFinite(barTs)) continue;
    if (barTs < targetTsMs) continue;
    if (best == null || barTs < bestTs) {
      best = bar;
      bestTs = barTs;
    }
  }
  return best;
}

// Grade pending captures whose forward horizon has elapsed.
//
// fetchBars: async function ({symbols, timeframe, limit}) returning
//   { bars: { [symbol]: [{t, o, h, l, c, v}, ...] } } in chronological
//   order. Matches trade.js fetchCryptoBars exactly.
// nowMs: current epoch ms.
// forwardHorizonMs: how far past capture to look for the forward bar.
// maxPerCycle: cap on captures graded per call (Alpaca rate-limit budget).
// staleAfterMs: drop pending older than this without grading (typically
//   when fetchBars fails repeatedly).
async function gradePending({
  fetchBars,
  nowMs = Date.now(),
  forwardHorizonMs,
  maxPerCycle = 40,
  staleAfterMs = 6 * 60 * 60 * 1000,
  fetchLimit = 120,
} = {}) {
  if (typeof fetchBars !== 'function') {
    return { graded: 0, expired: 0, deferred: pending.length, ranAt: new Date(nowMs).toISOString() };
  }
  if (!Number.isFinite(Number(forwardHorizonMs)) || Number(forwardHorizonMs) <= 0) {
    return { graded: 0, expired: 0, deferred: pending.length, ranAt: new Date(nowMs).toISOString() };
  }
  const horizonMs = Number(forwardHorizonMs);

  // Drop expired pending captures (the forward bar window has rolled out
  // of the fetchable 24h Alpaca window or the operator set staleAfterMs).
  let expired = 0;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if ((nowMs - pending[i].capturedTsMs) > staleAfterMs) {
      pending.splice(i, 1);
      expired += 1;
    }
  }

  // Pick captures whose forward horizon has elapsed.
  const ready = [];
  for (const cap of pending) {
    if ((nowMs - cap.capturedTsMs) >= horizonMs) {
      ready.push(cap);
    }
  }
  if (!ready.length) {
    return { graded: 0, expired, deferred: pending.length, ranAt: new Date(nowMs).toISOString() };
  }

  // Sort oldest-first so the most-stale captures get graded before fresh
  // ones if maxPerCycle clips the batch.
  ready.sort((a, b) => a.capturedTsMs - b.capturedTsMs);
  const limited = ready.slice(0, Math.max(1, maxPerCycle));

  // Group by symbol — one fetchBars call per symbol returns up to
  // fetchLimit 1m bars, which covers every elapsed-horizon capture for
  // that symbol in a single round-trip.
  const bySymbol = new Map();
  for (const cap of limited) {
    if (!bySymbol.has(cap.symbol)) bySymbol.set(cap.symbol, []);
    bySymbol.get(cap.symbol).push(cap);
  }

  let gradedCount = 0;
  for (const [symbol, caps] of bySymbol.entries()) {
    let payload;
    try {
      payload = await fetchBars({ symbols: [symbol], timeframe: '1Min', limit: fetchLimit });
    } catch (err) {
      logOnce('warn', `gate_audit_grade_fetch_failed:${symbol}`, 'gate_audit_grade_fetch_failed', {
        symbol, error: err?.message || err,
      });
      continue;
    }
    // Alpaca returns bars keyed by either the slash form (BTC/USD) or the
    // joined form (BTCUSD) depending on call shape. Cover both.
    const joined = String(symbol).replace('/', '');
    const bars = payload?.bars?.[symbol] || payload?.bars?.[joined] || [];
    for (const cap of caps) {
      const targetTsMs = cap.capturedTsMs + horizonMs;
      const bar = findBarAtOrAfter(bars, targetTsMs);
      if (!bar) continue; // forward bar not yet available — leave in pending for next cycle
      const closePx = Number(bar.c);
      if (!Number.isFinite(closePx) || closePx <= 0) continue;
      const forwardBps = ((closePx - cap.midPx) / cap.midPx) * 10000;
      const gradedRec = {
        type: 'gate_audit_graded',
        symbol: cap.symbol,
        reason: cap.reason,
        signalVersion: cap.signalVersion,
        capturedTsMs: cap.capturedTsMs,
        capturedAt: cap.capturedAt,
        gradedTsMs: nowMs,
        gradedAt: new Date(nowMs).toISOString(),
        midPx: cap.midPx,
        forwardPx: closePx,
        forwardBps,
        forwardBarTs: bar.t,
        forwardHorizonMs: horizonMs,
      };
      pushGraded(gradedRec);
      gradedCount += 1;
      const idx = pending.indexOf(cap);
      if (idx >= 0) pending.splice(idx, 1);
    }
  }

  return {
    graded: gradedCount,
    expired,
    deferred: pending.length,
    ranAt: new Date(nowMs).toISOString(),
  };
}

function getPendingCount() { return pending.length; }
function getGradedCount() { return graded.length; }
function getRecentGraded(limit = 500) {
  const n = Math.max(1, Math.floor(Number(limit) || 500));
  return graded.slice(-n);
}
function clearForTests() {
  pending.length = 0;
  graded.length = 0;
}

function summarizeBucket(nets) {
  const n = nets.length;
  if (!n) return { entries: 0, avgForwardBps: null, medianForwardBps: null, winRate: null };
  let sum = 0;
  let wins = 0;
  for (const v of nets) {
    sum += v;
    if (v > 0) wins += 1;
  }
  const sorted = [...nets].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    entries: n,
    avgForwardBps: sum / n,
    medianForwardBps: median,
    winRate: wins / n,
  };
}

function verdictFor(avgForwardBps, entries, cfg) {
  if (entries < cfg.minEntries) return 'insufficient_sample';
  if (avgForwardBps == null) return 'insufficient_sample';
  if (avgForwardBps > cfg.costlyThresholdBps) return 'gate_costly';
  if (avgForwardBps < cfg.justifiedThresholdBps) return 'gate_justified';
  return 'noise';
}

// Build the dashboard payload. Aggregates graded records into per-reason
// and per-(reason × signalVersion) summaries. Sort order: most-costly
// first (highest avgForwardBps), so the dashboard top row is the single
// most-actionable gate to investigate.
//
// Returns:
//   ranAt:            ISO timestamp
//   sampleSize:       total graded records considered
//   pending:          how many captures await grading (info-only)
//   horizon:          forwardHorizonMs from the most recent record (or null)
//   config:           the effective verdict-threshold config
//   byReason:         [{reason, entries, avgForwardBps, medianForwardBps, winRate, verdict}]
//   bySignalAndReason:[{reason, signalVersion, entries, avgForwardBps, ..., verdict}]
//   costliestGates:   subset of byReason where verdict === 'gate_costly',
//                     sorted by avgForwardBps DESC (worst false-positive first)
function buildAudit({ records, config = {}, nowMs = Date.now() } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const rows = Array.isArray(records) ? records : graded;
  const byReasonBucket = new Map();
  const bySignalReasonBucket = new Map();
  let horizon = null;
  for (const r of rows) {
    if (!r) continue;
    const reason = String(r.reason || 'unknown');
    const sig = r.signalVersion ? String(r.signalVersion) : '<unknown>';
    const fwd = Number(r.forwardBps);
    if (!Number.isFinite(fwd)) continue;
    const h = Number(r.forwardHorizonMs);
    if (Number.isFinite(h)) horizon = h;
    if (!byReasonBucket.has(reason)) byReasonBucket.set(reason, []);
    byReasonBucket.get(reason).push(fwd);
    const key2 = `${reason}|${sig}`;
    if (!bySignalReasonBucket.has(key2)) {
      bySignalReasonBucket.set(key2, { reason, signalVersion: sig, nets: [] });
    }
    bySignalReasonBucket.get(key2).nets.push(fwd);
  }

  const byReason = [];
  for (const [reason, nets] of byReasonBucket.entries()) {
    const s = summarizeBucket(nets);
    byReason.push({ reason, ...s, verdict: verdictFor(s.avgForwardBps, s.entries, cfg) });
  }
  byReason.sort((a, b) => {
    const aa = a.avgForwardBps == null ? -Infinity : a.avgForwardBps;
    const bb = b.avgForwardBps == null ? -Infinity : b.avgForwardBps;
    return bb - aa;
  });

  const bySignalAndReason = [];
  for (const bucket of bySignalReasonBucket.values()) {
    const s = summarizeBucket(bucket.nets);
    bySignalAndReason.push({
      reason: bucket.reason,
      signalVersion: bucket.signalVersion,
      ...s,
      verdict: verdictFor(s.avgForwardBps, s.entries, cfg),
    });
  }
  bySignalAndReason.sort((a, b) => {
    const aa = a.avgForwardBps == null ? -Infinity : a.avgForwardBps;
    const bb = b.avgForwardBps == null ? -Infinity : b.avgForwardBps;
    return bb - aa;
  });

  const costliestGates = byReason.filter((r) => r.verdict === 'gate_costly');

  return {
    ranAt: new Date(nowMs).toISOString(),
    sampleSize: rows.length,
    pending: pending.length,
    horizon,
    config: { ...cfg },
    byReason,
    bySignalAndReason,
    costliestGates,
  };
}

// Hydrate at module load so the dashboard aggregate is populated
// immediately after restart. Set GATE_REJECTION_AUDIT_HYDRATE_AT_BOOT=false
// in Render env to disable (useful for tests).
const HYDRATE_AT_BOOT = String(process.env.GATE_REJECTION_AUDIT_HYDRATE_AT_BOOT || 'true').toLowerCase() !== 'false';
if (HYDRATE_AT_BOOT) {
  hydrateGradedFromDisk();
}

module.exports = {
  DEFAULT_CONFIG,
  EXCLUDED_REASONS,
  isReasonExcluded,
  capture,
  gradePending,
  buildAudit,
  getPendingCount,
  getGradedCount,
  getRecentGraded,
  findBarAtOrAfter,
  summarizeBucket,
  verdictFor,
  clearForTests,
};
