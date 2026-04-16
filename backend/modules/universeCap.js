function resolveUniverseCap({ configuredCap = null, configuredCapSource = 'uncapped', ratePressureActive = false, prioritizedCount = 0 } = {}) {
  const configuredRaw = Number(configuredCap);
  const normalizedConfiguredCap =
    Number.isFinite(configuredRaw) && configuredRaw > 0
      ? Math.max(1, Math.floor(configuredRaw))
      : null;
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

module.exports = { resolveUniverseCap };
