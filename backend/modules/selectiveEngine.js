// Selective Engine — Phase 1 Layer 1 of the event-triggered hybrid
// architecture (see the plan at /root/.claude/plans/my-frustration-here-is-
// wise-shamir.md and README.md "Selective conviction layer").
//
// Subscribes to event sources (Phase 1: funding-rate flips from
// fundingRateMonitor). On each event, builds a feature context for the
// affected symbol, calls the LLM gate, and — on a high-confidence YES —
// places an entry through the live engine's order-placement path.
//
// Why this is separate from scanAndEnter:
//   scanAndEnter polls every 12s and evaluates every symbol in the
//   universe against OHLCV-derived signals. The selective layer is
//   fundamentally different: it's triggered by external events (funding
//   flip, news, on-chain) and routes through an LLM gate. Bolting it onto
//   the scanner would tangle two unrelated cadences. Keeping it a
//   peer module lets Phase 2/3/4 add Reddit/GDELT/on-chain event sources
//   without touching the OHLCV scanner.
//
// Hard rule (CLAUDE.md #5): selective entries use the same exit path as
// every other signal. Once the buy is placed, the existing GTC TP /
// staircase / vol-scaled stop logic owns the lifecycle. The selective
// engine does NOT add force-exit, max-hold, or any other lifecycle hooks
// beyond what the live trade.js already implements for
// signalVersion='selective_funding_flip'.

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // Min LLM confidence (0-100) required to act on a YES decision. Default
  // 65 — same as DEFAULT_CONFIG.minConfidence in llmGate.js — but exposed
  // here too so the engine can re-validate the gate's threshold without
  // trusting it.
  minConfidence: 65,
  // Per-symbol cooldown after a selective entry attempt (whether the LLM
  // said YES or NO). Prevents the same flip from racing in twice if the
  // event source re-emits.
  symbolCooldownMs: 30 * 60 * 1000,
  // Hard ceiling on Layer 1 fills per day. Phase 1 free-tier guardrails:
  // Gemini Flash free tier is 500 RPD; we'll hit the LLM ~2x more often
  // than we trade (most events become NO), so 100 trade-attempts/day is
  // a safe envelope.
  maxFiresPerDay: 100,
});

// Build a compact feature context for the LLM prompt. Pulls from whatever
// the caller injects (`marketData` callbacks); falls back gracefully if
// any single field is unavailable.
//
// The shape is intentionally lean. The LLM doesn't need every column; it
// needs enough signal to make a yes/no call.
async function buildFeatureContext({ pair, marketData }) {
  const features = {};
  try {
    if (typeof marketData.getLatestQuote === 'function') {
      const quote = await marketData.getLatestQuote(pair);
      if (quote && Number.isFinite(quote.bp) && Number.isFinite(quote.ap)) {
        features.bid = Number(quote.bp);
        features.ask = Number(quote.ap);
        features.mid = (Number(quote.bp) + Number(quote.ap)) / 2;
        const spread = Number(quote.ap) - Number(quote.bp);
        if (Number.isFinite(spread) && features.mid > 0) {
          features.spreadBps = (spread / features.mid) * 10000;
        }
      }
    }
  } catch { /* missing quote → just drop those fields */ }

  try {
    if (typeof marketData.getRecentBars === 'function') {
      const bars = await marketData.getRecentBars(pair, 60);
      if (Array.isArray(bars) && bars.length > 0) {
        const closes = bars.map((b) => Number(b?.c)).filter((n) => Number.isFinite(n));
        if (closes.length >= 14) {
          features.barsCount = closes.length;
          features.priceCurrent = closes[closes.length - 1];
          features.priceHigh60 = Math.max(...closes);
          features.priceLow60 = Math.min(...closes);
          // 60-bar return: (last - first) / first × 10000
          const first = closes[0];
          if (first > 0) {
            features.return60barBps = ((closes[closes.length - 1] - first) / first) * 10000;
          }
          // Cheap RSI(14) — match indicators.js logic enough for the prompt.
          features.rsi14 = quickRsi(closes, 14);
        }
      }
    }
  } catch { /* missing bars → drop bar-derived fields */ }

  return features;
}

// Pared-down RSI(14) used only for the LLM feature snapshot. The live
// engine uses indicators.js for trade math; we don't need exact parity
// here — this is a hint for the LLM, not a gate value.
function quickRsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (gains === 0 && losses === 0) return 50;
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Stateful engine factory. Returns an object that wires event sources to
// the LLM gate to the trade-placement callback.
//
// deps:
//   - fundingMonitor: must expose onFlip(cb)
//   - llmGate: must expose evaluate({ symbol, eventContext, features })
//   - marketData: { getLatestQuote(pair), getRecentBars(pair, n) }
//   - placeSelectiveBuy(pair, payload) → async, returns { ok, ... }
//   - nowFn (optional, for tests)
//   - logger (optional, for tests)
function createSelectiveEngine(userConfig = {}, deps = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const {
    fundingMonitor,
    llmGate,
    marketData = {},
    placeSelectiveBuy,
    nowFn = Date.now,
    logger = console,
  } = deps;

  const cooldownByPair = new Map();
  // Counters for diagnostics.
  let totalEvents = 0;
  let totalEvaluations = 0;
  let totalYesDecisions = 0;
  let totalEntriesPlaced = 0;
  let totalSkipped = 0;
  const skipReasons = new Map();
  let cooldownDayStart = nowFn();
  let firesThisWindow = 0;

  function bumpSkip(reason) {
    totalSkipped += 1;
    skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
  }

  function rolloverDailyWindow(now) {
    if (now - cooldownDayStart >= 24 * 60 * 60 * 1000) {
      cooldownDayStart = now;
      firesThisWindow = 0;
    }
  }

  async function handleEvent(event) {
    totalEvents += 1;
    if (!config.enabled) { bumpSkip('engine_disabled'); return; }
    if (!event || typeof event !== 'object') { bumpSkip('invalid_event'); return; }
    const { pair } = event;
    if (!pair || typeof pair !== 'string') { bumpSkip('invalid_pair'); return; }

    const now = nowFn();
    rolloverDailyWindow(now);
    if (firesThisWindow >= config.maxFiresPerDay) {
      bumpSkip('daily_cap_reached');
      return;
    }

    const cooldownUntil = cooldownByPair.get(pair) || 0;
    if (now < cooldownUntil) {
      bumpSkip('per_symbol_cooldown');
      return;
    }
    // Set cooldown immediately so concurrent re-emits are deduped.
    cooldownByPair.set(pair, now + config.symbolCooldownMs);
    firesThisWindow += 1;

    let features;
    try {
      features = await buildFeatureContext({ pair, marketData });
    } catch (err) {
      logger.warn?.('selective_engine_feature_build_failed', { pair, message: err?.message });
      bumpSkip('feature_build_failed');
      return;
    }

    let decision;
    try {
      totalEvaluations += 1;
      decision = await llmGate.evaluate({
        symbol: pair,
        eventContext: {
          source: event.source,
          direction: event.direction,
          latestBps: event.latestBps,
          trailingMeanBps: event.trailingMeanBps,
          trailingWindow: event.trailingWindow,
          perpSymbol: event.perpSymbol,
        },
        features,
      });
    } catch (err) {
      logger.warn?.('selective_engine_llm_gate_failed', { pair, message: err?.message });
      bumpSkip('llm_gate_threw');
      return;
    }

    logger.log?.('selective_engine_decision', {
      pair,
      eventSource: event.source,
      direction: event.direction,
      decision: decision?.decision,
      confidence: decision?.confidence,
      targetBps: decision?.targetBps,
      stopBps: decision?.stopBps,
      reasoning: decision?.reasoning,
      apiCalled: decision?.apiCalled,
    });

    if (!decision || decision.decision !== 'YES') { bumpSkip('llm_decision_no'); return; }
    if (decision.confidence < config.minConfidence) { bumpSkip('llm_confidence_below_threshold'); return; }
    if (!placeSelectiveBuy) { bumpSkip('no_placer_wired'); return; }
    totalYesDecisions += 1;

    let placeResult;
    try {
      placeResult = await placeSelectiveBuy(pair, {
        eventContext: event,
        llmDecision: decision,
      });
    } catch (err) {
      logger.warn?.('selective_engine_place_failed', { pair, message: err?.message });
      bumpSkip('place_threw');
      return;
    }
    if (placeResult?.ok) {
      totalEntriesPlaced += 1;
      logger.log?.('selective_entry_placed', { pair, orderId: placeResult?.buy?.id || null });
    } else {
      bumpSkip(`place_failed_${placeResult?.reason || 'unknown'}`);
    }
  }

  let unsubscribe = null;
  function start() {
    if (!fundingMonitor || typeof fundingMonitor.onFlip !== 'function') {
      logger.warn?.('selective_engine_no_funding_monitor');
      return;
    }
    if (unsubscribe) return;
    unsubscribe = fundingMonitor.onFlip((event) => {
      // Fire and forget — handleEvent is async but we don't block the
      // event emitter on the LLM round-trip. Errors are caught inside.
      handleEvent(event).catch((err) => {
        logger.warn?.('selective_engine_handler_uncaught', { message: err?.message });
      });
    });
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  function getSnapshot() {
    const skipObj = {};
    for (const [k, v] of skipReasons.entries()) skipObj[k] = v;
    return {
      enabled: config.enabled,
      running: Boolean(unsubscribe),
      minConfidence: config.minConfidence,
      symbolCooldownMs: config.symbolCooldownMs,
      maxFiresPerDay: config.maxFiresPerDay,
      totalEvents,
      totalEvaluations,
      totalYesDecisions,
      totalEntriesPlaced,
      totalSkipped,
      firesThisWindow,
      cooldownDayStart,
      skipReasons: skipObj,
    };
  }

  return {
    start,
    stop,
    handleEvent,
    getSnapshot,
    config,
  };
}

module.exports = {
  createSelectiveEngine,
  buildFeatureContext,
  quickRsi,
  DEFAULT_CONFIG,
};
