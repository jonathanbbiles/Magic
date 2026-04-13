const { normalizePair } = require('../symbolUtils');

const DEFAULT_POLICY = Object.freeze({ threshold: 3, cooldownMs: 120000 });

const DEFAULT_REASON_POLICIES = Object.freeze({
  stale_quote_primary: { threshold: 2, cooldownMs: 120000 },
  marketdata_unavailable: { threshold: 2, cooldownMs: 90000 },
  ob_depth_insufficient: { threshold: 2, cooldownMs: 120000 },
  predictor_warmup: { threshold: 3, cooldownMs: 90000 },
  sparse_fallback_rejected: { threshold: 2, cooldownMs: 120000 },
});

function normalizeSymbol(symbol) {
  return normalizePair(symbol);
}

function createSymbolHealthTracker({ now = () => Date.now(), reasonPolicies = DEFAULT_REASON_POLICIES } = {}) {
  const stateBySymbol = new Map();

  function getPolicy(reason) {
    return reasonPolicies[String(reason || '').toLowerCase()] || DEFAULT_POLICY;
  }

  function ensureState(symbol) {
    const key = normalizeSymbol(symbol);
    if (!key) return null;
    if (!stateBySymbol.has(key)) {
      stateBySymbol.set(key, { failures: {}, cooldown: null, lastHealthyAtMs: 0 });
    }
    return { key, state: stateBySymbol.get(key) };
  }

  function setCooldown(state, reason, cooldownMs, extra = {}) {
    const durationMs = Math.max(0, Number(cooldownMs) || 0);
    if (!durationMs) return;
    state.cooldown = {
      reason,
      untilMs: now() + durationMs,
      failures: Number(state.failures?.[reason]?.count || 0),
      ...extra,
    };
  }

  function recordFailure(symbol, reason, meta = {}) {
    const entry = ensureState(symbol);
    if (!entry) return null;
    const normalizedReason = String(reason || '').toLowerCase();
    const policy = getPolicy(normalizedReason);
    const prev = entry.state.failures[normalizedReason] || { count: 0, totalCount: 0, lastFailureAtMs: 0 };
    const next = {
      count: prev.count + 1,
      totalCount: prev.totalCount + 1,
      lastFailureAtMs: now(),
      meta,
    };
    entry.state.failures[normalizedReason] = next;

    const requestedCooldownMs = Number(meta?.cooldownMs);
    const cooldownMs = Number.isFinite(requestedCooldownMs) && requestedCooldownMs > 0
      ? requestedCooldownMs
      : policy.cooldownMs;
    if (next.count >= Math.max(1, Number(policy.threshold) || 1)) {
      setCooldown(entry.state, normalizedReason, cooldownMs, {
        quoteAgeMs: Number.isFinite(Number(meta?.quoteAgeMs)) ? Number(meta.quoteAgeMs) : null,
      });
    }

    return {
      symbol: entry.key,
      reason: normalizedReason,
      count: next.count,
      cooldown: getCooldown(entry.key),
    };
  }

  function clearFailure(symbol, reason) {
    const entry = ensureState(symbol);
    if (!entry) return;
    const normalizedReason = String(reason || '').toLowerCase();
    if (entry.state.failures[normalizedReason]) {
      entry.state.failures[normalizedReason].count = 0;
    }
    if (entry.state.cooldown?.reason === normalizedReason) {
      entry.state.cooldown = null;
    }
  }

  function noteHealthy(symbol) {
    const entry = ensureState(symbol);
    if (!entry) return;
    entry.state.lastHealthyAtMs = now();
    entry.state.cooldown = null;
    for (const reason of Object.keys(entry.state.failures)) {
      entry.state.failures[reason].count = 0;
    }
  }

  function getCooldown(symbol) {
    const entry = ensureState(symbol);
    if (!entry) return { active: false, reason: null, untilMs: 0, remainingMs: 0, failures: 0 };
    const cooldown = entry.state.cooldown;
    if (!cooldown || Number(cooldown.untilMs) <= now()) {
      if (cooldown && Number(cooldown.untilMs) <= now()) entry.state.cooldown = null;
      return { active: false, reason: null, untilMs: 0, remainingMs: 0, failures: 0 };
    }
    return {
      active: true,
      reason: cooldown.reason || null,
      untilMs: Number(cooldown.untilMs) || 0,
      remainingMs: Math.max(0, Number(cooldown.untilMs || 0) - now()),
      failures: Number(cooldown.failures) || 0,
      quoteAgeMs: Number.isFinite(Number(cooldown.quoteAgeMs)) ? Number(cooldown.quoteAgeMs) : null,
    };
  }

  function evaluateEligibility(symbol) {
    const cooldown = getCooldown(symbol);
    if (!cooldown.active) return { eligible: true, reason: null, cooldown };
    return {
      eligible: false,
      reason: 'symbol_health_cooldown',
      cooldown,
    };
  }

  function listActiveCooldowns({ limit = 8 } = {}) {
    const rows = [];
    for (const [symbol] of stateBySymbol.entries()) {
      const cooldown = getCooldown(symbol);
      if (!cooldown.active) continue;
      rows.push({ symbol, ...cooldown });
    }
    rows.sort((a, b) => b.untilMs - a.untilMs);
    return rows.slice(0, Math.max(1, Number(limit) || 8));
  }

  return {
    recordFailure,
    clearFailure,
    noteHealthy,
    getCooldown,
    evaluateEligibility,
    listActiveCooldowns,
  };
}

module.exports = {
  createSymbolHealthTracker,
  DEFAULT_REASON_POLICIES,
};
