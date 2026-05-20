const assert = require('assert');
const {
  createShadow,
  median,
  DEFAULT_FRESH_THRESHOLD_MS,
} = require('./secondaryFeedShadow');

// 1. median helper edge cases.
{
  assert.strictEqual(median([]), null);
  assert.strictEqual(median([5]), 5);
  assert.strictEqual(median([1, 2, 3]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  // Doesn't mutate input
  const input = [3, 1, 2];
  median(input);
  assert.deepStrictEqual(input, [3, 1, 2]);
}

// 2. observe() accepts Alpaca-shaped quotes (bp/ap, t/timestamp).
{
  const shadow = createShadow();
  const now = 1700000000000;
  shadow.observe({
    symbol: 'BTC/USD',
    alpacaQuote: { bp: 50000, ap: 50010, t: now - 5000 },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: now - 1000 },
    nowMs: now,
  });
  const raw = shadow.getRawObservations('BTC/USD');
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].alpacaAgeMs, 5000);
  assert.strictEqual(raw[0].coinbaseAgeMs, 1000);
  assert.strictEqual(raw[0].alpacaMid, 50005);
  assert.strictEqual(raw[0].coinbaseMid, 50010);
  // divergence = (50005 - 50010) / 50010 * 10000 ≈ -0.9998 bps
  assert.ok(raw[0].divergenceBps < -0.999 && raw[0].divergenceBps > -1.001);
}

// 3. observe() with both Alpaca and Coinbase shapes (bidPx/askPx + ts numeric).
{
  const shadow = createShadow();
  const now = 1700000000000;
  shadow.observe({
    symbol: 'ETH/USD',
    alpacaQuote: { bidPx: 3000, askPx: 3001, ts: now - 200 },
    coinbaseQuote: { bidPx: 3000.5, askPx: 3001.5, ts: now - 100 },
    nowMs: now,
  });
  const raw = shadow.getRawObservations('ETH/USD');
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].alpacaAgeMs, 200);
  assert.strictEqual(raw[0].coinbaseAgeMs, 100);
}

// 4. observe() with ISO string timestamp on Alpaca quote.
{
  const shadow = createShadow();
  const now = Date.parse('2026-05-20T12:00:00.000Z');
  shadow.observe({
    symbol: 'SOL/USD',
    alpacaQuote: { bp: 100, ap: 101, t: '2026-05-20T11:59:55.000Z' },
    coinbaseQuote: { bidPx: 100, askPx: 101, ts: now - 1000 },
    nowMs: now,
  });
  const raw = shadow.getRawObservations('SOL/USD');
  assert.strictEqual(raw[0].alpacaAgeMs, 5000);
}

// 5. observe() handles missing Coinbase (the "wasn't received yet" case).
{
  const shadow = createShadow();
  const now = 1700000000000;
  shadow.observe({
    symbol: 'AVAX/USD',
    alpacaQuote: { bp: 20, ap: 20.1, t: now - 1000 },
    coinbaseQuote: null,
    nowMs: now,
  });
  const raw = shadow.getRawObservations('AVAX/USD');
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].alpacaMid, 20.05);
  assert.strictEqual(raw[0].coinbaseMid, null);
  assert.strictEqual(raw[0].divergenceBps, null);
  assert.strictEqual(raw[0].coinbaseAgeMs, null);
}

// 6. observe() handles missing Alpaca (e.g. prefetch failed for this symbol).
{
  const shadow = createShadow();
  const now = 1700000000000;
  shadow.observe({
    symbol: 'LINK/USD',
    alpacaQuote: null,
    coinbaseQuote: { bidPx: 15, askPx: 15.05, ts: now - 500 },
    nowMs: now,
  });
  const raw = shadow.getRawObservations('LINK/USD');
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].alpacaMid, null);
  assert.strictEqual(raw[0].coinbaseMid, 15.025);
  assert.strictEqual(raw[0].divergenceBps, null);
}

// 7. observe() bails on invalid symbol or zero/negative prices.
{
  const shadow = createShadow();
  shadow.observe({ symbol: '', alpacaQuote: { bp: 1, ap: 2, t: 0 } });
  shadow.observe({ symbol: 'BTC/USD', alpacaQuote: { bp: 0, ap: 100, t: 0 } });
  // Empty symbol short-circuits before storing; invalid bp/ap means normalize returns null
  assert.strictEqual(shadow.getRawObservations('').length, 0);
  // BTC/USD: alpaca normalize returns null, but observe still records (alpaca=null)
  // — that's a valid "Alpaca unavailable" observation, not a parse error.
  const btc = shadow.getRawObservations('BTC/USD');
  assert.strictEqual(btc.length, 1);
  assert.strictEqual(btc[0].alpacaMid, null);
}

// 8. History buffer is capped per-symbol.
{
  const shadow = createShadow({ historyPerSymbol: 3 });
  const now = 1700000000000;
  for (let i = 0; i < 5; i++) {
    shadow.observe({
      symbol: 'BTC/USD',
      alpacaQuote: { bp: 60000 + i, ap: 60010 + i, t: now - 100 },
      coinbaseQuote: { bidPx: 60005 + i, askPx: 60015 + i, ts: now - 50 },
      nowMs: now + i * 1000,
    });
  }
  const raw = shadow.getRawObservations('BTC/USD');
  assert.strictEqual(raw.length, 3, 'history should be capped at 3');
  // Last 3 entries (indexes 2, 3, 4) preserved. mid for i=2 = (60002+60012)/2 = 60007.
  assert.strictEqual(raw[0].alpacaMid, 60007);
  assert.strictEqual(raw[2].alpacaMid, 60009);
}

// 9. buildSummary categorizes the latest observation per symbol correctly.
{
  const shadow = createShadow();
  const now = 1700000000000;
  // BTC: both fresh
  shadow.observe({
    symbol: 'BTC/USD',
    alpacaQuote: { bp: 50000, ap: 50010, t: now - 5000 },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: now - 2000 },
    nowMs: now,
  });
  // ETH: Alpaca stale, Coinbase fresh — THE headline case
  shadow.observe({
    symbol: 'ETH/USD',
    alpacaQuote: { bp: 3000, ap: 3001, t: now - 90000 },
    coinbaseQuote: { bidPx: 3000.5, askPx: 3001.5, ts: now - 1000 },
    nowMs: now,
  });
  // SOL: both stale
  shadow.observe({
    symbol: 'SOL/USD',
    alpacaQuote: { bp: 100, ap: 101, t: now - 90000 },
    coinbaseQuote: { bidPx: 100, askPx: 101, ts: now - 90000 },
    nowMs: now,
  });
  // AVAX: Coinbase unavailable
  shadow.observe({
    symbol: 'AVAX/USD',
    alpacaQuote: { bp: 20, ap: 20.1, t: now - 1000 },
    coinbaseQuote: null,
    nowMs: now,
  });

  const summary = shadow.buildSummary({ nowMs: now, freshThresholdMs: 30000 });
  assert.strictEqual(summary.overall.symbolsObserved, 4);
  assert.strictEqual(summary.overall.symbolsWhereBothFresh, 1, 'BTC');
  assert.strictEqual(summary.overall.symbolsWhereAlpacaStaleCoinbaseFresh, 1, 'ETH — headline metric');
  assert.strictEqual(summary.overall.symbolsWhereBothStale, 1, 'SOL');
  assert.strictEqual(summary.overall.symbolsWhereCoinbaseUnavailable, 1, 'AVAX');
  assert.strictEqual(summary.overall.totalObservations, 4);
  assert.ok(summary.bySymbol.length === 4);
}

// 10. Empty state yields empty summary, not a crash.
{
  const shadow = createShadow();
  const summary = shadow.buildSummary();
  assert.strictEqual(summary.overall.symbolsObserved, 0);
  assert.strictEqual(summary.overall.totalObservations, 0);
  assert.strictEqual(summary.overall.medianDivergenceBps, null);
  assert.deepStrictEqual(summary.bySymbol, []);
}

// 11. buildSymbolSummary computes freshness percentages correctly.
{
  const shadow = createShadow();
  const now = 1700000000000;
  // 4 observations on BTC/USD: 3 fresh + 1 stale Alpaca
  for (let i = 0; i < 3; i++) {
    shadow.observe({
      symbol: 'BTC/USD',
      alpacaQuote: { bp: 50000, ap: 50010, t: now - 5000 },
      coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: now - 2000 },
      nowMs: now,
    });
  }
  shadow.observe({
    symbol: 'BTC/USD',
    alpacaQuote: { bp: 50000, ap: 50010, t: now - 90000 },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: now - 2000 },
    nowMs: now,
  });
  const summary = shadow.buildSummary({ nowMs: now });
  const btc = summary.bySymbol.find((s) => s.symbol === 'BTC/USD');
  assert.strictEqual(btc.sampleSize, 4);
  assert.strictEqual(btc.alpacaFreshPct, 0.75);
  assert.strictEqual(btc.coinbaseFreshPct, 1);
  assert.strictEqual(btc.latestStatus, 'alpaca_stale_coinbase_fresh');
}

// 12. Default thresholds exposed for callers.
assert.strictEqual(DEFAULT_FRESH_THRESHOLD_MS, 30000);

console.log('secondaryFeedShadow.test ok', { tests: 12 });
