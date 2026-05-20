// Disable disk hydration so tests run hermetically against an empty
// in-memory graded buffer (otherwise a real ./data/gate_rejection_audit.jsonl
// from prior runs would contaminate sample-size assertions).
process.env.GATE_REJECTION_AUDIT_HYDRATE_AT_BOOT = 'false';

const assert = require('assert');
const {
  isReasonExcluded,
  DEFAULT_CONFIG,
  capture,
  gradePending,
  buildAudit,
  findBarAtOrAfter,
  summarizeBucket,
  verdictFor,
  getPendingCount,
  getGradedCount,
  clearForTests,
} = require('./gateRejectionAudit');

const NOW = Date.parse('2026-05-19T12:00:00.000Z');

function makeBars(startTsMs, count, priceFn = (i) => 100 + i) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    bars.push({
      t: new Date(startTsMs + i * 60_000).toISOString(),
      o: priceFn(i),
      h: priceFn(i) + 0.1,
      l: priceFn(i) - 0.1,
      c: priceFn(i),
      v: 1000,
    });
  }
  return bars;
}

(async () => {
  // 1. EXCLUDED_REASONS covers all known data-quality rejects.
  for (const reason of ['no_quote', 'stale_quote', 'pruned_stale_quotes', 'invalid_quote', 'invalid_ask', 'invalid_bid', 'invalid_spread', 'concurrent_position_cap']) {
    assert.strictEqual(isReasonExcluded(reason), true, `${reason} must be excluded`);
  }
  for (const reason of ['near_recent_high', 'spread_too_wide', 'mr_no_drop', 'htf_below_ema', 'projected_below_min', 'micro_prob_below_min']) {
    assert.strictEqual(isReasonExcluded(reason), false, `${reason} must be auditable`);
  }

  // 2. capture() rejects excluded reasons, bad inputs.
  clearForTests();
  assert.strictEqual(capture({ symbol: 'BTC/USD', reason: 'stale_quote', midPx: 100 }), null, 'excluded reason → null');
  assert.strictEqual(capture({ symbol: '', reason: 'near_recent_high', midPx: 100 }), null, 'empty symbol → null');
  assert.strictEqual(capture({ symbol: 'BTC/USD', reason: '', midPx: 100 }), null, 'empty reason → null');
  assert.strictEqual(capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: 0 }), null, 'zero midPx → null');
  assert.strictEqual(capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: -1 }), null, 'negative midPx → null');
  assert.strictEqual(capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: 'oops' }), null, 'non-numeric midPx → null');
  assert.strictEqual(getPendingCount(), 0, 'no captures stored');

  // 3. capture() stores valid records.
  clearForTests();
  const rec = capture({
    symbol: 'BTC/USD',
    reason: 'near_recent_high',
    midPx: 50000,
    signalVersion: 'mean_reversion',
    ts: new Date(NOW).toISOString(),
  });
  assert.ok(rec, 'returns record');
  assert.strictEqual(rec.symbol, 'BTC/USD');
  assert.strictEqual(rec.reason, 'near_recent_high');
  assert.strictEqual(rec.midPx, 50000);
  assert.strictEqual(rec.signalVersion, 'mean_reversion');
  assert.strictEqual(rec.capturedTsMs, NOW);
  assert.strictEqual(getPendingCount(), 1);

  // 4. findBarAtOrAfter: returns first bar >= target.
  {
    const bars = makeBars(NOW, 30);
    const bar = findBarAtOrAfter(bars, NOW + 5 * 60_000);
    assert.ok(bar, 'finds bar');
    assert.strictEqual(Date.parse(bar.t), NOW + 5 * 60_000);
  }
  {
    const bars = makeBars(NOW, 10);
    assert.strictEqual(findBarAtOrAfter(bars, NOW + 30 * 60_000), null, 'returns null when no bar past target');
  }
  assert.strictEqual(findBarAtOrAfter([], NOW), null, 'empty bars → null');
  assert.strictEqual(findBarAtOrAfter(null, NOW), null, 'null bars → null');

  // 5. gradePending: grades captures whose horizon has elapsed.
  clearForTests();
  capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: 100, signalVersion: 'ols', ts: new Date(NOW).toISOString() });
  {
    const bars = makeBars(NOW, 30, (i) => 100 + i * 0.1);
    const fetchBars = async ({ symbols }) => ({ bars: { [symbols[0]]: bars } });
    const result = await gradePending({
      fetchBars,
      nowMs: NOW + 25 * 60_000,
      forwardHorizonMs: 20 * 60_000,
    });
    assert.strictEqual(result.graded, 1, 'graded one capture');
    assert.strictEqual(result.deferred, 0, 'no captures left pending');
    assert.strictEqual(getGradedCount(), 1);
    assert.strictEqual(getPendingCount(), 0);
  }

  // 6. gradePending: leaves captures pending when horizon hasn't elapsed.
  clearForTests();
  capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: 100, ts: new Date(NOW).toISOString() });
  {
    const fetchBars = async () => ({ bars: { 'BTC/USD': makeBars(NOW, 5) } });
    const result = await gradePending({
      fetchBars,
      nowMs: NOW + 5 * 60_000,
      forwardHorizonMs: 20 * 60_000,
    });
    assert.strictEqual(result.graded, 0, 'nothing graded yet');
    assert.strictEqual(result.deferred, 1, 'still pending');
  }

  // 7. gradePending: expired captures dropped.
  clearForTests();
  capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: 100, ts: new Date(NOW).toISOString() });
  {
    const fetchBars = async () => ({ bars: {} });
    const result = await gradePending({
      fetchBars,
      nowMs: NOW + 10 * 60 * 60 * 1000,
      forwardHorizonMs: 20 * 60_000,
      staleAfterMs: 6 * 60 * 60 * 1000,
    });
    assert.strictEqual(result.expired, 1, 'expired count');
    assert.strictEqual(result.deferred, 0, 'pending drained');
  }

  // 8. gradePending: fetch failure → capture stays pending.
  clearForTests();
  capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: 100, ts: new Date(NOW).toISOString() });
  {
    const fetchBars = async () => { throw new Error('alpaca_500'); };
    const result = await gradePending({
      fetchBars,
      nowMs: NOW + 25 * 60_000,
      forwardHorizonMs: 20 * 60_000,
    });
    assert.strictEqual(result.graded, 0);
    assert.strictEqual(result.deferred, 1, 'capture stays pending for next cycle');
  }

  // 9. gradePending: maxPerCycle caps the batch.
  clearForTests();
  for (let i = 0; i < 10; i += 1) {
    capture({ symbol: `SYM${i}/USD`, reason: 'near_recent_high', midPx: 100, ts: new Date(NOW - (i + 1) * 1000).toISOString() });
  }
  {
    const bars = makeBars(NOW - 60 * 60_000, 100);
    const fetchBars = async ({ symbols }) => ({ bars: { [symbols[0]]: bars } });
    const result = await gradePending({
      fetchBars,
      nowMs: NOW + 25 * 60_000,
      forwardHorizonMs: 20 * 60_000,
      maxPerCycle: 3,
    });
    assert.strictEqual(result.graded, 3, 'batch capped');
    assert.strictEqual(result.deferred, 7);
  }

  // 10. forwardBps math: 100 → 102 = +200 bps.
  clearForTests();
  capture({ symbol: 'BTC/USD', reason: 'near_recent_high', midPx: 100, signalVersion: 'ols', ts: new Date(NOW).toISOString() });
  {
    const bars = makeBars(NOW, 30, (i) => i >= 20 ? 102 : 100);
    const fetchBars = async ({ symbols }) => ({ bars: { [symbols[0]]: bars } });
    await gradePending({
      fetchBars,
      nowMs: NOW + 25 * 60_000,
      forwardHorizonMs: 20 * 60_000,
    });
    const audit = buildAudit({ nowMs: NOW + 25 * 60_000 });
    assert.strictEqual(audit.sampleSize, 1);
    assert.strictEqual(audit.byReason.length, 1);
    assert.strictEqual(audit.byReason[0].reason, 'near_recent_high');
    assert.ok(Math.abs(audit.byReason[0].avgForwardBps - 200) < 0.001, `expected ~200 bps, got ${audit.byReason[0].avgForwardBps}`);
    assert.strictEqual(audit.byReason[0].winRate, 1);
  }

  // 11. summarizeBucket: median + winRate.
  {
    const s = summarizeBucket([-10, -5, 0, 5, 10]);
    assert.strictEqual(s.entries, 5);
    assert.strictEqual(s.avgForwardBps, 0);
    assert.strictEqual(s.medianForwardBps, 0);
    assert.strictEqual(s.winRate, 0.4);
  }
  {
    const s = summarizeBucket([10, 20]);
    assert.strictEqual(s.medianForwardBps, 15);
  }

  // 12. verdictFor: thresholds + sample size floor.
  {
    const cfg = { ...DEFAULT_CONFIG };
    assert.strictEqual(verdictFor(50, 9, cfg), 'insufficient_sample', 'sample size floor');
    assert.strictEqual(verdictFor(50, 10, cfg), 'gate_costly', 'positive forward → costly');
    assert.strictEqual(verdictFor(-50, 10, cfg), 'gate_justified', 'negative forward → justified');
    assert.strictEqual(verdictFor(0, 10, cfg), 'noise', 'near zero → noise');
    assert.strictEqual(verdictFor(null, 10, cfg), 'insufficient_sample', 'null avg → insufficient');
  }

  // 13. buildAudit: sorts byReason most-costly-first; populates costliestGates.
  clearForTests();
  for (let i = 0; i < 12; i += 1) capture({ symbol: `SYM${i}/USD`, reason: 'near_recent_high', midPx: 100, signalVersion: 'ols', ts: new Date(NOW).toISOString() });
  for (let i = 0; i < 12; i += 1) capture({ symbol: `OTH${i}/USD`, reason: 'mr_no_drop', midPx: 100, signalVersion: 'mean_reversion', ts: new Date(NOW).toISOString() });
  {
    const fetchBars = async ({ symbols }) => {
      const sym = symbols[0];
      const c = sym.startsWith('SYM') ? 103 : 97;
      return { bars: { [sym]: makeBars(NOW, 30, () => c) } };
    };
    await gradePending({ fetchBars, nowMs: NOW + 25 * 60_000, forwardHorizonMs: 20 * 60_000, maxPerCycle: 100 });
    const audit = buildAudit({ nowMs: NOW + 25 * 60_000 });
    assert.strictEqual(audit.sampleSize, 24);
    assert.strictEqual(audit.byReason.length, 2);
    assert.strictEqual(audit.byReason[0].reason, 'near_recent_high', 'costly first');
    assert.strictEqual(audit.byReason[0].verdict, 'gate_costly');
    assert.strictEqual(audit.byReason[1].reason, 'mr_no_drop');
    assert.strictEqual(audit.byReason[1].verdict, 'gate_justified');
    assert.strictEqual(audit.costliestGates.length, 1);
    assert.strictEqual(audit.costliestGates[0].reason, 'near_recent_high');
  }

  // 14. buildAudit: per-(reason × signalVersion) slice.
  clearForTests();
  for (let i = 0; i < 11; i += 1) capture({ symbol: `A${i}/USD`, reason: 'near_recent_high', midPx: 100, signalVersion: 'ols', ts: new Date(NOW).toISOString() });
  for (let i = 0; i < 11; i += 1) capture({ symbol: `B${i}/USD`, reason: 'near_recent_high', midPx: 100, signalVersion: 'mean_reversion', ts: new Date(NOW).toISOString() });
  {
    const fetchBars = async ({ symbols }) => {
      const sym = symbols[0];
      const c = sym.startsWith('A') ? 105 : 95;
      return { bars: { [sym]: makeBars(NOW, 30, () => c) } };
    };
    await gradePending({ fetchBars, nowMs: NOW + 25 * 60_000, forwardHorizonMs: 20 * 60_000, maxPerCycle: 100 });
    const audit = buildAudit({ nowMs: NOW + 25 * 60_000 });
    const slices = audit.bySignalAndReason.filter((r) => r.reason === 'near_recent_high');
    assert.strictEqual(slices.length, 2, 'two signal slices for the same reason');
    const olsSlice = slices.find((s) => s.signalVersion === 'ols');
    const mrSlice = slices.find((s) => s.signalVersion === 'mean_reversion');
    assert.strictEqual(olsSlice.verdict, 'gate_costly');
    assert.strictEqual(mrSlice.verdict, 'gate_justified');
  }

  // 15. buildAudit: handles empty graded buffer.
  clearForTests();
  {
    const audit = buildAudit({ records: [], nowMs: NOW });
    assert.strictEqual(audit.sampleSize, 0);
    assert.deepStrictEqual(audit.byReason, []);
    assert.deepStrictEqual(audit.costliestGates, []);
    assert.deepStrictEqual(audit.bySymbolAndReason, []);
    assert.deepStrictEqual(audit.trendingReasons, []);
  }

  // 16. buildAudit: per-(reason × symbol) slice surfaces per-symbol asymmetry.
  //     2026-05-20 spread_too_wide hypothesis: aggregated noise verdict can
  //     hide a single symbol that's actually gate_costly. This test pins it.
  clearForTests();
  // 11 BCH spread_too_wide rejects + 11 BTC spread_too_wide rejects, but
  // BCH's forward bps is much more positive (gate is costly for BCH only).
  for (let i = 0; i < 11; i += 1) {
    capture({ symbol: 'BCH/USD', reason: 'spread_too_wide', midPx: 100, signalVersion: 'mean_reversion', ts: new Date(NOW).toISOString() });
  }
  for (let i = 0; i < 11; i += 1) {
    capture({ symbol: 'BTC/USD', reason: 'spread_too_wide', midPx: 100, signalVersion: 'mean_reversion', ts: new Date(NOW).toISOString() });
  }
  {
    const fetchBars = async ({ symbols }) => {
      const sym = symbols[0];
      // BCH forward = +50 bps (clearly costly); BTC forward = -5 bps (noise band).
      const c = sym === 'BCH/USD' ? 100.5 : 99.95;
      return { bars: { [sym]: makeBars(NOW, 30, () => c) } };
    };
    await gradePending({ fetchBars, nowMs: NOW + 25 * 60_000, forwardHorizonMs: 20 * 60_000, maxPerCycle: 100 });
    const audit = buildAudit({ nowMs: NOW + 25 * 60_000 });
    const bchSlice = audit.bySymbolAndReason.find((r) => r.reason === 'spread_too_wide' && r.symbol === 'BCH/USD');
    const btcSlice = audit.bySymbolAndReason.find((r) => r.reason === 'spread_too_wide' && r.symbol === 'BTC/USD');
    assert.ok(bchSlice, 'BCH slice present');
    assert.ok(btcSlice, 'BTC slice present');
    assert.strictEqual(bchSlice.verdict, 'gate_costly', 'BCH alone is gate_costly');
    assert.strictEqual(btcSlice.verdict, 'noise', 'BTC alone is noise');
    // Aggregate byReason hides the asymmetry — verdict averaged across.
    const agg = audit.byReason.find((r) => r.reason === 'spread_too_wide');
    assert.ok(agg.entries === 22, 'aggregate has both');
  }

  // 17. classifyTrend: flags trending_costly when newer half is moving
  //     toward the costly threshold and is close enough to it. This is the
  //     early-warning surface — spread_too_wide at 4.6 bps trending up
  //     should fire BEFORE it crosses +10.
  {
    const { classifyTrend, DEFAULT_CONFIG: CFG } = require('./gateRejectionAudit');
    const cfg = { ...CFG };
    // Build 80 records: 40 older at +2 bps avg, 40 newer at +6 bps avg.
    // Delta = +4 bps (above trendDeltaBps=1.5).
    // newerAvg = +6 bps, distance to costlyThresholdBps=10 is 4 (≤ trendNearBps=6).
    const records = [];
    for (let i = 0; i < 40; i += 1) {
      records.push({ capturedTsMs: NOW + i * 1000, forwardBps: 2 + (i % 2 === 0 ? 0.1 : -0.1) });
    }
    for (let i = 0; i < 40; i += 1) {
      records.push({ capturedTsMs: NOW + 1_000_000 + i * 1000, forwardBps: 6 + (i % 2 === 0 ? 0.1 : -0.1) });
    }
    const t = classifyTrend(records, cfg);
    assert.ok(t, 'classifier returns result');
    assert.strictEqual(t.trend, 'trending_costly');
    assert.ok(t.delta > 3 && t.delta < 5, `delta in range, got ${t.delta}`);
    assert.ok(t.distanceToCostlyBps > 3 && t.distanceToCostlyBps < 5, `distance computed, got ${t.distanceToCostlyBps}`);
  }

  // 18. classifyTrend: flags trending_justified when moving toward justified.
  {
    const { classifyTrend, DEFAULT_CONFIG: CFG } = require('./gateRejectionAudit');
    const cfg = { ...CFG };
    const records = [];
    for (let i = 0; i < 40; i += 1) records.push({ capturedTsMs: NOW + i, forwardBps: -2 });
    for (let i = 0; i < 40; i += 1) records.push({ capturedTsMs: NOW + 1_000_000 + i, forwardBps: -7 });
    const t = classifyTrend(records, cfg);
    assert.strictEqual(t.trend, 'trending_justified');
  }

  // 19. classifyTrend: returns null below sample size; returns 'stable'
  //     when delta is too small to be meaningful.
  {
    const { classifyTrend, DEFAULT_CONFIG: CFG } = require('./gateRejectionAudit');
    const cfg = { ...CFG };
    assert.strictEqual(classifyTrend([], cfg), null, 'empty input');
    assert.strictEqual(
      classifyTrend(Array.from({ length: 10 }, () => ({ capturedTsMs: NOW, forwardBps: 5 })), cfg),
      null,
      'below sample size',
    );
    const flat = Array.from({ length: 100 }, (_, i) => ({ capturedTsMs: NOW + i, forwardBps: 5 + (i % 2) * 0.2 }));
    const tFlat = classifyTrend(flat, cfg);
    assert.strictEqual(tFlat.trend, 'stable', 'small delta → stable');
  }

  // 20. classifyTrend: trending NOT fired when newer half is far from the
  //     threshold (avoid spurious flags on already-stable noise).
  {
    const { classifyTrend, DEFAULT_CONFIG: CFG } = require('./gateRejectionAudit');
    const cfg = { ...CFG };
    const records = [];
    // Older -30, newer -20: delta +10, but newer is +30 bps away from
    // costlyThresholdBps=10 (not within trendNearBps=6).
    for (let i = 0; i < 40; i += 1) records.push({ capturedTsMs: NOW + i, forwardBps: -30 });
    for (let i = 0; i < 40; i += 1) records.push({ capturedTsMs: NOW + 1_000_000 + i, forwardBps: -20 });
    const t = classifyTrend(records, cfg);
    assert.strictEqual(t.trend, 'stable', 'far from threshold → stable');
  }

  console.log('gateRejectionAudit.test ok', { tests: 20 });
})().catch((err) => {
  console.error('gateRejectionAudit.test failed', err);
  process.exit(1);
});
