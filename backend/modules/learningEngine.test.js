const assert = require('assert/strict');
const le = require('./learningEngine');

// ---- scoreOnHoldout: mean realized net bps of trades the model would take ----
{
  // weights: take a trade when feature 'micro' is positive (w=10, b0=0)
  const w = { b0: 0, micro: 10 };
  const holdout = [
    { features: { micro: 1 }, realizedNetBps: 20 },   // p~1 -> taken, +20
    { features: { micro: 1 }, realizedNetBps: 10 },   // taken, +10
    { features: { micro: -1 }, realizedNetBps: -50 }, // p~0 -> NOT taken (skipped)
  ];
  const r = le.scoreOnHoldout(w, holdout);
  assert.equal(r.taken, 2, 'only the two positive-micro trades are taken');
  assert.equal(r.score, 15, 'mean of +20 and +10');
}
{
  // model that takes nothing -> score null
  const r = le.scoreOnHoldout({ b0: -100 }, [{ features: {}, realizedNetBps: 5 }]);
  assert.equal(r.score, null);
  assert.equal(r.taken, 0);
}

// ---- evaluatePromotion: the safety gate ----

// P1. No candidate / failed fit -> never promote.
{
  const v = le.evaluatePromotion({ candidate: { ok: false, reason: 'insufficient_samples' }, holdout: [] });
  assert.equal(v.promote, false);
  assert.equal(v.reason, 'insufficient_samples');
}

// P2. Candidate clearly beats incumbent on holdout -> promote.
{
  const candidate = { ok: true, weights: { b0: 0, micro: 10 }, priors: { b0: 0, micro: 1 } };
  const incumbent = { b0: 0, micro: 10 }; // same as candidate? use a weaker incumbent below
  const holdout = [
    { features: { micro: 1 }, realizedNetBps: 30 },
    { features: { micro: 1 }, realizedNetBps: 25 },
    { features: { micro: -1 }, realizedNetBps: -40 },
  ];
  // incumbent that takes the SAME trades but we pretend it scores worse by taking the loser too
  const weakIncumbent = { b0: 5, micro: 0 }; // b0=5 -> always p>0.5 -> takes ALL incl the -40
  const v = le.evaluatePromotion({ candidate, incumbent: weakIncumbent, holdout, config: { minImprovementBps: 2, minHoldoutBps: 0 } });
  // candidate takes the 2 winners (avg 27.5); incumbent takes all 3 (avg (30+25-40)/3=5)
  assert.equal(v.candidateScore, 27.5);
  assert.equal(v.incumbentScore, 5);
  assert.equal(v.promote, true, 'candidate beats incumbent by >2bps and clears floor');
  assert.equal(v.reason, 'candidate_better');
}

// P3. Candidate trades but is BELOW the absolute holdout floor -> do NOT promote.
{
  const candidate = { ok: true, weights: { b0: 5, micro: 0 }, priors: { b0: 0, micro: 1 } };
  const holdout = [
    { features: { micro: 1 }, realizedNetBps: -10 },
    { features: { micro: 1 }, realizedNetBps: -20 },
  ];
  const v = le.evaluatePromotion({ candidate, incumbent: null, holdout, config: { minImprovementBps: 2, minHoldoutBps: 0 } });
  assert.equal(v.candidateScore, -15);
  assert.equal(v.promote, false);
  assert.equal(v.reason, 'candidate_below_holdout_floor', 'a losing candidate is never promoted even with no incumbent');
}

// P4. Candidate better than nothing-incumbent but still positive -> promote.
{
  const candidate = { ok: true, weights: { b0: 5, micro: 0 }, priors: { b0: 0, micro: 1 } };
  const holdout = [
    { features: { micro: 1 }, realizedNetBps: 8 },
    { features: { micro: 1 }, realizedNetBps: 12 },
  ];
  // incumbent takes no holdout trades (b0 very negative) -> incScore null -> any positive candidate wins
  const v = le.evaluatePromotion({ candidate, incumbent: { b0: -100 }, holdout, config: { minImprovementBps: 2, minHoldoutBps: 0 } });
  assert.equal(v.candidateScore, 10);
  assert.equal(v.incumbentScore, null);
  assert.equal(v.promote, true, 'positive candidate beats a never-trading incumbent');
}

// P5. Candidate takes no holdout trades -> cannot judge -> do NOT promote.
{
  const candidate = { ok: true, weights: { b0: -100, micro: 0 }, priors: {} };
  const v = le.evaluatePromotion({ candidate, incumbent: null, holdout: [{ features: { micro: 1 }, realizedNetBps: 50 }] });
  assert.equal(v.promote, false);
  assert.equal(v.reason, 'candidate_takes_no_holdout_trades');
}

// ---- config + orchestrator safety ----

// C1. Disabled by default (master kill OFF until operator opts in).
{
  assert.equal(le.DEFAULTS.enabled, false);
  const cfg = le.readConfigFromEnv({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.minSamples, 500, '500-sample floor by default');
}

// C2. runCalibrationCycle never throws + is a no-op when disabled.
{
  le._resetState();
  const r = le.runCalibrationCycle({ env: {}, nowMs: 1000 });
  assert.equal(r.action, 'disabled');
  assert.equal(r.enabled, false);
}

// C3. Enabled but below sample floor -> fit_refused, never promotes, never throws.
{
  le._resetState();
  const tinyRecords = new Array(20).fill(0).map((_, i) => ({
    type: 'closed_trade', phase: 'exit_update', realizedNetBps: i % 2 ? 10 : -10,
  }));
  const r = le.runCalibrationCycle({ env: { LEARNING_ENGINE_ENABLED: 'true', LEARNING_MIN_NEW_TRADES: '1' }, nowMs: 2000, forecastSamples: tinyRecords });
  assert.ok(['fit_refused', 'held', 'none', 'waiting_for_new_trades'].includes(r.action), 'below floor must not promote; got ' + r.action);
  assert.notEqual(r.action, 'promoted', 'never promote below sample floor');
}

console.log('learningEngine.test ok', { tests: 11 });
