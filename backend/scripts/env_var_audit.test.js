const assert = require('assert');
const { auditEnvVars, extractDocumentedEnvVars, extractReadEnvVars } = require('./env_var_audit');

// 1. Pure-function sanity: extract from sample markdown.
{
  const docs = '`STOP_LOSS_BPS=40` and `MIN_PROB_TO_ENTER` are real. BUY is not.';
  const got = extractDocumentedEnvVars(docs);
  assert.ok(got.has('STOP_LOSS_BPS'), 'STOP_LOSS_BPS extracted');
  assert.ok(got.has('MIN_PROB_TO_ENTER'), 'MIN_PROB_TO_ENTER extracted');
  assert.ok(!got.has('BUY'), 'BUY (no underscore) is filtered out');
}

// 2. Pure-function sanity: extract from sample source code.
{
  const src = `
    const A = readNumber('STOP_LOSS_BPS', 40);
    const B = readBoolean('PHASE1_ENABLED', true);
    const C = process.env.SIGNAL_VERSION;
    const D = process.env['MICRO_TRADES_ENABLED'];
    const E = readEnum('ENTRY_LIMIT_PRICE_MODE', ['ask', 'mid'], 'mid');
    const escape = { escapeHatchEnv: 'ENTRY_LIMIT_PRICE_MODE_ALLOW_UNSAFE_ASK' };
  `;
  const got = extractReadEnvVars(src);
  assert.ok(got.has('STOP_LOSS_BPS'), 'readNumber call detected');
  assert.ok(got.has('PHASE1_ENABLED'), 'readBoolean call detected');
  assert.ok(got.has('SIGNAL_VERSION'), 'process.env.X detected');
  assert.ok(got.has('MICRO_TRADES_ENABLED'), 'process.env["X"] detected');
  assert.ok(got.has('ENTRY_LIMIT_PRICE_MODE'), 'readEnum detected');
  assert.ok(
    got.has('ENTRY_LIMIT_PRICE_MODE_ALLOW_UNSAFE_ASK'),
    'env-var-shaped string literal detected (escape hatch pattern)',
  );
}

// 3. Wildcard prefix references like `MICRO_HORIZON_*_ENABLED` must not
//    extract trailing-underscore fragments as if they were env var names.
{
  const docs = 'Per-horizon: `MICRO_HORIZON_*_ENABLED`.';
  const got = extractDocumentedEnvVars(docs);
  for (const name of got) {
    assert.ok(
      !name.endsWith('_'),
      `extracted "${name}" must not end with underscore (wildcard fragment)`,
    );
  }
}

// 4. Allowlist entries must not appear in the documented set.
{
  const docs = 'DEFAULT_CONFIG mirrors LIVE_CRITICAL_DEFAULTS. ACTIVE_SIGNAL_VERSION is set at module load.';
  const got = extractDocumentedEnvVars(docs);
  assert.ok(!got.has('DEFAULT_CONFIG'), 'DEFAULT_CONFIG filtered by allowlist');
  assert.ok(!got.has('LIVE_CRITICAL_DEFAULTS'), 'LIVE_CRITICAL_DEFAULTS filtered');
  assert.ok(!got.has('ACTIVE_SIGNAL_VERSION'), 'ACTIVE_SIGNAL_VERSION filtered');
}

// 5. Integration: the real repo audit must come back clean. This is the
//    test that enforces Hard Rule #4 — if a future PR adds an env var to
//    README.md or CLAUDE.md without a corresponding read in backend/, this
//    assertion will fail with the list of unbacked names.
{
  const result = auditEnvVars();
  assert.ok(result.documentedCount > 0, 'documented var count must be positive');
  assert.ok(result.readCount > 0, 'read var count must be positive');
  assert.deepStrictEqual(
    result.missing,
    [],
    `env_var_audit found unbacked documented env vars — either wire them in backend/ or remove the doc entry:\n${JSON.stringify(result.missing, null, 2)}`,
  );
}

console.log('env_var_audit.test ok', {
  test1: 'doc extraction',
  test2: 'code read detection',
  test3: 'wildcard fragment filter',
  test4: 'allowlist filter',
  test5: 'repo audit clean',
});
