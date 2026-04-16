const assert = require('assert/strict');
const { resolveUniverseCap, normalizeConfiguredCap } = require('./universeCap');

{
  const cap = resolveUniverseCap({ configuredCap: null, configuredCapSource: 'uncapped', ratePressureActive: false, prioritizedCount: 10 });
  assert.equal(cap.configuredCap, null);
  assert.equal(cap.configuredCapSource, 'uncapped');
  assert.equal(cap.effectiveCap, null);
  assert.equal(cap.effectiveCapSource, 'uncapped');
}

{
  const cap = resolveUniverseCap({ configuredCap: 12, configuredCapSource: 'env', ratePressureActive: false, prioritizedCount: 10 });
  assert.equal(cap.configuredCap, 12);
  assert.equal(cap.effectiveCap, 12);
  assert.equal(cap.effectiveCapSource, 'env');
}

assert.equal(normalizeConfiguredCap(null), null);
assert.equal(normalizeConfiguredCap(undefined), null);
assert.equal(normalizeConfiguredCap(''), null);
assert.equal(normalizeConfiguredCap('   '), null);
assert.equal(normalizeConfiguredCap('not_a_number'), null);
assert.equal(normalizeConfiguredCap(7.8), 7);

console.log('universe cap tests passed');
