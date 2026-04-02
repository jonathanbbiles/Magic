const assert = require('assert/strict');
const closedTradeStats = require('./closedTradeStats');

closedTradeStats.append({ symbol: 'BTC/USD', netPnlUsd: 10, grossPnlUsd: 12, holdSeconds: 60, entrySpreadBps: 5, entryQuoteAgeMs: 4000, exitReason: 'tp_maker' });
closedTradeStats.append({ symbol: 'ETH/USD', netPnlUsd: -4, grossPnlUsd: -3, holdSeconds: 120, entrySpreadBps: 7, entryQuoteAgeMs: 6000, exitReason: 'stop' });

const recents = closedTradeStats.getRecent(2);
assert.equal(recents.length >= 2, true);

const scorecard = closedTradeStats.buildScorecard(2);
assert.equal(scorecard.totalClosedTrades >= 2, true);
assert.equal(Number.isFinite(scorecard.avgNetPnlUsd), true);
assert.equal(Number.isFinite(scorecard.avgEntrySpreadBps), true);
