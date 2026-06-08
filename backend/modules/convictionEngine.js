// Conviction engine — selectivity + regime gate + conviction sizing.
//
// THE IDEA (docs/PROFITABILITY_ANALYSIS_2026-06.md follow-up). A "scalp every
// signal at fixed size" bot dilutes its best edge with marginal trades and
// bleeds in chop. The profitable-minority behaviour is the opposite: take FEW,
// high-conviction trades, SIT OUT unfavorable regimes, and bet BIGGER on the
// A+ setups. This module turns one number — a 0..1 conviction score — into two
// decisions: (1) enter or sit out (selectivity), and (2) how much to size
// (fractional-Kelly-style, 1.0x..maxSizeMult of the base notional).
//
// It is a GATE that sits in FRONT of the existing entry path. It never relaxes
// any safety: the realized-veto breaker, spread cap, freshness, and per-symbol
// caps all still apply. Conviction can only make the bot MORE selective and
// size winners up within the existing MAX_SIZING_FRACTION_OF_TARGET cap — it
// can never force a trade the rest of the stack would reject.
//
// Conviction blends four independent signals (weights sum to 1):
//   - confidence : the active signal's own confidence (0..1)
//   - regime     : favorability of the current market regime for a long-biased
//                  momentum/lead-lag scalper (benign trend = good, dead chop and
//                  downtrends = bad)
//   - edge       : is this signal ACTUALLY working live right now? (recent
//                  realized net bps). Neutral when the sample is too small.
//   - projection : how much room the setup has (projected move vs a reference)
//
// PURITY. Pure function of its inputs — no clock, no I/O. Fully unit-testable.

const DEFAULT_CONFIG = Object.freeze({
  // Selectivity threshold: only enter when conviction >= this. Higher = pickier
  // = fewer trades. 0.45 is moderate (keeps the bot trading while cutting the
  // weakest ~third of setups). Tune via CONVICTION_MIN.
  minConviction: 0.45,
  // Blend weights (must conceptually sum to 1; the engine normalizes anyway).
  weights: Object.freeze({ confidence: 0.35, regime: 0.30, edge: 0.20, projection: 0.15 }),
  // Regime favorability for a long-biased momentum/lead-lag strategy.
  regimeFavorability: Object.freeze({
    benign: 1.0,            // positive drift, alts ride BTC up — best
    wild: 0.6,              // high vol, flat drift — opportunity but choppy
    flat: 0.45,             // mid vol, no drift — neutral
    quiet: 0.25,            // dead low-vol chop — scalping bleeds here
    adverse: 0.05,          // downtrend — long-only fights the tape
    insufficient_data: 0.5, // unknown — stay neutral, don't penalize
  }),
  // Regimes that HARD-veto a long entry regardless of the rest of the score
  // (don't buy into a sustained downtrend). Cleared by passing [] in config.
  hardVetoRegimes: Object.freeze(['adverse']),
  // If the regime snapshot is older than this, treat regime as neutral and
  // skip the hard veto (don't act on stale regime data).
  regimeMaxAgeMs: 120 * 1000,
  // Edge factor: map the active signal's recent realized avg net bps to 0..1.
  // +edgeScaleBps -> 1.0, 0 -> 0.5, -edgeScaleBps -> 0.0. Below edgeMinSample
  // closes we don't trust it and return edgeNeutral (a fresh signal is not
  // penalized for having no track record yet).
  edgeScaleBps: 20,
  edgeMinSample: 8,
  edgeNeutral: 0.5,
  // Projection factor: projectedBps / projRefBps, clamped 0..1.
  projRefBps: 30,
  // Sizing: a passing trade sizes from 1.0x (just cleared the bar) up to
  // maxSizeMult (max conviction). Never sizes BELOW the base — selectivity does
  // the cutting; sizing only leans into the best. Cap mirrors trade.js's
  // MAX_SIZING_FRACTION_OF_TARGET (1.5 by default).
  maxSizeMult: 1.5,
});

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// Map recent realized net bps -> 0..1 edge factor.
function edgeFactorFrom(recentRealized, cfg) {
  if (!recentRealized) return cfg.edgeNeutral;
  const n = Number(recentRealized.sampleSize);
  const avg = Number(recentRealized.avgNetBps);
  if (!isNum(n) || n < cfg.edgeMinSample || !isNum(avg)) return cfg.edgeNeutral;
  return clamp01(0.5 + (avg / (cfg.edgeScaleBps * 2)));
}

// Map regime label -> 0..1 favorability, honoring snapshot freshness.
function regimeFactorFrom(regime, cfg) {
  if (!regime || typeof regime !== 'object') {
    return { factor: 0.5, label: null, fresh: false };
  }
  const ageMs = Number(regime.ageMs);
  const fresh = isNum(ageMs) ? ageMs <= cfg.regimeMaxAgeMs : (regime.ageMs == null);
  const label = typeof regime.regime === 'string' ? regime.regime : null;
  if (!fresh || !label) return { factor: 0.5, label, fresh };
  const fav = cfg.regimeFavorability[label];
  return { factor: isNum(fav) ? fav : 0.5, label, fresh };
}

function evaluateConviction({
  signal = {},
  regime = null,
  recentRealized = null,
  config = {},
} = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(config || {}),
    weights: { ...DEFAULT_CONFIG.weights, ...((config && config.weights) || {}) },
    regimeFavorability: { ...DEFAULT_CONFIG.regimeFavorability, ...((config && config.regimeFavorability) || {}) },
    hardVetoRegimes: (config && config.hardVetoRegimes) || DEFAULT_CONFIG.hardVetoRegimes,
  };

  // --- component factors (each 0..1) ---
  const confidence = isNum(signal.confidence) ? clamp01(signal.confidence) : 0.5;
  const { factor: regimeFactor, label: regimeLabel, fresh: regimeFresh } = regimeFactorFrom(regime, cfg);
  const edge = edgeFactorFrom(recentRealized, cfg);
  const projection = clamp01((isNum(signal.projectedBps) ? signal.projectedBps : 0) / cfg.projRefBps);

  // --- weighted blend (weights normalized so they always sum to 1) ---
  const w = cfg.weights;
  const wsum = (w.confidence + w.regime + w.edge + w.projection) || 1;
  const conviction = clamp01(
    (w.confidence * confidence
      + w.regime * regimeFactor
      + w.edge * edge
      + w.projection * projection) / wsum,
  );

  // --- hard regime veto (don't buy a sustained downtrend) ---
  const hardVeto = regimeFresh && regimeLabel != null && cfg.hardVetoRegimes.includes(regimeLabel);

  // --- decisions ---
  const enter = !hardVeto && conviction >= cfg.minConviction;
  let sizeMultiplier = 0;
  if (enter) {
    const span = Math.max(1e-6, 1 - cfg.minConviction);
    const t = clamp01((conviction - cfg.minConviction) / span);
    sizeMultiplier = 1.0 + t * (Math.max(1.0, cfg.maxSizeMult) - 1.0);
  }
  const reason = hardVeto
    ? `regime_veto_${regimeLabel}`
    : (enter ? null : 'low_conviction');

  return {
    conviction,
    enter,
    sizeMultiplier,
    reason,
    components: {
      confidence,
      regime: regimeFactor,
      regimeLabel,
      regimeFresh,
      edge,
      projection,
    },
    minConviction: cfg.minConviction,
  };
}

module.exports = { evaluateConviction, DEFAULT_CONFIG };
