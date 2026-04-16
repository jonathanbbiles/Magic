const assert = require('assert/strict');
const { resolveUniverseCap } = require('./universeCap');

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

console.log('universe cap tests passed');
