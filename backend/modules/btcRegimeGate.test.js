const assert = require('assert');
const {
  computeEfficiencyRatio,
  closesFromBars,
  evaluateBtcRegime,
  createBtcRegimeGate,
  DEFAULT_ER_WINDOW,
  DEFAULT_MIN_ER,
} = require('./btcRegimeGate');

// ---- computeEfficiencyRatio ------------------------------------------------

// A perfectly monotone ramp travels no wasted path: ER == 1.
{
  const ramp = Array.from({ length: 31 }, (_, i) => 100 + i);
  assert.equal(computeEfficiencyRatio(ramp, 30), 1);
}

// A pure zig-zag returns to where it started: net move 0 => ER == 0.
{
  const zig = Array.from({ length: 31 }, (_, i) => (i % 2 === 0 ? 100 : 101));
  assert.equal(computeEfficiencyRatio(zig, 30), 0);
}

// Direction-symmetric: a monotone DOWN ramp is just as "efficient" as an up one.
// (The gate measures trendiness, not direction — the entry signal owns direction.)
{
  const down = Array.from({ length: 31 }, (_, i) => 200 - i);
  assert.equal(computeEfficiencyRatio(down, 30), 1);
}

// Partial efficiency: +10 net over a 30-step path of 30 => 1/3.
{
  const closes = [100];
  for (let i = 0; i < 20; i += 1) closes.push(closes[closes.length - 1] + 1); // +20
  for (let i = 0; i < 10; i += 1) closes.push(closes[closes.length - 1] - 1); // -10
  const er = computeEfficiencyRatio(closes, 30);
  assert.ok(Math.abs(er - (10 / 30)) < 1e-9, `expected 1/3, got ${er}`);
}

// Too few closes => null (NOT 0). "Unknown" must be distinguishable from "chop".
assert.equal(computeEfficiencyRatio([1, 2, 3], 30), null);
assert.equal(computeEfficiencyRatio(null, 30), null);
assert.equal(computeEfficiencyRatio([], 30), null);
// Exactly window+1 closes is the minimum that forms the window.
assert.notEqual(computeEfficiencyRatio(Array.from({ length: 31 }, (_, i) => 100 + i), 30), null);
assert.equal(computeEfficiencyRatio(Array.from({ length: 30 }, (_, i) => 100 + i), 30), null);

// Non-finite / non-positive closes are dropped, not allowed to poison the math.
{
  const mixed = [NaN, 0, -5, ...Array.from({ length: 31 }, (_, i) => 100 + i)];
  assert.equal(computeEfficiencyRatio(mixed, 30), 1);
}

// ---- closesFromBars --------------------------------------------------------

// The newest bar is still forming on a live feed, so it is dropped by default —
// the gate must read only CLOSED bars or it would disagree with the signal.
{
  const bars = [{ c: 1 }, { c: 2 }, { c: 3 }];
  assert.deepEqual(closesFromBars(bars), [1, 2]);
  assert.deepEqual(closesFromBars(bars, { dropInProgressBar: false }), [1, 2, 3]);
  assert.deepEqual(closesFromBars([{ close: 7 }, { close: 8 }]), [7]);
  assert.deepEqual(closesFromBars(null), []);
}

// ---- evaluateBtcRegime -----------------------------------------------------

// Trending market clears the gate.
{
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const d = evaluateBtcRegime({ closes, erWindow: 30, minEfficiencyRatio: 0.30 });
  assert.equal(d.suppress, false);
  assert.equal(d.reason, 'ok');
  assert.equal(d.efficiencyRatio, 1);
}

// Choppy market suppresses.
{
  const closes = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101));
  const d = evaluateBtcRegime({ closes, erWindow: 30, minEfficiencyRatio: 0.30 });
  assert.equal(d.suppress, true);
  assert.equal(d.reason, 'chop_regime');
  assert.equal(d.efficiencyRatio, 0);
}

// FAIL-OPEN: unknown regime NEVER suppresses. A data outage must not silently
// halt the bot — this is the single most important property of this module.
{
  for (const input of [{ closes: [] }, { closes: null }, { bars: null }, { bars: [] }, { closes: [1, 2] }]) {
    const d = evaluateBtcRegime({ ...input, erWindow: 30, minEfficiencyRatio: 0.30 });
    assert.equal(d.suppress, false, `unknown regime must not suppress: ${JSON.stringify(input)}`);
    assert.equal(d.reason, 'insufficient_bars');
    assert.equal(d.efficiencyRatio, null);
  }
}

// Threshold boundary: ER exactly at the floor PASSES (gate is `er < min`).
{
  const closes = [100];
  for (let i = 0; i < 20; i += 1) closes.push(closes[closes.length - 1] + 1);
  for (let i = 0; i < 10; i += 1) closes.push(closes[closes.length - 1] - 1);
  const er = 10 / 30;
  assert.equal(evaluateBtcRegime({ closes, erWindow: 30, minEfficiencyRatio: er }).suppress, false);
  assert.equal(evaluateBtcRegime({ closes, erWindow: 30, minEfficiencyRatio: er + 0.01 }).suppress, true);
}

// A gate at min=0 can never suppress (ER >= 0 always) — the documented
// "effectively disabled" setting behaves as advertised.
{
  const closes = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101));
  assert.equal(evaluateBtcRegime({ closes, erWindow: 30, minEfficiencyRatio: 0 }).suppress, false);
}

// Bars path works end-to-end (and honors the in-progress-bar drop).
{
  const bars = Array.from({ length: 40 }, (_, i) => ({ c: 100 + i }));
  const d = evaluateBtcRegime({ bars, erWindow: 30, minEfficiencyRatio: 0.30 });
  assert.equal(d.suppress, false);
  assert.equal(d.barsAvailable, 39); // 40 bars minus the still-forming one
}

// Defaults are the validated config.
assert.equal(DEFAULT_ER_WINDOW, 30);
assert.equal(DEFAULT_MIN_ER, 0.30);

// ---- createBtcRegimeGate (tracker) ----------------------------------------

{
  const gate = createBtcRegimeGate({ historySize: 5 });
  const s0 = gate.summary();
  assert.equal(s0.evaluations, 0);
  assert.equal(s0.currentRegime, 'unknown');
  assert.equal(s0.suppressionRate, null);

  const trending = { suppress: false, reason: 'ok', efficiencyRatio: 0.8, erWindow: 30, minEfficiencyRatio: 0.3 };
  const chop = { suppress: true, reason: 'chop_regime', efficiencyRatio: 0.1, erWindow: 30, minEfficiencyRatio: 0.3 };

  gate.record(trending, 1000);
  gate.record(chop, 2000);
  gate.record(chop, 3000);
  const s = gate.summary({ nowMs: 4000 });
  assert.equal(s.evaluations, 3);
  assert.equal(s.suppressions, 2);
  assert.equal(s.suppressionRate, 0.667);
  assert.equal(s.currentRegime, 'chop');
  assert.equal(s.efficiencyRatio, 0.1);
  // The chop run started at 2000, not 3000 — regimeHeldMs measures the run.
  assert.equal(s.regimeHeldMs, 2000);

  // Flipping back to trending restarts the clock.
  gate.record(trending, 5000);
  assert.equal(gate.summary({ nowMs: 6000 }).currentRegime, 'trending');
  assert.equal(gate.summary({ nowMs: 6000 }).regimeHeldMs, 1000);

  // An unknown reading counts as an evaluation but leaves the regime 'unknown'
  // and never adds to suppressions.
  gate.record({ suppress: false, reason: 'insufficient_bars', efficiencyRatio: null }, 7000);
  const su = gate.summary({ nowMs: 7000 });
  assert.equal(su.currentRegime, 'unknown');
  assert.equal(su.suppressions, 2);

  // History is capped.
  for (let i = 0; i < 20; i += 1) gate.record(trending, 8000 + i);
  assert.equal(gate.summary().observations, 5);

  gate.reset();
  assert.equal(gate.summary().evaluations, 0);
  // Malformed input never throws.
  gate.record(null);
  gate.record(undefined);
  assert.equal(gate.summary().evaluations, 0);
}

console.log('btcRegimeGate tests passed');
