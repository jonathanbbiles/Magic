#!/usr/bin/env node
/**
 * Reconcile predicted probability vs realized outcomes on live closed trades.
 *
 * The bot's entry gate asserts a ~73%+ fill probability on every submitted
 * entry (see backend/README "Current Entry Signal Logic"). The only way to
 * know if that assertion is real is to compare it against what actually
 * happens to those entries over time. This script does that.
 *
 * Inputs (defaults resolved from DATASET_DIR, same as the live engine):
 *   - closed_trade_stats.jsonl  -- one line per TP-hit close
 *   - trade_forensics.jsonl     -- per-lifecycle events (entry_submitted,
 *                                  update patches including phase:'closed')
 *
 * Output (plain text by default; --json for a machine-readable dump):
 *   1. Totals: submitted, closed (TP-hit), still-open, realized hit rate.
 *   2. Calibration by predicted-fill-probability decile.
 *   3. Break-even table parameterised on assumed average open-position loss,
 *      because "still open" positions have no realised price yet.
 *
 * Usage:
 *   node backend/scripts/reconcile_predictions.js
 *   node backend/scripts/reconcile_predictions.js --data-dir=/mnt/data
 *   node backend/scripts/reconcile_predictions.js --since=2026-04-09T00:00:00Z
 *   node backend/scripts/reconcile_predictions.js --json
 */

const fs = require('fs');
const path = require('path');

const TARGET_NET_PROFIT_BPS = 50;
// Gross move a filled winner realises: TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP.
// Used to convert the entry-time OLS slope (bps/minute) into "minutes the signal
// implied the limit should fill in" = GROSS_TARGET_BPS / slopeBpsPerBar.
const GROSS_TARGET_BPS = 110;

function parseArgs(argv) {
  const out = { dataDir: null, since: null, json: false, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') out.json = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg.startsWith('--data-dir=')) out.dataDir = arg.slice('--data-dir='.length);
    else if (arg.startsWith('--since=')) out.since = arg.slice('--since='.length);
    else {
      console.error(`Unknown arg: ${arg}`);
      out.help = true;
    }
  }
  return out;
}

function resolveDataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  const envDir = String(process.env.DATASET_DIR || '').trim();
  if (envDir) return path.resolve(envDir);
  return path.resolve(process.cwd(), 'data');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (_) {
      // Skip malformed lines rather than blowing up a report on one bad row.
    }
  }
  return out;
}

/**
 * Fold forensics events into a per-tradeId view.
 *  - entry_submitted records carry the prediction (fillProbability etc.)
 *  - subsequent { type: 'update', tradeId, patch } lines apply updates;
 *    the most common one is `phase: 'closed'` with realizedNetBps.
 */
function foldForensics(events) {
  const byId = new Map();
  for (const ev of events) {
    if (!ev) continue;
    if (ev.type === 'update' && ev.tradeId && ev.patch && typeof ev.patch === 'object') {
      const prev = byId.get(ev.tradeId) || {};
      byId.set(ev.tradeId, { ...prev, ...ev.patch, tradeId: ev.tradeId });
      continue;
    }
    const tradeId = ev.tradeId;
    if (!tradeId) continue;
    const prev = byId.get(tradeId) || {};
    byId.set(tradeId, { ...prev, ...ev });
  }
  return byId;
}

function filterSince(records, sinceIso, tsKey = 'ts') {
  if (!sinceIso) return records;
  const cutoff = Date.parse(sinceIso);
  if (!Number.isFinite(cutoff)) return records;
  return records.filter((r) => {
    const t = Date.parse(r?.[tsKey] || '');
    return Number.isFinite(t) ? t >= cutoff : true;
  });
}

function mean(xs) {
  const arr = xs.filter((v) => Number.isFinite(v));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Linear-interpolated quantile. q in [0, 1].
function quantile(xs, q) {
  const arr = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  const pos = (arr.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

function bucketIndex(prob, buckets = 10) {
  if (!Number.isFinite(prob)) return null;
  const idx = Math.min(buckets - 1, Math.max(0, Math.floor(prob * buckets)));
  return idx;
}

function bucketLabel(idx, buckets = 10) {
  const lo = (idx / buckets).toFixed(2);
  const hi = ((idx + 1) / buckets).toFixed(2);
  return `[${lo}, ${hi})`;
}

/**
 * Build the reconciliation summary.
 *
 * A submitted trade is considered "closed" if its folded forensics record has
 * phase === 'closed' OR if we have a matching closed_trade_stats row for it.
 * Everything else submitted is "still open".
 *
 * NOTE: "still open" is not the same as "a loss". With no stop-loss and no
 * max-hold, an open position may still eventually hit its limit. But it
 * represents capital tied up and unrealised risk — it's what separates the
 * bot's predicted fill rate from realised fill rate at evaluation time.
 */
function reconcile({ forensics, closedRows }) {
  const byId = foldForensics(forensics);

  // Index closed rows by tradeId for fast merge (not every closed row has a
  // matching forensics record, especially from older sessions).
  const closedById = new Map();
  for (const row of closedRows) {
    if (row?.tradeId) closedById.set(row.tradeId, row);
  }

  const trades = [];
  const seen = new Set();

  for (const [tradeId, rec] of byId.entries()) {
    if (rec.phase === 'entry_submitted' || rec.phase === 'closed' || rec.phase === 'filled') {
      const closed = closedById.get(tradeId) || null;
      const isClosed = rec.phase === 'closed' || !!closed;
      trades.push({
        tradeId,
        symbol: rec.symbol || closed?.symbol || null,
        predictedFillProbability:
          rec.fillProbability
          ?? closed?.predictedFillProbability
          ?? null,
        predictedNetEdgeBps:
          rec.netEdgeBps
          ?? closed?.predictedNetEdgeBps
          ?? null,
        predictedExpectedMoveBps:
          rec.expectedMoveBps
          ?? closed?.predictedExpectedMoveBps
          ?? null,
        predictedSlopeBpsPerBar:
          rec.slopeBpsPerBar
          ?? closed?.predictedSlopeBpsPerBar
          ?? null,
        holdSeconds: closed?.holdSeconds ?? rec.holdSeconds ?? null,
        realizedNetBps:
          rec.realizedNetBps
          ?? closed?.realizedNetBps
          ?? null,
        isClosed,
      });
      seen.add(tradeId);
    }
  }

  // Fold in closed rows that have no forensics counterpart (e.g. older data).
  for (const [tradeId, closed] of closedById.entries()) {
    if (seen.has(tradeId)) continue;
    trades.push({
      tradeId,
      symbol: closed.symbol || null,
      predictedFillProbability: closed.predictedFillProbability ?? null,
      predictedNetEdgeBps: closed.predictedNetEdgeBps ?? null,
      predictedExpectedMoveBps: closed.predictedExpectedMoveBps ?? null,
      predictedSlopeBpsPerBar: closed.predictedSlopeBpsPerBar ?? null,
      holdSeconds: closed.holdSeconds ?? null,
      realizedNetBps: closed.realizedNetBps ?? null,
      isClosed: true,
    });
  }

  const submitted = trades.length;
  const closed = trades.filter((t) => t.isClosed);
  const open = trades.filter((t) => !t.isClosed);
  const realizedHitRate = submitted ? closed.length / submitted : null;
  const predictedFillProbMean = mean(trades.map((t) => t.predictedFillProbability));
  const avgRealizedNetBpsClosed = mean(closed.map((t) => t.realizedNetBps));

  // Decile calibration.
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    idx: i,
    label: bucketLabel(i),
    count: 0,
    closed: 0,
    predictedProbs: [],
    realizedNetBps: [],
  }));
  for (const t of trades) {
    const idx = bucketIndex(t.predictedFillProbability);
    if (idx === null) continue;
    const b = buckets[idx];
    b.count += 1;
    if (t.isClosed) b.closed += 1;
    b.predictedProbs.push(t.predictedFillProbability);
    if (Number.isFinite(t.realizedNetBps)) b.realizedNetBps.push(t.realizedNetBps);
  }
  const calibration = buckets
    .filter((b) => b.count > 0)
    .map((b) => ({
      bucket: b.label,
      count: b.count,
      predictedProbMean: mean(b.predictedProbs),
      realizedHitRate: b.count ? b.closed / b.count : null,
      gap: (() => {
        const p = mean(b.predictedProbs);
        const r = b.count ? b.closed / b.count : null;
        return Number.isFinite(p) && Number.isFinite(r) ? p - r : null;
      })(),
      avgRealizedNetBps: mean(b.realizedNetBps),
    }));

  // Break-even table: if still-open positions eventually realise an average
  // loss L (in bps), what expectancy does the portfolio see?
  //
  //   exp_bps_per_trade = hitRate * TARGET_NET_PROFIT_BPS - (1 - hitRate) * L
  //
  // We publish the table for several candidate L values so the reader can pick
  // the one matching their realised loss distribution.
  const hr = realizedHitRate;
  const breakEven = [0, 50, 100, 150, 200, 300].map((L) => {
    const expBps = Number.isFinite(hr) ? hr * TARGET_NET_PROFIT_BPS - (1 - hr) * L : null;
    // Win rate needed to break even with this L.
    const neededHitRate = L + TARGET_NET_PROFIT_BPS === 0 ? null : L / (L + TARGET_NET_PROFIT_BPS);
    return {
      assumedAvgOpenLossBps: L,
      expectancyBpsPerTrade: expBps,
      breakEvenHitRate: neededHitRate,
    };
  });

  // Time-to-fill calibration. The entry signal's projected-minutes-to-fill is
  // GROSS_TARGET_BPS / slopeBpsPerBar (1m bars -> minutes). Compare against the
  // actual time the position took to close. Ratio >> 1 means the signal's
  // implied horizon was much shorter than reality -- i.e., fillProbability is
  // over-promising the payoff timing. This is the probability-vs-payoff
  // mismatch made concrete.
  //
  // Only closed trades with a positive slope and a recorded holdSeconds
  // contribute. Open positions are excluded -- their "actual" time-to-fill is
  // still unknown, so including them would understate the true ratio.
  const timeToFillSamples = [];
  for (const t of trades) {
    if (!t.isClosed) continue;
    const slope = Number(t.predictedSlopeBpsPerBar);
    const hold = Number(t.holdSeconds);
    if (!Number.isFinite(slope) || slope <= 0) continue;
    if (!Number.isFinite(hold) || hold < 0) continue;
    const impliedMinutes = GROSS_TARGET_BPS / slope;
    const actualMinutes = hold / 60;
    const ratio = impliedMinutes > 0 ? actualMinutes / impliedMinutes : null;
    if (!Number.isFinite(ratio)) continue;
    timeToFillSamples.push({
      tradeId: t.tradeId,
      symbol: t.symbol,
      slopeBpsPerBar: slope,
      impliedMinutes,
      actualMinutes,
      ratio,
    });
  }
  const ratios = timeToFillSamples.map((s) => s.ratio);
  const impliedMinutesList = timeToFillSamples.map((s) => s.impliedMinutes);
  const actualMinutesList = timeToFillSamples.map((s) => s.actualMinutes);
  // Bucket thresholds: <1.5x implied = on-model; 1.5-3x = stretched; >=3x =
  // over-promised. These are readable operational cutoffs, not a statistical
  // claim -- they make "how far off is the predictor" visible at a glance.
  const bucketOnModel = ratios.filter((r) => r < 1.5).length;
  const bucketStretched = ratios.filter((r) => r >= 1.5 && r < 3).length;
  const bucketOverPromised = ratios.filter((r) => r >= 3).length;
  const timeToFill = {
    samples: timeToFillSamples.length,
    medianImpliedMinutes: quantile(impliedMinutesList, 0.5),
    medianActualMinutes: quantile(actualMinutesList, 0.5),
    medianRatio: quantile(ratios, 0.5),
    p25Ratio: quantile(ratios, 0.25),
    p75Ratio: quantile(ratios, 0.75),
    bucketOnModel,
    bucketStretched,
    bucketOverPromised,
  };

  return {
    totals: {
      submitted,
      closed: closed.length,
      stillOpen: open.length,
      realizedHitRate,
      predictedFillProbMean,
      avgRealizedNetBpsClosed,
    },
    calibration,
    breakEven,
    timeToFill,
  };
}

function fmtPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '   —   ';
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtNum(v, digits = 2) {
  if (!Number.isFinite(v)) return '  —  ';
  return v.toFixed(digits);
}

function renderText(summary) {
  const lines = [];
  const t = summary.totals;
  lines.push('=== Predicted vs Realized Reconciliation ===');
  lines.push('');
  lines.push('Totals');
  lines.push(`  submitted entries:           ${t.submitted}`);
  lines.push(`  closed (TP-hit):             ${t.closed}`);
  lines.push(`  still open:                  ${t.stillOpen}`);
  lines.push(`  realized hit rate:           ${fmtPct(t.realizedHitRate)}`);
  lines.push(`  mean predicted fill prob:    ${fmtPct(t.predictedFillProbMean)}`);
  lines.push(`  avg realized net bps/close:  ${fmtNum(t.avgRealizedNetBpsClosed)}`);
  lines.push('');
  lines.push('Calibration by predicted-fill-probability decile');
  lines.push('  bucket        n    pred_mean   realized   gap(pred-real)   avg_net_bps');
  for (const row of summary.calibration) {
    lines.push(
      `  ${row.bucket.padEnd(12)} ${String(row.count).padStart(4)}   ${fmtPct(row.predictedProbMean).padStart(8)}   ${fmtPct(row.realizedHitRate).padStart(8)}     ${fmtPct(row.gap).padStart(8)}       ${fmtNum(row.avgRealizedNetBps).padStart(6)}`
    );
  }
  if (!summary.calibration.length) {
    lines.push('  (no trades with a recorded predicted probability yet)');
  }
  lines.push('');
  lines.push('Expectancy given realized hit rate, parameterised on assumed avg open-position loss (L)');
  lines.push('  L (bps)   break-even hit-rate   expectancy (bps/trade)');
  for (const row of summary.breakEven) {
    lines.push(
      `  ${String(row.assumedAvgOpenLossBps).padStart(5)}     ${fmtPct(row.breakEvenHitRate).padStart(8)}              ${fmtNum(row.expectancyBpsPerTrade).padStart(8)}`
    );
  }
  lines.push('');
  const tt = summary.timeToFill || {};
  lines.push('Time-to-fill calibration (closed trades with recorded slope)');
  if (!tt.samples) {
    lines.push('  (no closed trades with slopeBpsPerBar recorded yet)');
  } else {
    lines.push(`  samples:                     ${tt.samples}`);
    lines.push(`  median implied minutes:      ${fmtNum(tt.medianImpliedMinutes, 1)}`);
    lines.push(`  median actual minutes:       ${fmtNum(tt.medianActualMinutes, 1)}`);
    lines.push(`  ratio actual/implied P25:    ${fmtNum(tt.p25Ratio)}`);
    lines.push(`  ratio actual/implied median: ${fmtNum(tt.medianRatio)}`);
    lines.push(`  ratio actual/implied P75:    ${fmtNum(tt.p75Ratio)}`);
    const pct = (n) => tt.samples ? fmtPct(n / tt.samples, 0) : '—';
    lines.push(`  on-model  (ratio <1.5):      ${String(tt.bucketOnModel).padStart(3)}  (${pct(tt.bucketOnModel)})`);
    lines.push(`  stretched (1.5 <= r < 3):    ${String(tt.bucketStretched).padStart(3)}  (${pct(tt.bucketStretched)})`);
    lines.push(`  over-promised (r >= 3):      ${String(tt.bucketOverPromised).padStart(3)}  (${pct(tt.bucketOverPromised)})`);
  }
  lines.push('');
  lines.push('Notes:');
  lines.push('  - Closed rows assume TP_LIMIT exits at +TARGET_NET_PROFIT_BPS (50 bps net).');
  lines.push('  - "Still open" positions have no realised price yet; the break-even');
  lines.push('    table lets you see expectancy under a range of eventual loss');
  lines.push('    assumptions. With no stop-loss, the actual loss tail is unbounded.');
  lines.push('  - Calibration gap > 0 means the predictor is OVER-confident in that bucket.');
  lines.push('  - Time-to-fill implied = GROSS_TARGET_BPS / slopeBpsPerBar (minutes if the');
  lines.push('    observed slope held). Ratio >> 1 means the signal horizon was much shorter');
  lines.push('    than the realised fill time. Excludes still-open positions.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node backend/scripts/reconcile_predictions.js [options]

Options:
  --data-dir=PATH   override DATASET_DIR (default: $DATASET_DIR or ./data)
  --since=ISO       only include records with ts >= ISO timestamp
  --json            emit JSON instead of the plain-text report
  -h, --help        show this help`);
    return;
  }
  const dataDir = resolveDataDir(args.dataDir);
  const forensicsPath = path.join(dataDir, 'trade_forensics.jsonl');
  const closedPath = path.join(dataDir, 'closed_trade_stats.jsonl');

  const forensicsRaw = readJsonl(forensicsPath);
  const closedRaw = readJsonl(closedPath);
  const forensics = filterSince(forensicsRaw, args.since, 'ts');
  const closedRows = filterSince(closedRaw, args.since, 'ts');

  const summary = reconcile({ forensics, closedRows });
  summary.meta = {
    dataDir,
    forensicsPath,
    closedPath,
    forensicsRecords: forensicsRaw.length,
    closedRecords: closedRaw.length,
    since: args.since || null,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`# data-dir: ${dataDir}`);
  console.log(`# forensics: ${forensicsRaw.length} rows${args.since ? ` (since ${args.since})` : ''}`);
  console.log(`# closed:    ${closedRaw.length} rows${args.since ? ` (since ${args.since})` : ''}`);
  console.log('');
  console.log(renderText(summary));
}

module.exports = { reconcile, foldForensics, bucketIndex, bucketLabel, quantile, GROSS_TARGET_BPS };

if (require.main === module) {
  main();
}
