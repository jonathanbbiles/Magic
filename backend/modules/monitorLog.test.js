const assert = require('assert/strict');
const monitorLog = require('./monitorLog');

// buildHeartbeat is pure — no I/O. Test the flag logic + shape directly.

// 1. All-clear: healthy equity, no veto transition, no exec failure → no flags.
{
  const hb = monitorLog.buildHeartbeat({
    ts: 1000, equity: 480, openPositions: 3,
    veto: false, prevVeto: false,
    realizedAvgNetBps: 4.2, sampleSize: 13, signalVersion: 'mean_reversion',
  });
  assert.equal(hb.type, 'monitor_heartbeat');
  assert.equal(hb.equity, 480);
  assert.equal(hb.openPositions, 3);
  assert.deepEqual(hb.flags, [], 'healthy heartbeat must carry no flags');
}

// 2. Veto steady-state (was already vetoing) → benign, NO VETO_NEW flag.
{
  const hb = monitorLog.buildHeartbeat({
    ts: 2000, equity: 479, openPositions: 0,
    veto: true, prevVeto: true, vetoReason: 'realized_below_floor',
    realizedAvgNetBps: -27.7, sampleSize: 10,
  });
  assert.equal(hb.veto, true);
  assert.ok(!hb.flags.includes('VETO_NEW'), 'steady veto must NOT raise VETO_NEW');
  assert.deepEqual(hb.flags, [], 'steady veto is benign');
}

// 3. Veto transition false→true FROM AN EVALUATED state → raises VETO_NEW.
{
  const hb = monitorLog.buildHeartbeat({
    ts: 3000, equity: 479, openPositions: 0,
    veto: true, prevVeto: false, prevEvaluated: true, sampleSize: 10,
    vetoReason: 'realized_below_floor',
  });
  assert.ok(hb.flags.includes('VETO_NEW'), 'real false->true transition (prior was evaluated) must raise VETO_NEW');
}

// 3b. Restart artifact: veto=true now, prior was a JUST-BOOTED false (not yet
//     evaluated) → must NOT raise VETO_NEW. This is the deploy false-alarm fix.
{
  const hb = monitorLog.buildHeartbeat({
    ts: 3100, equity: 479, openPositions: 0,
    veto: true, prevVeto: false, prevEvaluated: false, sampleSize: 10,
    vetoReason: 'realized_below_floor',
  });
  assert.ok(!hb.flags.includes('VETO_NEW'),
    'null->veto on restart (prior not evaluated) must NOT raise VETO_NEW');
  assert.deepEqual(hb.flags, [], 'restart re-arm of a pre-existing veto is benign');
}

// 3c. `evaluated` is true iff sampleSize is populated (drives the next tick).
{
  assert.equal(monitorLog.buildHeartbeat({ ts: 3200, sampleSize: 12 }).evaluated, true);
  assert.equal(monitorLog.buildHeartbeat({ ts: 3201, sampleSize: null }).evaluated, false);
}

// 4. Equity below floor → EQUITY_LOW.
{
  const hb = monitorLog.buildHeartbeat({
    ts: 4000, equity: 470, openPositions: 1, veto: false, prevVeto: false,
    equityFloor: 472,
  });
  assert.ok(hb.flags.includes('EQUITY_LOW'), 'equity under floor must raise EQUITY_LOW');
}

// 5. Execution failure → EXEC_FAIL (and it is truncated/stringified safely).
{
  const hb = monitorLog.buildHeartbeat({
    ts: 5000, equity: 480, openPositions: 0, veto: false, prevVeto: false,
    execFailure: 'AggregateError: positions_or_orders_fetch_failed',
  });
  assert.ok(hb.flags.includes('EXEC_FAIL'), 'exec failure must raise EXEC_FAIL');
  assert.ok(typeof hb.execFailure === 'string' && hb.execFailure.length > 0);
}

// 6. Missing/blank numeric fields degrade to null, not 0 (avoid fake zeros).
{
  const hb = monitorLog.buildHeartbeat({ ts: 6000, equity: '', realizedAvgNetBps: null });
  assert.equal(hb.equity, null, 'blank equity must be null, not 0');
  assert.equal(hb.realizedAvgNetBps, null);
  assert.equal(hb.openPositions, 0, 'openPositions defaults to 0');
}

// 7. formatLine produces a readable one-liner with the flag bracket only when flagged.
{
  const clean = monitorLog.formatLine(monitorLog.buildHeartbeat({
    ts: 7000, equity: 480.123, openPositions: 2, veto: false, prevVeto: false,
    realizedAvgNetBps: 4.2, sampleSize: 13, signalVersion: 'mean_reversion',
  }));
  assert.ok(clean.includes('equity=$480.12'), 'formats equity to 2dp');
  assert.ok(clean.includes('trading'), 'non-veto shows trading');
  assert.ok(!clean.includes('['), 'clean line has no flag bracket');

  const flagged = monitorLog.formatLine(monitorLog.buildHeartbeat({
    ts: 7001, equity: 470, openPositions: 0, veto: true, prevVeto: false,
    equityFloor: 472,
  }));
  assert.ok(flagged.includes('[VETO_NEW]') && flagged.includes('[EQUITY_LOW]'),
    'flagged line surfaces every flag');
}

console.log('monitorLog.test ok', { tests: 10 });
