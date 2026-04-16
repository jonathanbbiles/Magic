function resolveUniverseCap({ configuredCap = null, configuredCapSource = 'uncapped', ratePressureActive = false, prioritizedCount = 0 } = {}) {
  const normalizedConfiguredCap = normalizeConfiguredCap(configuredCap);
  const effectiveCap = ratePressureActive
    ? Math.max(4, normalizedConfiguredCap != null ? Math.floor(normalizedConfiguredCap * 0.5) : Math.floor(Math.max(0, prioritizedCount) * 0.5))
    : normalizedConfiguredCap;
  return {
    configuredCap: normalizedConfiguredCap,
    configuredCapSource: normalizedConfiguredCap == null ? 'uncapped' : configuredCapSource,
    effectiveCap,
    effectiveCapSource: ratePressureActive ? 'rate_pressure_backoff' : (normalizedConfiguredCap == null ? 'uncapped' : configuredCapSource),
    ratePressureActive: Boolean(ratePressureActive),
  };
}

function normalizeConfiguredCap(configuredCap) {
  if (configuredCap == null) return null;
  if (typeof configuredCap === 'string' && configuredCap.trim() === '') return null;
  const configuredRaw = Number(configuredCap);
  if (!Number.isFinite(configuredRaw) || configuredRaw <= 0) return null;
  return Math.max(1, Math.floor(configuredRaw));
}

module.exports = { resolveUniverseCap, normalizeConfiguredCap };
