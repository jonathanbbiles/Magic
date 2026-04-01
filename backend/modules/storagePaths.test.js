const assert = require('assert/strict');
const fs = require('fs');

const recorderPath = require.resolve('./recorder');

const originalAppend = fs.appendFileSync;
const originalWarn = console.warn;

let warnCount = 0;
console.warn = (event) => {
  if (event === 'predictor_record_append_failed') warnCount += 1;
};

fs.appendFileSync = () => { throw new Error('EACCES'); };

delete require.cache[recorderPath];
const recorder = require('./recorder');
recorder.appendRecord({ symbol: 'BTC/USD', ts: new Date().toISOString() });
recorder.appendRecord({ symbol: 'ETH/USD', ts: new Date().toISOString() });

fs.appendFileSync = originalAppend;
console.warn = originalWarn;

assert.equal(warnCount, 1);
console.log('storage paths tests passed');
