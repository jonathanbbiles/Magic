const assert = require('assert/strict');
const {
  parseSymbolBlocklist,
  blocklistAsSet,
  isPairBlocked,
  readMrBlocklistsFromEnv,
  isMrPairBlocked,
  readMicroBlocklistsFromEnv,
  isMicroPairBlocked,
} = require('./symbolBlocklist');

// 1. Empty string, null, undefined all → [].
{
  assert.deepEqual(parseSymbolBlocklist(''), []);
  assert.deepEqual(parseSymbolBlocklist('   '), []);
  assert.deepEqual(parseSymbolBlocklist(null), []);
  assert.deepEqual(parseSymbolBlocklist(undefined), []);
}

// 2. Single symbol parses to one-element array, preserving original case.
{
  assert.deepEqual(parseSymbolBlocklist('BCH/USD'), ['BCH/USD']);
  assert.deepEqual(parseSymbolBlocklist('bch/usd'), ['bch/usd']);
}

// 3. Comma-separated list trims whitespace and drops empties.
{
  assert.deepEqual(
    parseSymbolBlocklist('BCH/USD, ETH/USD ,,LTC/USD'),
    ['BCH/USD', 'ETH/USD', 'LTC/USD'],
  );
}

// 4. blocklistAsSet uppercases for case-insensitive matching.
{
  const s = blocklistAsSet('bch/usd, ETH/usd');
  assert.ok(s instanceof Set);
  assert.ok(s.has('BCH/USD'));
  assert.ok(s.has('ETH/USD'));
  assert.equal(s.size, 2);
}

// 5. isPairBlocked: empty set always returns false.
{
  assert.equal(isPairBlocked('BCH/USD', new Set()), false);
  assert.equal(isPairBlocked('BCH/USD', null), false);
  assert.equal(isPairBlocked('BCH/USD', undefined), false);
}

// 6. isPairBlocked: case-insensitive lookup.
{
  const s = new Set(['BCH/USD']);
  assert.equal(isPairBlocked('BCH/USD', s), true);
  assert.equal(isPairBlocked('bch/usd', s), true);
  assert.equal(isPairBlocked('Bch/Usd', s), true);
  assert.equal(isPairBlocked('ETH/USD', s), false);
}

// 7. isPairBlocked tolerates null / undefined pair input without throwing.
{
  const s = new Set(['BCH/USD']);
  assert.equal(isPairBlocked(null, s), false);
  assert.equal(isPairBlocked(undefined, s), false);
  assert.equal(isPairBlocked('', s), false);
}

// 8. readMrBlocklistsFromEnv: reads all four MR slots from the env object.
{
  const env = {
    MR_SYMBOL_BLOCKLIST_1M: 'BCH/USD',
    MR_SYMBOL_BLOCKLIST_5M: 'BCH/USD, LTC/USD',
    MR_SYMBOL_BLOCKLIST_15M: '',
    RANGE_MR_SYMBOL_BLOCKLIST: 'XRP/USD',
  };
  const b = readMrBlocklistsFromEnv(env);
  assert.equal(b.mr1m.size, 1);
  assert.ok(b.mr1m.has('BCH/USD'));
  assert.equal(b.mr5m.size, 2);
  assert.ok(b.mr5m.has('BCH/USD'));
  assert.ok(b.mr5m.has('LTC/USD'));
  assert.equal(b.mr15m.size, 0, 'empty env value → empty set (BCH allowed on 15m)');
  assert.equal(b.rangeMr.size, 1);
  assert.ok(b.rangeMr.has('XRP/USD'));
}

// 9. readMrBlocklistsFromEnv: unset env values → empty sets (no filter).
{
  const b = readMrBlocklistsFromEnv({});
  assert.equal(b.mr1m.size, 0);
  assert.equal(b.mr5m.size, 0);
  assert.equal(b.mr15m.size, 0);
  assert.equal(b.rangeMr.size, 0);
}

// 10. isMrPairBlocked dispatches by timeframe — critical because BCH is
//     blocked on 1m+5m but ALLOWED on 15m (where it's actually one of the
//     best MR symbols per the 2026-05-18 backtest).
{
  const b = readMrBlocklistsFromEnv({
    MR_SYMBOL_BLOCKLIST_1M: 'BCH/USD',
    MR_SYMBOL_BLOCKLIST_5M: 'BCH/USD',
    MR_SYMBOL_BLOCKLIST_15M: '',
  });
  assert.equal(isMrPairBlocked('BCH/USD', '1m', b), true);
  assert.equal(isMrPairBlocked('BCH/USD', '5m', b), true);
  assert.equal(isMrPairBlocked('BCH/USD', '15m', b), false,
    'BCH MUST remain tradable on MR-15m');
  assert.equal(isMrPairBlocked('BTC/USD', '1m', b), false);
  assert.equal(isMrPairBlocked('BTC/USD', '5m', b), false);
  assert.equal(isMrPairBlocked('BTC/USD', '15m', b), false);
}

// 11. isMrPairBlocked: missing / unknown timeframe defaults to 1m. The live
//     getter passes '1m' explicitly today, but if a caller forgets to pass
//     a timeframe the safe default is the strictest filter (1m).
{
  const b = readMrBlocklistsFromEnv({
    MR_SYMBOL_BLOCKLIST_1M: 'BCH/USD',
  });
  assert.equal(isMrPairBlocked('BCH/USD', undefined, b), true);
  assert.equal(isMrPairBlocked('BCH/USD', null, b), true);
  assert.equal(isMrPairBlocked('BCH/USD', 'unknown', b), true);
}

// 12. isMrPairBlocked: null blocklists object returns false (degrades safely).
{
  assert.equal(isMrPairBlocked('BCH/USD', '1m', null), false);
  assert.equal(isMrPairBlocked('BCH/USD', '1m', undefined), false);
}

// 13. readMicroBlocklistsFromEnv: reads all four micro horizons.
{
  const env = {
    MICRO_SYMBOL_BLOCKLIST_30M: 'UNI/USD,DOT/USD,LTC/USD,BCH/USD,LINK/USD',
    MICRO_SYMBOL_BLOCKLIST_15M: 'SOL/USD',
  };
  const b = readMicroBlocklistsFromEnv(env);
  assert.equal(b.micro5m.size, 0);
  assert.equal(b.micro15m.size, 1);
  assert.ok(b.micro15m.has('SOL/USD'));
  assert.equal(b.micro30m.size, 5);
  assert.ok(b.micro30m.has('UNI/USD'));
  assert.ok(b.micro30m.has('DOT/USD'));
  assert.ok(b.micro30m.has('LTC/USD'));
  assert.ok(b.micro30m.has('BCH/USD'));
  assert.ok(b.micro30m.has('LINK/USD'));
  assert.equal(b.micro45m.size, 0);
}

// 14. isMicroPairBlocked dispatches by horizon — critical because the
//     2026-05-19 diagnostic showed different per-symbol losers at each
//     horizon; a 30m blocklist should NOT silently apply to 15m.
{
  const b = readMicroBlocklistsFromEnv({
    MICRO_SYMBOL_BLOCKLIST_30M: 'UNI/USD,DOT/USD',
    MICRO_SYMBOL_BLOCKLIST_15M: 'SOL/USD',
  });
  assert.equal(isMicroPairBlocked('UNI/USD', 30, b), true);
  assert.equal(isMicroPairBlocked('DOT/USD', 30, b), true);
  assert.equal(isMicroPairBlocked('UNI/USD', 15, b), false, '15m blocklist does not include UNI');
  assert.equal(isMicroPairBlocked('SOL/USD', 15, b), true);
  assert.equal(isMicroPairBlocked('SOL/USD', 30, b), false);
  assert.equal(isMicroPairBlocked('BTC/USD', 30, b), false);
}

// 15. isMicroPairBlocked: unknown horizon → false (degrades safely).
{
  const b = readMicroBlocklistsFromEnv({
    MICRO_SYMBOL_BLOCKLIST_30M: 'UNI/USD',
  });
  assert.equal(isMicroPairBlocked('UNI/USD', 99, b), false);
  assert.equal(isMicroPairBlocked('UNI/USD', null, b), false);
  assert.equal(isMicroPairBlocked('UNI/USD', undefined, b), false);
}

// 16. isMicroPairBlocked: null blocklists → false (defensive).
{
  assert.equal(isMicroPairBlocked('UNI/USD', 30, null), false);
  assert.equal(isMicroPairBlocked('UNI/USD', 30, undefined), false);
}

console.log('symbolBlocklist.test.js passed');
