const assert = require('assert/strict');
const { createSymbolHealthTracker } = require('./symbolHealth');

(() => {
  let nowMs = 1_700_000_000_000;
  const tracker = createSymbolHealthTracker({
    now: () => nowMs,
    reasonPolicies: {
      stale_quote_primary: { threshold: 2, cooldownMs: 60000 },
      ob_depth_insufficient: { threshold: 2, cooldownMs: 45000 },
      predictor_warmup: { threshold: 3, cooldownMs: 30000 },
      marketdata_unavailable: { threshold: 2, cooldownMs: 30000 },
      sparse_fallback_rejected: { threshold: 2, cooldownMs: 30000 },
    },
  });

  tracker.recordFailure('BTC/USD', 'stale_quote_primary', { quoteAgeMs: 88000 });
  assert.equal(tracker.evaluateEligibility('BTC/USD').eligible, true);
  tracker.recordFailure('BTC/USD', 'stale_quote_primary', { quoteAgeMs: 94000 });
  const staleBlocked = tracker.evaluateEligibility('BTC/USD');
  assert.equal(staleBlocked.eligible, false);
  assert.equal(staleBlocked.reason, 'symbol_health_cooldown');
  assert.equal(staleBlocked.cooldown.reason, 'stale_quote_primary');
  assert.equal(staleBlocked.cooldown.quoteAgeMs, 94000);

  tracker.recordFailure('ETH/USD', 'ob_depth_insufficient');
  tracker.recordFailure('ETH/USD', 'ob_depth_insufficient');
  const depthBlocked = tracker.evaluateEligibility('ETH/USD');
  assert.equal(depthBlocked.eligible, false);
  assert.equal(depthBlocked.cooldown.reason, 'ob_depth_insufficient');

  tracker.recordFailure('SOL/USD', 'predictor_warmup');
  tracker.recordFailure('SOL/USD', 'predictor_warmup');
  assert.equal(tracker.evaluateEligibility('SOL/USD').eligible, true);
  tracker.recordFailure('SOL/USD', 'predictor_warmup');
  const warmupBlocked = tracker.evaluateEligibility('SOL/USD');
  assert.equal(warmupBlocked.eligible, false);
  assert.equal(warmupBlocked.cooldown.reason, 'predictor_warmup');

  nowMs += 60001;
  const staleRecovered = tracker.evaluateEligibility('BTC/USD');
  assert.equal(staleRecovered.eligible, true);
  tracker.recordFailure('BTC/USD', 'stale_quote_primary', { quoteAgeMs: 99000 });
  tracker.recordFailure('BTC/USD', 'stale_quote_primary', { quoteAgeMs: 101000 });
  assert.equal(tracker.evaluateEligibility('BTC/USD').eligible, false);
  tracker.noteHealthy('BTC/USD');
  assert.equal(tracker.evaluateEligibility('BTC/USD').eligible, true);

  tracker.noteHealthy('ETH/USD');
  assert.equal(tracker.evaluateEligibility('ETH/USD').eligible, true);

  console.log('symbol health tests passed');
})();
