const assert = require('assert');
const {
  createMakerFillTracker,
  record: singletonRecord,
  buildSummary: singletonSummary,
  reset: singletonReset,
  OUTCOMES,
} = require('./makerFillTracker');

function run() {
  // Empty window: every funnel field is zero / null, no throw.
  {
    const t = createMakerFillTracker();
    const s = t.buildSummary();
    assert.strictEqual(s.windowSize, 0);
    assert.strictEqual(s.submitted, 0);
    assert.strictEqual(s.filled, 0);
    assert.strictEqual(s.fillRate, null);
    assert.strictEqual(s.restRate, null);
    assert.strictEqual(s.pending, 0);
  }

  // Unknown / malformed outcomes are ignored (no throw, no count).
  {
    const t = createMakerFillTracker();
    t.record(null);
    t.record(undefined);
    t.record({});
    t.record({ outcome: 'bogus' });
    t.record('nope');
    assert.strictEqual(t.buildSummary().windowSize, 0);
  }

  // Funnel math: 3 submitted, 2 filled, 1 unfilled -> fillRate 2/3, all rested.
  {
    const t = createMakerFillTracker();
    t.record({ outcome: 'submitted', postOnly: true });
    t.record({ outcome: 'submitted', postOnly: true });
    t.record({ outcome: 'submitted', postOnly: true });
    t.record({ outcome: 'filled', postOnly: true });
    t.record({ outcome: 'filled', postOnly: true });
    t.record({ outcome: 'unfilled_cancelled', postOnly: true });
    const s = t.buildSummary();
    assert.strictEqual(s.submitted, 3);
    assert.strictEqual(s.filled, 2);
    assert.strictEqual(s.unfilledCancelled, 1);
    assert.ok(Math.abs(s.fillRate - 2 / 3) < 1e-9, `fillRate ${s.fillRate}`);
    assert.strictEqual(s.restRate, 1); // no rejects -> all attempts rested
    assert.strictEqual(s.pending, 0);
  }

  // Rejected-post-only counts as an attempt that did NOT rest: restRate < 1,
  // and rejects never inflate fillRate.
  {
    const t = createMakerFillTracker();
    t.record({ outcome: 'submitted', postOnly: true });
    t.record({ outcome: 'filled', postOnly: true });
    t.record({ outcome: 'rejected_post_only', postOnly: true });
    const s = t.buildSummary();
    assert.strictEqual(s.submitted, 1);
    assert.strictEqual(s.rejectedPostOnly, 1);
    assert.strictEqual(s.fillRate, 1); // 1 filled / 1 resolved
    assert.ok(Math.abs(s.restRate - 0.5) < 1e-9, `restRate ${s.restRate}`); // 1 rested / 2 attempts
    assert.strictEqual(s.postOnlyAttempts, 2); // submitted + rejected
  }

  // Pending: submitted but not yet resolved.
  {
    const t = createMakerFillTracker();
    t.record({ outcome: 'submitted', postOnly: true });
    t.record({ outcome: 'submitted', postOnly: true });
    t.record({ outcome: 'filled', postOnly: true });
    const s = t.buildSummary();
    assert.strictEqual(s.pending, 1); // 2 submitted - 1 resolved
  }

  // fillRate is eviction-robust: even if the matching 'submitted' is pushed
  // out of a tiny window, fillRate (filled/resolved) never exceeds 1.
  {
    const t = createMakerFillTracker({ windowSize: 2 });
    t.record({ outcome: 'submitted' });
    t.record({ outcome: 'filled' });
    t.record({ outcome: 'filled' }); // evicts the original 'submitted'
    const s = t.buildSummary();
    assert.strictEqual(s.windowSize, 2);
    assert.ok(s.fillRate <= 1, `fillRate ${s.fillRate} must be <= 1`);
  }

  // FIFO bound is enforced.
  {
    const t = createMakerFillTracker({ windowSize: 5 });
    for (let i = 0; i < 50; i += 1) t.record({ outcome: 'submitted' });
    assert.strictEqual(t.buildSummary().windowSize, 5);
  }

  // Singleton delegates share one window; reset clears it.
  {
    singletonReset();
    singletonRecord({ outcome: 'submitted', postOnly: true });
    singletonRecord({ outcome: 'filled', postOnly: true });
    assert.strictEqual(singletonSummary().filled, 1);
    singletonReset();
    assert.strictEqual(singletonSummary().windowSize, 0);
  }

  // OUTCOMES vocabulary is the documented set.
  assert.deepStrictEqual(
    OUTCOMES.slice().sort(),
    ['filled', 'rejected_post_only', 'submitted', 'unfilled_cancelled'],
  );

  console.log('makerFillTracker.test.js: all assertions passed');
}

run();
