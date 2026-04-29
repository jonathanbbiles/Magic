const assert = require('node:assert/strict');
const { addUsdMicro } = require('./exactMath');

const start = 1_000_000_000.01;
const increments = Array.from({ length: 200000 }, () => 0.000001);
const expected = start + (increments.length * 0.000001);

let floatAcc = start;
for (const inc of increments) floatAcc += inc;
const exactAcc = addUsdMicro(start, increments);

assert.notEqual(floatAcc, expected);
assert.equal(exactAcc, expected);
console.log('exactMath catastrophic cancellation tests passed');
