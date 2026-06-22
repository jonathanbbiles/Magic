// Simplified trading engine.
//
// Contract:
//   1. Scan Alpaca's crypto universe every ENTRY_SCAN_INTERVAL_MS.
//   2. For each symbol, predict a tiny upward move using linear regression
//      on recent 1m closes (see getPredictionSignal).
//   3. If the spread still leaves room for our target net profit, submit a
//      GTC limit BUY at the current ask.
//   4. When the buy fills, submit ONE GTC limit SELL at
//      entry * (1 + (TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP) / 10000)
//      so the small NET target (default +0.15%, allowed range 0.10%..0.50%)
//      is AFTER Alpaca's round-trip fees. This is a *scalper*: target is
//      deliberately tiny so wins fill often and the strategy compounds.
//   5. If the take-profit doesn't fill within BREAKEVEN_TIMEOUT_MS (default
//      4 hours from when the position was first observed), cancel the GTC
//      sell and replace it with a sell at break-even-after-fees
//      (entry * (1 + FEE_BPS_ROUND_TRIP/10000)). That guarantees zero net
//      profit but recycles the slot so the engine keeps trading.
//
// This module also exposes every HTTP wrapper + snapshot getter that
// backend/index.js imports, so the dashboard/frontend contract is preserved.

// MUST be the first require: bridges LIVE_CRITICAL_DEFAULTS into
// process.env BEFORE any of the readNumber/readBoolean calls below
// consult process.env directly. Without this, changes to liveDefaults.js
// are silently ignored by the trade engine.
require('./config/bootstrapLiveEnv');

const { normalizePair, toAlpacaSymbol } = require('./symbolUtils');
const { getRuntimeConfig } = require('./config/runtimeConfig');
const { slopeTStatFromOls, slopeProbability } = require('./modules/entryProbability');
const {
  barrierHitProbability,
  estimateExpectedNetBps,
  computeMinimumGrossTargetBps,
} = require('./modules/entryEconomics');
const { evaluateMultiFactorSignal } = require('./modules/multiFactorSignal');
const { evaluateMeanReversionSignal } = require('./modules/meanReversionSignal');
const { evaluateBtcLeadLagSignal, isBtcLeadLagExecutionSafe } = require('./modules/btcLeadLagSignal');
const convictionEngine = require('./modules/convictionEngine');
const { evaluateRangeMeanReversionSignal } = require('./modules/rangeMeanReversionSignal');
const { evaluateBarrierSignal } = require('./modules/barrierSignal');
const { evaluateMicrostructureSignal, computeFlowImbalance } = require('./modules/microstructureSignal');
const { evaluateTrendFollowingSignal } = require('./modules/trendFollowingSignal');
const {
  evaluatePairsSignal,
  parsePairDefinitions,
  buildPartnerIndex,
} = require('./modules/pairsSignal');
const {
  parseAllowedHoursSpec,
  evaluateTimeOfDayFilter,
} = require('./modules/timeOfDayFilter');
const { fetchRecentTrades } = require('./modules/cryptoTrades');
const { createShadowTracker: createMicroFlowShadowTracker } = require('./modules/microstructureFlowShadow');
const marketRegimeDetector = require('./modules/marketRegimeDetector');
const regimeVetoEvaluator = require('./modules/regimeVetoEvaluator');
const staleQuoteRetryStatsModule = require('./modules/staleQuoteRetryStats');
const { createSpreadSuppressionTracker } = require('./modules/spreadSuppression');
const makerFillTracker = require('./modules/makerFillTracker');
const { createRetryTracker: createStaleQuoteRetryTracker } = staleQuoteRetryStatsModule;
const { evaluateRecentHighGate } = require('./modules/recentHighGate');
const tradeForensics = require('./modules/tradeForensics');
const { buildFeatureSnapshot } = require('./modules/featureLibrary');
const closedTradeStats = require('./modules/closedTradeStats');
const gateRejectionAudit = require('./modules/gateRejectionAudit');
const coinbaseQuotesStream = require('./modules/coinbaseQuotesStream');
const secondaryFeedShadow = require('./modules/secondaryFeedShadow');
const crossVenueGate = require('./modules/crossVenueGate');
const staleQuoteRescue = require('./modules/staleQuoteRescue');
const explorationBudget = require('./modules/explorationBudget');
// Binance.US execution adapter (2026-05-21). Dormant when EXECUTION_VENUE='alpaca'
// (the code default). When operator flips EXECUTION_VENUE='binance_us' in Render
// env, the venue dispatcher routes order primitives through binanceExecution
// instead of the inline Alpaca calls. Phase 2 (2026-05-21 PM) extends the
// dispatch to the data path: fetchCryptoBars + fetchCryptoQuotes route to
// binanceMarketData when venue=binance_us, so Alpaca credentials become
// optional (validateEnv enforces this). Phase 2 ships with Binance.US's
// public REST endpoints (/api/v3/klines, /api/v3/ticker/bookTicker — no
// auth needed) so an operator running on Binance.US can boot with only
// BINANCE_US_API_KEY/SECRET and zero Alpaca env vars.
const binanceExecution = require('./modules/binanceExecution');
const binanceSymbols = require('./modules/binanceSymbols');
const binanceMarketData = require('./modules/binanceMarketData');
const EXECUTION_VENUE = String(process.env.EXECUTION_VENUE || 'alpaca').toLowerCase();
const IS_BINANCE_EXECUTION = EXECUTION_VENUE === 'binance_us';
const SECONDARY_FEED_ENABLED_TRADE = String(
  process.env.SECONDARY_FEED_ENABLED || 'false',
).toLowerCase() === 'true';
// Phase B gate. Default-OFF — shadow-mode observation only. Operator flips
// CROSS_VENUE_GATE_ENABLED=true in Render env after `meta.crossVenueGate`
// accumulates enough wouldHaveRejected events to validate the threshold.
const CROSS_VENUE_GATE_ENABLED = String(
  process.env.CROSS_VENUE_GATE_ENABLED || 'false',
).toLowerCase() === 'true';
const CROSS_VENUE_MAX_DIVERGENCE_BPS = Math.max(
  0,
  Number(process.env.CROSS_VENUE_MAX_DIVERGENCE_BPS) || 25,
);
const CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS = Math.max(
  0,
  Number(process.env.CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS) || 10000,
);
// Stale-quote rescue (Phase B follow-up). Default-OFF — operator flips
// STALE_QUOTE_RESCUE_ENABLED=true in Render env after `meta.staleQuoteRescue`
// shows reasonable wouldHaveRescued counts. Reuses the cross-venue divergence
// threshold (same physical concept: are the two venues agreeing on price?).
const STALE_QUOTE_RESCUE_ENABLED = String(
  process.env.STALE_QUOTE_RESCUE_ENABLED || 'false',
).toLowerCase() === 'true';

// Attempt to rescue a quote that would otherwise be rejected with stale_quote
// or pruned_stale_quotes. Always records the would-have-rescued counter (so
// operator can observe the rescue's potential impact in shadow mode); only
// returns `{ rescued: true }` when STALE_QUOTE_RESCUE_ENABLED is on AND the
// rescue decision is favourable. Caller wraps the existing rejectTrade call
// with this check.
function tryStaleQuoteRescue(pair, alpacaQuote, rejectionReason) {
  if (!SECONDARY_FEED_ENABLED_TRADE) return { rescued: false };
  let decision = null;
  try {
    const coinbaseQuote = coinbaseQuotesStream.getLatestQuote(pair);
    decision = staleQuoteRescue.evaluateStaleQuoteRescue({
      alpacaQuote,
      coinbaseQuote,
      rejectionReason,
      maxDivergenceBps: CROSS_VENUE_MAX_DIVERGENCE_BPS,
      minCoinbaseFreshnessMs: CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS,
    });
    staleQuoteRescue.record({
      symbol: pair,
      decision,
      rescueEnabled: STALE_QUOTE_RESCUE_ENABLED,
    });
  } catch (_) {
    // Rescue eval must never break the scan. Fall through to rejection.
  }
  if (!decision || !decision.rescued) return { rescued: false };
  return { rescued: STALE_QUOTE_RESCUE_ENABLED, evidence: decision.evidence };
}
const { createQuoteFreshnessTracker } = require('./modules/quoteFreshnessTracker');

const runtimeConfig = getRuntimeConfig(process.env);

// --- env / config ---------------------------------------------------------

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function readList(name, fallback = []) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback.slice();
  return raw.split(',').map((v) => normalizePair(v.trim()) || v.trim()).filter(Boolean);
}

function readEnum(name, allowed, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : fallback;
}

// Entry price mode (Fix 1). Live scorecard showed an avg entry spread of ~29
// bps and the buy lifting the ask — half the spread is paid as cost on every
// trade. 'mid' rests the buy at (bid+ask)/2; 'bid_plus_tick' rests one tick
// above bid (most passive). 'ask' restores the original cross-the-spread
// behaviour. Reposting a passive buy that doesn't fill is handled by
// ENTRY_FILL_TIMEOUT_MS below.
const ENTRY_LIMIT_PRICE_MODE = readEnum('ENTRY_LIMIT_PRICE_MODE', ['ask', 'mid', 'bid_plus_tick'], 'mid');
// Post-only entries (2026-06-08, default OFF). When true, entry orders go in as
// Binance LIMIT_MAKER — the exchange rejects them if they would cross, so the
// fill is GUARANTEED maker (never pays taker / never crosses the spread). This
// is the execution half of the BTC lead-lag rebuild: the +7.6bps edge only
// survives if we don't cross a ~17bps spread (docs/PROFITABILITY_ANALYSIS_2026
// -06.md). Pairs naturally with ENTRY_LIMIT_PRICE_MODE=bid_plus_tick (rests
// below the ask so it is never rejected for crossing). At 'mid' on a 1-tick
// book a post-only order may be rejected — that is a safe no-op (no entry that
// scan), not an error. Left OFF so existing behavior is byte-for-byte unchanged
// until an operator opts in.
const ENTRY_POST_ONLY = readBoolean('ENTRY_POST_ONLY', false);
// Cancel-the-buy-if-not-filled timeout (Fix 1). The mid/bid_plus_tick modes
// require active management — if the market runs away, we don't want a stale
// passive buy filling minutes later at a no-longer-edge price. Default 30 s.
// Set to 0 to disable (passive buy rests until the staircase exit logic
// detects it on a held position — not recommended outside backtest parity).
const ENTRY_FILL_TIMEOUT_MS = Math.max(0, readNumber('ENTRY_FILL_TIMEOUT_MS', 30000));
// 2026-05-31 stop-the-bleed: re-fetch a fresh single-symbol quote at the top of
// each per-symbol entry evaluation instead of trusting the batch-prefetched
// quote. Binance.US bookTicker carries no server timestamp, so a prefetched
// quote's measured age is just scan-loop latency (the live snapshot showed an
// ~8,500 ms avg quote age at entry). Re-quoting makes the freshness gate, the
// spread gate, and the entry price act on a current book. Default ON; set
// ENTRY_FRESH_REQUOTE=false to restore the prefetch-trusting path.
const ENTRY_FRESH_REQUOTE = readBoolean('ENTRY_FRESH_REQUOTE', true);
// 2026-05-31 stop-the-bleed: a HARD liquidity allowlist intersected into the
// live universe (see scanAndEnter). Enforced in code so a stale Render
// ENTRY_SYMBOLS_PRIMARY override can never re-admit the thin-book losers the
// audit flagged. Empty list = no intersection (legacy behaviour).
const ENTRY_UNIVERSE_HARD_ALLOWLIST = readList('ENTRY_UNIVERSE_HARD_ALLOWLIST', []);
const ENTRY_UNIVERSE_HARD_ALLOWLIST_SET = new Set(ENTRY_UNIVERSE_HARD_ALLOWLIST);
// Fix 2: refuse entries whose own projection doesn't cover the gross target
// we'd need to hit TP. Live forensics: projected 38 bps move into a 48 bps
// gross target — we were asking the market for more than the model itself
// predicted. Default ON; set to false to revert.
const ENFORCE_PROJECTED_COVERS_GROSS = readBoolean('ENFORCE_PROJECTED_COVERS_GROSS', true);

// Target NET profit per trade, in basis points. Sell limit is placed at
// entry * (1 + (TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP) / 10000) so the
// target is AFTER fees, not before. This is a *scalper*: target small,
// take many bites. Allowed range 5..50 bps net (= 0.05%..0.50% net of fees);
// raise this above 50 only with deliberate intent — wider targets fill less
// often and break the small-win/small-stop symmetry. Default lowered from
// 15 to 8 bps net so the SIGNAL_TARGET_FRACTION multiplier (see
// deriveSignalTargetNetBps below) actually has room to bite for typical
// projections; with the old 15-bps floor the fractional formula was a no-op.
const TARGET_NET_PROFIT_BPS = Math.min(50, Math.max(5, readNumber('TARGET_NET_PROFIT_BPS', 8)));
// Round-trip crypto trading fees, in basis points. Default depends on the
// execution venue:
//   - alpaca (default): 30 bps round-trip. Alpaca crypto maker-maker is
//     ~10-15 bps per side at the lowest tier (~$84 account → lowest tier).
//   - binance_us: 2 bps round-trip. Binance.US slashed fees in April 2026
//     to 0% maker / 0.0095% taker. Bot is maker on both legs at TP exit
//     (entry: bid+tick rest, exit: GTC sell at TP) = 0 bps round-trip on
//     clean wins. Stops fire as IOC (taker) → 0.95 bps on Tier 0 pairs
//     or 1.9 bps on Tier I. Default 2 is the conservative "stops occasionally
//     fire on a Tier I pair" assumption. Tighten to 1 if dashboard shows
//     mostly-maker fills; widen if Tier I pairs dominate stops.
// Operator can override via FEE_BPS_ROUND_TRIP env var at any time.
const EXECUTION_VENUE_FOR_FEE_DEFAULT = String(process.env.EXECUTION_VENUE || 'alpaca').toLowerCase();
const FEE_BPS_DEFAULT = EXECUTION_VENUE_FOR_FEE_DEFAULT === 'binance_us' ? 2 : 30;
const FEE_BPS_ROUND_TRIP = Math.max(0, readNumber('FEE_BPS_ROUND_TRIP', FEE_BPS_DEFAULT));
// Gross upward move the sell limit requires above entry.
const GROSS_TARGET_BPS = TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP;
// Safety buffer, in basis points. Used only for the entry edge gate.
// The gate requires GROSS_TARGET_BPS >= spread + FEE_BPS_ROUND_TRIP + buffer,
// which simplifies to spread <= TARGET_NET_PROFIT_BPS - PROFIT_BUFFER_BPS.
// With TARGET=20 and buffer=5, the effective spread headroom is 15 bps —
// inside the explicit SPREAD_MAX_BPS=30 hard cap, while still letting most
// liquid pairs clear the gate during normal book conditions.
// MIN_NET_EDGE_BPS remains the real EV filter on top of this.
const PROFIT_BUFFER_BPS = Math.max(0, readNumber('PROFIT_BUFFER_BPS', 5));
const DYNAMIC_BUFFER_MIN_BPS = Math.max(0, readNumber('DYNAMIC_BUFFER_MIN_BPS', 2));
const DYNAMIC_BUFFER_MAX_BPS = Math.max(DYNAMIC_BUFFER_MIN_BPS, readNumber('DYNAMIC_BUFFER_MAX_BPS', 5));
const LOW_VOL_BPS = Math.max(1, readNumber('LOW_VOL_BPS', 20));
const HIGH_VOL_BPS = Math.max(LOW_VOL_BPS + 1, readNumber('HIGH_VOL_BPS', 80));
// Fraction of account equity to deploy per trade (e.g. 0.10 = 10%).
const PORTFOLIO_SIZING_PCT = Math.max(0, readNumber('PORTFOLIO_SIZING_PCT', 0.10));
// Floor below which we won't send a buy (dust). Alpaca's crypto min notional
// is typically $1; keep a small default so the last slot can still fill even
// when cash has drifted just under 10% of equity.
const MIN_TRADE_NOTIONAL_USD = Math.max(0.01, readNumber('MIN_TRADE_NOTIONAL_USD', 1));
// Sizing-floor gate. When > 0, refuse entries whose cash-clamped notional is
// below this fraction of the equity-derived target. Live diagnostics observed
// fragmented-cash entries firing at ~$1.78 (19% of a ~$9.23 target) and
// turning into the worst-percent loss in the book; the bot should wait for
// cash to free up properly rather than deploy a quarter-sized position.
// Set to 0 to revert to the legacy "fill any size above MIN_TRADE_NOTIONAL_USD"
// behavior. Capped at 1 because exceeding the target is impossible (the cash
// clamp only ever shrinks notional, never grows it).
const MIN_SIZING_FRACTION_OF_TARGET = Math.min(
  1,
  Math.max(0, readNumber('MIN_SIZING_FRACTION_OF_TARGET', 0.6)),
);
// Concurrency is now bounded by available cash, not a fixed slot count: the
// engine opens as many positions as PORTFOLIO_SIZING_PCT of equity will fund,
// one per symbol. There is intentionally no MAX_CONCURRENT_POSITIONS cap.

// If the take-profit hasn't filled within BREAKEVEN_TIMEOUT_MS of the position
// being first observed, the staircase walks the sell limit down to
// break-even-after-fees so the slot recycles. Default tightened from 2 h →
// 45 min: the operator target is +1%/day via tiny scalps, so any position
// that hasn't resolved in 45 min has missed its intended micro-move and
// should pin to break-even (and let the stop or max-hold close the trade)
// rather than tie up capital. Also used as BARRIER_HORIZON_BARS for the
// closed-form fill-probability gate (smaller value → tighter probability →
// fewer entries — intended effect). Floor at 30 s to stay above broker
// round-trip latency.
const BREAKEVEN_TIMEOUT_MS = Math.max(30000, readNumber('BREAKEVEN_TIMEOUT_MS', 2700000));
// Multi-factor signal's staircase-decay timeout. MF's wider TP (40-150 bps
// net) needs more time for the pullback-in-uptrend signal to develop. The
// OLS-tuned 45 min would force MF positions to pin at break-even before
// price has the σ-time to reach a 80+ bps gross target. Default 3 h matches
// the original wider-payoff intent documented in the rewrite plan.
const MF_BREAKEVEN_TIMEOUT_MS = Math.max(30000, readNumber('MF_BREAKEVEN_TIMEOUT_MS', 10800000));
// Hard time-based market exit (Fix 3). After MAX_HOLD_MS the exit manager
// cancels any resting GTC sell and submits a market IOC sell — actually
// closes positions that never tripped the stop and never hit the TP, instead
// of letting them sit at a break-even-pinned staircase forever. Default
// tightened from 6 h → 90 min: scalps that haven't resolved in 90 min are
// failing the strategy thesis — recycle the capital instead of paying the
// MTM tail. Set to 0 to disable.
const MAX_HOLD_MS = Math.max(0, readNumber('MAX_HOLD_MS', 5400000));
// Multi-factor signal's hard max-hold. MF's wider TP target means a 90-min
// max-hold cuts most trades off before they have time to resolve. The May
// 2026 auto-backtest observed 45.8% max_hold rate at 90 min, dragging MF
// expectancy to -61 bps. Default 6 h matches the strategy's original design.
const MF_MAX_HOLD_MS = Math.max(0, readNumber('MF_MAX_HOLD_MS', 21600000));
// Mean-reversion exit timing: tight. The strategy thesis is "reversion
// happens fast or it doesn't." 45-min max-hold + 30-min staircase decay
// matches MR's expected fill window. If the bounce hasn't materialised
// in 30 min, it isn't coming — pin at break-even and let the stop or
// max-hold close out.
const MR_MAX_HOLD_MS = Math.max(0, readNumber('MR_MAX_HOLD_MS', 2700000));     // 45 min
const MR_BREAKEVEN_TIMEOUT_MS = Math.max(30000, readNumber('MR_BREAKEVEN_TIMEOUT_MS', 1800000));  // 30 min

// BTC lead-lag exit timing (2026-06-08, docs/PROFITABILITY_ANALYSIS_2026-06.md).
// The lead-lag catch-up plays out in ~5 minutes; the sandbox edge came from a
// short time-bounded hold. So: short max-hold, fast breakeven decay, a TIGHT
// protective stop (cut the trade if BTC reverses) and a TP from the projected
// catch-up. This is the inverted-exit shape (let the catch-up run on a short
// clock, cut losers fast) vs the legacy small-TP/huge-SL bleed.
const BLL_MAX_HOLD_MS = Math.max(60000, readNumber('BLL_MAX_HOLD_MS', 360000));          // 6 min
const BLL_BREAKEVEN_TIMEOUT_MS = Math.max(30000, readNumber('BLL_BREAKEVEN_TIMEOUT_MS', 300000)); // 5 min
const BLL_STOP_LOSS_BPS = Math.max(1, readNumber('BLL_STOP_LOSS_BPS', 25));
const BLL_TARGET_NET_PROFIT_BPS_FLOOR = Math.max(1, readNumber('BLL_TARGET_NET_PROFIT_BPS_FLOOR', 10));
const BLL_SIGNAL_TARGET_MAX_NET_BPS = Math.max(BLL_TARGET_NET_PROFIT_BPS_FLOOR, readNumber('BLL_SIGNAL_TARGET_MAX_NET_BPS', 60));

// Signal-aware exit timing helpers. The live exit manager and the
// computeStaircaseExitGrossBps function consult these via the position's
// signal version (recorded in tradePredictions at entry time).
function getMaxHoldMsForSignal(signalVersion) {
  if (signalVersion === 'multi_factor') return MF_MAX_HOLD_MS;
  if (signalVersion === 'mean_reversion'
      || signalVersion === 'mean_reversion_5m'
      || signalVersion === 'mean_reversion_15m') return MR_MAX_HOLD_MS;
  if (signalVersion === 'range_mean_reversion') return RANGE_MR_MAX_HOLD_MS;
  if (signalVersion === 'barrier') return BARRIER_MAX_HOLD_MS;
  if (signalVersion === 'microstructure_5m'
      || signalVersion === 'microstructure_15m'
      || signalVersion === 'microstructure_30m'
      || signalVersion === 'microstructure_45m') return MICRO_MAX_HOLD_MS;
  if (signalVersion === 'trend_following') return TREND_FOLLOWING_MAX_HOLD_MS;
  if (signalVersion === 'pairs') return PAIRS_MAX_HOLD_MS;
  if (signalVersion === 'btc_lead_lag') return BLL_MAX_HOLD_MS;
  return MAX_HOLD_MS;
}
function getBreakevenTimeoutMsForSignal(signalVersion) {
  if (signalVersion === 'multi_factor') return MF_BREAKEVEN_TIMEOUT_MS;
  if (signalVersion === 'mean_reversion'
      || signalVersion === 'mean_reversion_5m'
      || signalVersion === 'mean_reversion_15m') return MR_BREAKEVEN_TIMEOUT_MS;
  if (signalVersion === 'range_mean_reversion') return RANGE_MR_BREAKEVEN_TIMEOUT_MS;
  if (signalVersion === 'barrier') return BARRIER_BREAKEVEN_TIMEOUT_MS;
  if (signalVersion === 'microstructure_5m'
      || signalVersion === 'microstructure_15m'
      || signalVersion === 'microstructure_30m'
      || signalVersion === 'microstructure_45m') return MICRO_BREAKEVEN_TIMEOUT_MS;
  if (signalVersion === 'trend_following') return TREND_FOLLOWING_BREAKEVEN_TIMEOUT_MS;
  if (signalVersion === 'pairs') return PAIRS_BREAKEVEN_TIMEOUT_MS;
  if (signalVersion === 'btc_lead_lag') return BLL_BREAKEVEN_TIMEOUT_MS;
  return BREAKEVEN_TIMEOUT_MS;
}
// Stop-loss is ON by default — matches LIVE_CRITICAL_DEFAULTS. The original
// strategy intent (CLAUDE.md hard rule #5) walked the GTC sell limit toward
// break-even-after-fees so realized P&L was bounded at $0 net; in practice the
// strategy's own simulate_strategy.js shows that asymmetry produces strongly
// negative expectancy in flat/adverse drift because stuck positions accumulate
// unbounded unrealized MTM. The vol-scaled stop below caps that tail: tight
// stops in quiet markets, wider stops in vol — same risk in σ-units regardless
// of regime, never wider than STOP_LOSS_BPS. Set STOP_LOSS_ENABLED=false on
// Render to revert to the no-realised-loss design.
const STOP_LOSS_ENABLED = readBoolean('STOP_LOSS_ENABLED', true);
// Default tightened to 35 bps (was 40 after Fix 4, originally 100). At
// +8 bps net TP / −35 bps stop the strategy needs ~82% win rate to break
// even on the realised-loss path; the staircase and break-even floor cap
// the rest of the tail. Vol-scaled stop usually picks a value well below
// this cap; this is only the ceiling.
const STOP_LOSS_BPS = Math.max(1, readNumber('STOP_LOSS_BPS', 35));
// Multi-factor signal stop-loss cap. When SIGNAL_VERSION='multi_factor', the
// per-trade vol-scaled stop is capped at this value instead of STOP_LOSS_BPS.
// Default 100 bps matches the wider TP target the new signal uses (40-150 bps
// net), preserving a reasonable R:R that the OLS-tuned 40 bps cap would
// instantly invert. Read once at startup; no effect when SIGNAL_VERSION='ols'.
const MF_STOP_LOSS_BPS = Math.max(1, readNumber('MF_STOP_LOSS_BPS', 100));
// Volatility-scaled stop. When ON, each trade's stop distance is sized from
// the entry-time realised volatility: stopBps ≈ k × σ × √HORIZON. Quiet
// markets get tight stops, wild markets get loose ones — same risk in
// σ-units regardless of regime. Floor protects against vol-calc collapse in
// dead markets; cap is the static STOP_LOSS_BPS so worst case = today.
const VOL_SCALED_STOP_ENABLED = readBoolean('VOL_SCALED_STOP_ENABLED', true);
const STOP_LOSS_VOL_K = Math.max(0.1, readNumber('STOP_LOSS_VOL_K', 1.0));
const STOP_LOSS_HORIZON_BARS = Math.max(1, readNumber('STOP_LOSS_HORIZON_BARS', 60));
// Lowered from 20 → 15 bps to match the tighter STOP_LOSS_BPS cap (Fix 4).
const STOP_LOSS_BPS_FLOOR = Math.max(1, readNumber('STOP_LOSS_BPS_FLOOR', 15));
// Buffer below the bid-side spread that the stop must always preserve.
// The stop check fires when bid <= avg_entry × (1 - stopBps/10000), but
// avg_entry is the ASK we paid — so the bid sits one spread below ask
// from the moment the buy fills. If stopBps < spreadBps, the bid is
// already past the stop on entry and the stop fires instantly. This
// floor enforces stopBps >= spreadBps + STOP_OVER_SPREAD_BPS so there
// is always at least N bps of room below the bid before the stop trips.
const STOP_OVER_SPREAD_BPS = Math.max(0, readNumber('STOP_OVER_SPREAD_BPS', 20));
// Mean-reversion stop-loss cap. Tight by design: mean reversion either
// happens fast or fails fast. 60 bps cap = ~2× typical drop trigger × 0.3
// = enough room for the trade to breathe without absorbing a full
// continuation move on tier-1/2 deep-liquidity pairs.
//
// Tier-3 (long-tail alts) carry wider spreads (~70-90 bps) and noisier
// post-drop microstructure. The spread floor in this function already
// pushes their effective stop to ~spread+20 bps, but the cap also needs
// to be wide enough to let vol-scaled stops scale above the spread floor
// without being clipped to 60. MR_STOP_LOSS_BPS_TIER3 (default 100) is
// the cap consulted when the symbol resolves to tier3.
const MR_STOP_LOSS_BPS = Math.max(1, readNumber('MR_STOP_LOSS_BPS', 60));
const MR_STOP_LOSS_BPS_TIER3 = Math.max(MR_STOP_LOSS_BPS, readNumber('MR_STOP_LOSS_BPS_TIER3', 100));

// Per-timeframe MR stop caps (2026-05-17 Stage 3 plumbing). The 5m / 15m MR
// variants currently lose money in backtest with stop_loss ~41% of fills at
// the 60-bps tier-1/2 cap (live 30-day stats: MR-5m -32.6 bps net, MR-15m
// -29.2 bps net). Widening the stop for the coarser timeframes is the only
// move that could flip them positive without lowering MR_DROP_TRIGGER_BPS
// (the in-code A/B forbids the latter). Defaults mirror the 1m cap exactly
// so wiring is zero-behavior-change until an operator sets one in Render
// env. Always validate a knob flip with the per-timeframe backtest URL:
//   /debug/backtest?days=90&refresh=true&strategy=mean_reversion&mrTimeframe=5m&mrStopLossBps5m=100
const MR_STOP_LOSS_BPS_5M = Math.max(1, readNumber('MR_STOP_LOSS_BPS_5M', MR_STOP_LOSS_BPS));
const MR_STOP_LOSS_BPS_5M_TIER3 = Math.max(MR_STOP_LOSS_BPS_5M, readNumber('MR_STOP_LOSS_BPS_5M_TIER3', MR_STOP_LOSS_BPS_TIER3));
const MR_STOP_LOSS_BPS_15M = Math.max(1, readNumber('MR_STOP_LOSS_BPS_15M', MR_STOP_LOSS_BPS));
const MR_STOP_LOSS_BPS_15M_TIER3 = Math.max(MR_STOP_LOSS_BPS_15M, readNumber('MR_STOP_LOSS_BPS_15M_TIER3', MR_STOP_LOSS_BPS_TIER3));

// Mean-reversion signal sub-gate knobs (2026-05-17). These were previously
// hard-coded as DEFAULT_CONFIG in modules/meanReversionSignal.js. The defaults
// here mirror DEFAULT_CONFIG exactly, so wiring them is a zero-behavior-change
// op until an operator sets one in Render env. DO NOT lower MR_DROP_TRIGGER_BPS
// below 100 — the in-code A/B (meanReversionSignal.js:44-50) shows the loosened
// 80-bps trigger flipped expectancy from +14.91 to -24 bps net. The other four
// knobs (volume / BTC-corr / RSI / deep-drop) have no comparable live A/B yet
// and are the safer tuning targets for the Stage 2 trade-frequency push.
const MR_DROP_TRIGGER_BPS = Math.max(1, readNumber('MR_DROP_TRIGGER_BPS', 100));
const MR_VOL_CONFIRM_MULTIPLIER = Math.max(0, readNumber('MR_VOL_CONFIRM_MULTIPLIER', 1.5));
const MR_MAX_BTC_DROP_BPS = Math.max(0, readNumber('MR_MAX_BTC_DROP_BPS', 50));
const MR_RSI_OVERSOLD = Math.max(1, Math.min(99, readNumber('MR_RSI_OVERSOLD', 30)));
const MR_DEEP_DROP_GUARD_BPS = Math.max(1, readNumber('MR_DEEP_DROP_GUARD_BPS', 300));
const MR_SIGNAL_CONFIG_OVERRIDES = Object.freeze({
  dropTriggerBps: MR_DROP_TRIGGER_BPS,
  volConfirmMultiplier: MR_VOL_CONFIRM_MULTIPLIER,
  maxBtcDropBps: MR_MAX_BTC_DROP_BPS,
  rsiOversold: MR_RSI_OVERSOLD,
  deepDropGuardBps: MR_DEEP_DROP_GUARD_BPS,
});

// BTC lead-lag signal config (2026-06-08). Operator-tunable knobs over the
// module's DEFAULT_CONFIG. Only keys present here override; the rest fall back
// to the module defaults. Thresholds chosen from the 60-day sandbox sweep
// (BTC ret>=30bps lead, alt still <60% caught up).
const BLL_SIGNAL_CONFIG_OVERRIDES = Object.freeze({
  btcMinReturnBps: readNumber('BLL_BTC_MIN_RETURN_BPS', 30),
  btcMaxAgeMs: Math.max(5000, readNumber('BLL_BTC_MAX_AGE_MS', 90000)),
  maxCatchupFraction: readNumber('BLL_MAX_CATCHUP_FRACTION', 0.6),
  captureFraction: readNumber('BLL_CAPTURE_FRACTION', 0.5),
  minProjectedBps: readNumber('BLL_MIN_PROJECTED_BPS', 12),
});

// Phase 1: master kill switch + per-layer feature flags. PHASE1_ENABLED=false
// reverts every Phase 1 layer to its legacy behavior in a single env flip.
// Per-layer flags compose with the master flag (AND-gated), so an operator
// can disable a single layer without touching the others.
const PHASE1_ENABLED = readBoolean('PHASE1_ENABLED', true);
const RANGE_MR_ENABLED = PHASE1_ENABLED && readBoolean('RANGE_MR_ENABLED', true);
const ADAPTIVE_SIZING_ENABLED = PHASE1_ENABLED && readBoolean('ADAPTIVE_SIZING_ENABLED', true);
const CONCURRENT_POSITIONS_SOFT_CAP_ENABLED = PHASE1_ENABLED && readBoolean('CONCURRENT_POSITIONS_SOFT_CAP_ENABLED', true);
const MAX_CONCURRENT_POSITIONS_SOFT_CAP = Math.max(0, readNumber('MAX_CONCURRENT_POSITIONS_SOFT_CAP', 8));
// Adaptive sizing: caps the upper bound of the per-trade sizing multiplier.
// MAX_SIZING_FRACTION_OF_TARGET=1.5 means a high-confidence trigger can
// deploy up to 1.5× the base PORTFOLIO_SIZING_PCT (e.g. 15% of equity at
// the default 10% base). Bounded conservatively because backtest evidence
// for the new signal classes is still thin.
const MAX_SIZING_FRACTION_OF_TARGET = Math.max(1.0, readNumber('MAX_SIZING_FRACTION_OF_TARGET', 1.5));

// Conviction engine (2026-06-08). Turns the active signal + market regime + the
// signal's recent LIVE realized edge into a 0..1 conviction score, then (a) sits
// out marginal setups (selectivity) and (b) sizes the A+ setups up within the
// MAX_SIZING_FRACTION_OF_TARGET cap. A pure GATE in front of the entry path — it
// never relaxes any safety (breaker/spread/freshness all still apply); it can
// only make the bot pickier and lean winners up. See modules/convictionEngine.js.
const CONVICTION_ENGINE_ENABLED = readBoolean('CONVICTION_ENGINE_ENABLED', true);
const CONVICTION_CONFIG_OVERRIDES = Object.freeze({
  minConviction: readNumber('CONVICTION_MIN', convictionEngine.DEFAULT_CONFIG.minConviction),
  maxSizeMult: Math.max(1.0, readNumber('CONVICTION_MAX_SIZE_MULT', MAX_SIZING_FRACTION_OF_TARGET)),
  edgeScaleBps: readNumber('CONVICTION_EDGE_SCALE_BPS', convictionEngine.DEFAULT_CONFIG.edgeScaleBps),
  projRefBps: readNumber('CONVICTION_PROJ_REF_BPS', convictionEngine.DEFAULT_CONFIG.projRefBps),
  // 'adverse' hard-veto on by default; set CONVICTION_HARD_VETO_REGIMES='' to clear.
  hardVetoRegimes: String(process.env.CONVICTION_HARD_VETO_REGIMES ?? 'adverse')
    .split(',').map((s) => s.trim()).filter(Boolean),
});
// Rolling conviction telemetry for the dashboard (observational; no gate reads it).
let lastConvictionState = null;
const convictionCounters = { evaluated: 0, entered: 0, satOut: 0, regimeVetoed: 0, sumConviction: 0 };
function recordConvictionObservation(result) {
  if (!result) return;
  lastConvictionState = {
    conviction: result.conviction,
    enter: result.enter,
    sizeMultiplier: result.sizeMultiplier,
    reason: result.reason,
    components: result.components,
    at: new Date().toISOString(),
  };
  convictionCounters.evaluated += 1;
  if (Number.isFinite(result.conviction)) convictionCounters.sumConviction += result.conviction;
  if (result.enter) convictionCounters.entered += 1;
  else if (String(result.reason || '').startsWith('regime_veto')) convictionCounters.regimeVetoed += 1;
  else convictionCounters.satOut += 1;
}
function getConvictionState() {
  const n = convictionCounters.evaluated || 0;
  return {
    enabled: CONVICTION_ENGINE_ENABLED,
    minConviction: CONVICTION_CONFIG_OVERRIDES.minConviction,
    maxSizeMult: CONVICTION_CONFIG_OVERRIDES.maxSizeMult,
    last: lastConvictionState,
    evaluated: n,
    entered: convictionCounters.entered,
    satOut: convictionCounters.satOut,
    regimeVetoed: convictionCounters.regimeVetoed,
    selectivityRate: n > 0 ? (convictionCounters.satOut + convictionCounters.regimeVetoed) / n : null,
    avgConviction: n > 0 ? convictionCounters.sumConviction / n : null,
  };
}

// Range mean-reversion env knobs.
const RANGE_MR_TARGET_NET_PROFIT_BPS_FLOOR = Math.max(1, readNumber('RANGE_MR_TARGET_NET_BPS_FLOOR', 5));
const RANGE_MR_SIGNAL_TARGET_MAX_NET_BPS = Math.max(
  RANGE_MR_TARGET_NET_PROFIT_BPS_FLOOR,
  readNumber('RANGE_MR_SIGNAL_TARGET_MAX_NET_BPS', 60),
);
const RANGE_MR_STOP_LOSS_BPS = Math.max(1, readNumber('RANGE_MR_STOP_LOSS_BPS', 40));
const RANGE_MR_MAX_HOLD_MS = Math.max(60_000, readNumber('RANGE_MR_MAX_HOLD_MS', 1_800_000));
const RANGE_MR_BREAKEVEN_TIMEOUT_MS = Math.max(30_000, readNumber('RANGE_MR_BREAKEVEN_TIMEOUT_MS', 900_000));

// Barrier signal exit-timing knobs. The signal targets a larger net TP
// (default 100 bps) than MR/Range-MR and uses a vol-scaled stop sized for
// barrier-touch probability. Hold timing matches the multi-factor signal
// because the per-trade target magnitude is similar (~100 bps gross). The
// stop cap is wider than the OLS default since the TP is also wider — a
// 35 bps stop against a 100 bps target instantly inverts the R:R.
const BARRIER_STOP_LOSS_BPS = Math.max(1, readNumber('BARRIER_STOP_LOSS_BPS', 100));
const BARRIER_MAX_HOLD_MS = Math.max(60_000, readNumber('BARRIER_MAX_HOLD_MS', 21_600_000));     // 6 h
const BARRIER_BREAKEVEN_TIMEOUT_MS = Math.max(30_000, readNumber('BARRIER_BREAKEVEN_TIMEOUT_MS', 10_800_000));  // 3 h
// Barrier signal internal knobs — previously documented in README/CLAUDE.md
// as tunable but hardcoded in barrierSignal.js's DEFAULT_CONFIG. Wired
// here so the doc claim "BARRIER_DESIRED_NET_BPS=100 default" is honest.
// Defaults mirror DEFAULT_CONFIG so unset env behaves identically to the
// pure module config (zero-behavior-change unless an operator sets one).
const BARRIER_DESIRED_NET_BPS = Math.max(1, readNumber('BARRIER_DESIRED_NET_BPS', 100));
const BARRIER_EV_MIN_BPS = readNumber('BARRIER_EV_MIN_BPS', -1);

// Microstructure signal env knobs. Per-horizon TP target + stop floor mirror
// the module's HORIZON_DEFAULTS so an operator-unset env behaves identically
// to the pure module config. Hold-times match barrier (6 h max, 3 h
// break-even decay) since the per-trade target magnitude (40–100 bps net)
// occupies the same band. The four MICRO_HORIZON_*_ENABLED flags gate
// whether each horizon's auto-backtest fires at boot — the SignalSelector
// silently drops un-enabled candidates rather than admitting them via the
// veto bypass.
const MICRO_STOP_LOSS_BPS_5M = Math.max(1, readNumber('MICRO_STOP_LOSS_BPS_5M', 60));
const MICRO_STOP_LOSS_BPS_15M = Math.max(1, readNumber('MICRO_STOP_LOSS_BPS_15M', 80));
const MICRO_STOP_LOSS_BPS_30M = Math.max(1, readNumber('MICRO_STOP_LOSS_BPS_30M', 100));
const MICRO_STOP_LOSS_BPS_45M = Math.max(1, readNumber('MICRO_STOP_LOSS_BPS_45M', 100));
const MICRO_MAX_HOLD_MS = Math.max(60_000, readNumber('MICRO_MAX_HOLD_MS', 21_600_000));            // 6 h
const MICRO_BREAKEVEN_TIMEOUT_MS = Math.max(30_000, readNumber('MICRO_BREAKEVEN_TIMEOUT_MS', 10_800_000));  // 3 h
const MICRO_SPREAD_Z_MAX = readNumber('MICRO_SPREAD_Z_MAX', 1.5);
const MICRO_MIN_PROB = readNumber('MICRO_MIN_PROB', 0.55);
const MICRO_EV_MIN_BPS = readNumber('MICRO_EV_MIN_BPS', 2);
const MICRO_TARGET_NET_BPS_FLOOR = Math.max(1, readNumber('MICRO_TARGET_NET_BPS_FLOOR', 8));
const MICRO_SIGNAL_TARGET_MAX_NET_BPS = Math.max(MICRO_TARGET_NET_BPS_FLOOR, readNumber('MICRO_SIGNAL_TARGET_MAX_NET_BPS', 150));
const MICRO_TRADES_ENABLED = readBoolean('MICRO_TRADES_ENABLED', false);
// Shadow mode (2026-05-20): when true, recent trades are fetched and
// flowImbalance is computed even when MICRO_TRADES_ENABLED=false, but
// the value is observed-only — the live signal scoring path remains
// flow=0 until MICRO_TRADES_ENABLED is flipped explicitly. The shadow
// observations roll into the microstructureFlowShadow tracker so the
// operator can validate the trades feed before flipping the live flag.
// Default on so validation data accumulates automatically.
const MICRO_TRADES_SHADOW_ENABLED = readBoolean('MICRO_TRADES_SHADOW_ENABLED', true);

// Trend-following / breakout signal env knobs (2026-05-28). Mirror the
// module's DEFAULT_CONFIG so an unset env behaves identically to the pure
// module. The selector validates the candidate via auto-backtest before
// admitting it live, so the JS-level defaults here are belt-and-suspenders
// rather than the live source of truth (which is liveDefaults.js).
const TREND_FOLLOWING_LOOKBACK_BARS = Math.max(10, readNumber('TREND_FOLLOWING_LOOKBACK_BARS', 60));
const TREND_FOLLOWING_VOL_MULTIPLIER = readNumber('TREND_FOLLOWING_VOL_MULTIPLIER', 1.3);
const TREND_FOLLOWING_MIN_SLOPE_BPS_PER_BAR = readNumber('TREND_FOLLOWING_MIN_SLOPE_BPS_PER_BAR', 0.5);
const TREND_FOLLOWING_MAX_STRETCH_ABOVE_SMA_BPS = readNumber('TREND_FOLLOWING_MAX_STRETCH_ABOVE_SMA_BPS', 60);
const TREND_FOLLOWING_TARGET_NET_BPS_FLOOR = Math.max(1, readNumber('TREND_FOLLOWING_TARGET_NET_BPS_FLOOR', 15));
const TREND_FOLLOWING_TARGET_NET_BPS_CAP = Math.max(
  TREND_FOLLOWING_TARGET_NET_BPS_FLOOR,
  readNumber('TREND_FOLLOWING_TARGET_NET_BPS_CAP', 80),
);
const TREND_FOLLOWING_STOP_LOSS_BPS = Math.max(1, readNumber('TREND_FOLLOWING_STOP_LOSS_BPS', 60));
const TREND_FOLLOWING_MAX_HOLD_MS = Math.max(60_000, readNumber('TREND_FOLLOWING_MAX_HOLD_MS', 10_800_000));         // 3 h
const TREND_FOLLOWING_BREAKEVEN_TIMEOUT_MS = Math.max(30_000, readNumber('TREND_FOLLOWING_BREAKEVEN_TIMEOUT_MS', 5_400_000)); // 1.5 h

// Pairs / stat-arb signal env knobs.
const PAIRS_LOOKBACK_BARS = Math.max(30, readNumber('PAIRS_LOOKBACK_BARS', 120));
const PAIRS_MIN_R_SQUARED = readNumber('PAIRS_MIN_R_SQUARED', 0.5);
const PAIRS_Z_ENTRY_THRESHOLD = Math.max(0.5, readNumber('PAIRS_Z_ENTRY_THRESHOLD', 2.0));
const PAIRS_FRESHNESS_BARS = Math.max(1, Math.floor(readNumber('PAIRS_FRESHNESS_BARS', 5)));
const PAIRS_TARGET_NET_BPS_FLOOR = Math.max(1, readNumber('PAIRS_TARGET_NET_BPS_FLOOR', 12));
const PAIRS_TARGET_NET_BPS_CAP = Math.max(
  PAIRS_TARGET_NET_BPS_FLOOR,
  readNumber('PAIRS_TARGET_NET_BPS_CAP', 60),
);
const PAIRS_STOP_LOSS_BPS = Math.max(1, readNumber('PAIRS_STOP_LOSS_BPS', 50));
const PAIRS_MAX_HOLD_MS = Math.max(60_000, readNumber('PAIRS_MAX_HOLD_MS', 10_800_000));         // 3 h
const PAIRS_BREAKEVEN_TIMEOUT_MS = Math.max(30_000, readNumber('PAIRS_BREAKEVEN_TIMEOUT_MS', 5_400_000)); // 1.5 h
const PAIRS_DEFINITIONS_RAW = String(process.env.PAIRS_DEFINITIONS ?? '');
const PAIRS_DEFINITIONS_PARSED = parsePairDefinitions(PAIRS_DEFINITIONS_RAW);
const PAIRS_PARTNER_INDEX = buildPartnerIndex(PAIRS_DEFINITIONS_PARSED);

// Time-of-day filter (default '*' = allow all hours). Parsed once at module
// load; reparsed if the env is updated requires a restart. When unparseable
// the schedule fails open (allows everything) so a typo doesn't strand the
// bot — the operator sees the live decision payload's `timeOfDayFilter`
// field always reflects 'filter_disabled' in that case.
const TIME_OF_DAY_FILTER_ENABLED = readBoolean('TIME_OF_DAY_FILTER_ENABLED', true);
const TIME_OF_DAY_ALLOWED_HOURS_RAW = String(process.env.TIME_OF_DAY_ALLOWED_HOURS_UTC ?? '*');
const TIME_OF_DAY_SCHEDULE = parseAllowedHoursSpec(TIME_OF_DAY_ALLOWED_HOURS_RAW) || { allowAll: true };

// Stale-quote single-symbol retry fallback (2026-05-20). When prefetched
// quote ageMs exceeds the stale threshold, retry the symbol with the
// single-symbol /latest/quotes endpoint. Alpaca's bulk endpoint can be
// stale for specific symbols while the single-symbol endpoint returns
// fresher data — observed for ETH/SOL/AVAX/XRP/LTC in the 2026-05-19
// diagnostic snapshot. Default-on; the existing pruner takes over if the
// retry doesn't recover, so worst case is one extra Alpaca call per stale
// symbol per scan. Opt out via STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED=false.
const STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED = readBoolean(
  'STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED', true);
// Auto-suppress (2026-05-20 PM). When a symbol's per-symbol retry recovery
// rate stays at or below STALE_QUOTE_RETRY_AUTO_SUPPRESS_MAX_RECOVERY_RATE
// over ≥ STALE_QUOTE_RETRY_AUTO_SUPPRESS_MIN_ATTEMPTS in the rolling window,
// short-circuit the retry for that symbol — the feed is upstream-stale and
// the API call is wasted. The 2026-05-20 evening snapshot caught 8 symbols
// at < 5% recovery over 38-67 attempts; suppression saves ~50 API calls per
// scan cycle without changing any trade decision (stale_quote rejection still
// fires; only the recovery probe is skipped). Self-healing: the FIFO ages out
// suppressed-symbol entries naturally so feed-recovery is re-detected without
// manual intervention.
const STALE_QUOTE_RETRY_AUTO_SUPPRESS_ENABLED = readBoolean(
  'STALE_QUOTE_RETRY_AUTO_SUPPRESS_ENABLED', true);
const STALE_QUOTE_RETRY_AUTO_SUPPRESS_MIN_ATTEMPTS = Math.max(1, Math.floor(readNumber(
  'STALE_QUOTE_RETRY_AUTO_SUPPRESS_MIN_ATTEMPTS',
  staleQuoteRetryStatsModule.DEFAULT_SUPPRESS_MIN_ATTEMPTS,
)));
const STALE_QUOTE_RETRY_AUTO_SUPPRESS_MAX_RECOVERY_RATE = readNumber(
  'STALE_QUOTE_RETRY_AUTO_SUPPRESS_MAX_RECOVERY_RATE',
  staleQuoteRetryStatsModule.DEFAULT_SUPPRESS_MAX_RECOVERY_RATE,
);

// Market regime detector (Phase 1, 2026-05-20). Observational classifier
// over recent BTC closes — labels current regime (adverse/benign/flat/
// quiet/wild) and surfaces the simulator's expected per-trade bps for
// that regime. NO entry decision reads this in Phase 1; the dashboard
// is the only consumer. Phase 2 (separate PR) wires a regime veto on
// adverse so the bot stops trading when the simulator says expectancy
// is −1382 bps/trade. See backend/modules/marketRegimeDetector.js.
const MARKET_REGIME_DETECTOR_ENABLED = readBoolean('MARKET_REGIME_DETECTOR_ENABLED', true);
const MARKET_REGIME_LOOKBACK_BARS = Math.max(
  2,
  Math.floor(readNumber('MARKET_REGIME_LOOKBACK_BARS', marketRegimeDetector.DEFAULT_LOOKBACK_BARS)),
);
const MARKET_REGIME_BENIGN_DRIFT_BPS_PER_MIN = readNumber(
  'MARKET_REGIME_BENIGN_DRIFT_BPS_PER_MIN',
  marketRegimeDetector.DEFAULT_THRESHOLDS.benignDriftBpsPerMin,
);
const MARKET_REGIME_ADVERSE_DRIFT_BPS_PER_MIN = readNumber(
  'MARKET_REGIME_ADVERSE_DRIFT_BPS_PER_MIN',
  marketRegimeDetector.DEFAULT_THRESHOLDS.adverseDriftBpsPerMin,
);
const MARKET_REGIME_QUIET_SIGMA_BPS_PER_MIN = readNumber(
  'MARKET_REGIME_QUIET_SIGMA_BPS_PER_MIN',
  marketRegimeDetector.DEFAULT_THRESHOLDS.quietSigmaBpsPerMin,
);
const MARKET_REGIME_WILD_SIGMA_BPS_PER_MIN = readNumber(
  'MARKET_REGIME_WILD_SIGMA_BPS_PER_MIN',
  marketRegimeDetector.DEFAULT_THRESHOLDS.wildSigmaBpsPerMin,
);

// Phase 2 regime-aware entry veto (2026-05-20). Opt-in by env. When
// enabled, the entry path refuses entries whose regime label is in
// MARKET_REGIME_VETO_REGIMES and has held for ≥ MARKET_REGIME_VETO_CONSECUTIVE_MS.
// When disabled (the default), the live engine still tracks a
// "wouldHaveVetoed" counter so the operator gets evidence before
// flipping the gate on. See backend/modules/regimeVetoEvaluator.js.
const MARKET_REGIME_VETO_ENABLED = readBoolean('MARKET_REGIME_VETO_ENABLED', false);
const MARKET_REGIME_VETO_REGIMES = String(process.env.MARKET_REGIME_VETO_REGIMES || 'adverse')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MARKET_REGIME_VETO_CONSECUTIVE_MS = Math.max(
  0,
  readNumber('MARKET_REGIME_VETO_CONSECUTIVE_MS', regimeVetoEvaluator.DEFAULT_CONFIG.consecutiveMs),
);
const MARKET_REGIME_VETO_MAX_AGE_MS = Math.max(
  1000,
  readNumber('MARKET_REGIME_VETO_MAX_AGE_MS', regimeVetoEvaluator.DEFAULT_CONFIG.maxSnapshotAgeMs),
);
// Stop = max(stopFloorBps, sigma · MICRO_STOP_VOL_MULT). stopFloorBps
// comes from per-horizon HORIZON_DEFAULTS; this multiplier is shared
// across horizons. Previously hardcoded; wired here so the README claim
// of vol-scaled stops is reflected in env-tunable behaviour.
const MICRO_STOP_VOL_MULT = Math.max(0.1, readNumber('MICRO_STOP_VOL_MULT', 2.5));

// Feature library (2026-05-18) — observational-only logging into the entry
// forensics record. None of these flags gate entries; they only control
// whether the corresponding family of features is computed and written.
const FEATURE_LIBRARY_LOGGING_ENABLED = readBoolean('FEATURE_LIBRARY_LOGGING_ENABLED', true);
const FEATURE_INDICATORS_EXTENDED_ENABLED = readBoolean('FEATURE_INDICATORS_EXTENDED_ENABLED', true);
const FEATURE_STATS_ENABLED = readBoolean('FEATURE_STATS_ENABLED', true);
const FEATURE_STRUCTURE_ENABLED = readBoolean('FEATURE_STRUCTURE_ENABLED', true);

// Gate-rejection audit (2026-05-19) — observational shadow forward-test of
// rejected candidates. When ENABLED, every reject from inside scanAndEnter
// that has a valid quote is captured with its mid-price and signal version;
// the index.js grader fetches the 1m close N minutes later and aggregates
// per-reason forward return so operators can see which gates rejected
// candidates that would have been profitable. NEVER read by the live entry
// path. Set GATE_REJECTION_AUDIT_ENABLED=false in Render env to disable
// capture entirely (the grader in index.js also reads this flag).
const GATE_REJECTION_AUDIT_ENABLED = readBoolean('GATE_REJECTION_AUDIT_ENABLED', true);

// Per-timeframe MR symbol blocklists (2026-05-18). Filtered live; the
// auto-backtest in index.js passes the same blocklists so the selector
// expectancy reflects what the live engine actually trades. Defaults set
// by the live-defaults bootstrap; rationale in liveDefaults.js.
const symbolBlocklist = require('./modules/symbolBlocklist');
const MR_BLOCKLISTS = symbolBlocklist.readMrBlocklistsFromEnv(process.env);
// Per-horizon microstructure blocklists (2026-05-20). Same shared-with-
// backtest pattern as MR_BLOCKLISTS so the auto-backtest result matches
// the live universe. The 30m default in liveDefaults.js seeds the symbols
// flagged catastrophic by the 2026-05-19 diagnostic snapshot.
const MICRO_BLOCKLISTS = symbolBlocklist.readMicroBlocklistsFromEnv(process.env);

function deriveStopLossBps(volatilityBps, spreadBps, signalVersion = 'ols', pair = null) {
  let cap;
  if (signalVersion === 'multi_factor') cap = MF_STOP_LOSS_BPS;
  else if (signalVersion === 'mean_reversion'
      || signalVersion === 'mean_reversion_5m'
      || signalVersion === 'mean_reversion_15m') {
    // Tier-aware MR cap: tier-3 alts need wider headroom because their
    // spreads alone consume most of the tier-1/2 cap. Falls back to the
    // tier-1/2 cap when pair is null (e.g. legacy callers in tests).
    // Per-timeframe split (2026-05-17 Stage 3): 5m and 15m have their own
    // caps so an operator can widen the coarser-timeframe stops without
    // touching the 1m variant that is currently the live signal. Defaults
    // all match the 1m cap, so this is a no-op until an operator sets a
    // _5M / _15M env override.
    const isTier3 = pair && typeof resolveSymbolTier === 'function' && resolveSymbolTier(pair) === 'tier3';
    if (signalVersion === 'mean_reversion_5m') {
      cap = isTier3 ? MR_STOP_LOSS_BPS_5M_TIER3 : MR_STOP_LOSS_BPS_5M;
    } else if (signalVersion === 'mean_reversion_15m') {
      cap = isTier3 ? MR_STOP_LOSS_BPS_15M_TIER3 : MR_STOP_LOSS_BPS_15M;
    } else {
      cap = isTier3 ? MR_STOP_LOSS_BPS_TIER3 : MR_STOP_LOSS_BPS;
    }
  }
  else if (signalVersion === 'range_mean_reversion') cap = RANGE_MR_STOP_LOSS_BPS;
  else if (signalVersion === 'barrier') cap = BARRIER_STOP_LOSS_BPS;
  else if (signalVersion === 'microstructure_5m') cap = MICRO_STOP_LOSS_BPS_5M;
  else if (signalVersion === 'microstructure_15m') cap = MICRO_STOP_LOSS_BPS_15M;
  else if (signalVersion === 'microstructure_30m') cap = MICRO_STOP_LOSS_BPS_30M;
  else if (signalVersion === 'microstructure_45m') cap = MICRO_STOP_LOSS_BPS_45M;
  else if (signalVersion === 'trend_following') cap = TREND_FOLLOWING_STOP_LOSS_BPS;
  else if (signalVersion === 'pairs') cap = PAIRS_STOP_LOSS_BPS;
  else if (signalVersion === 'btc_lead_lag') cap = BLL_STOP_LOSS_BPS;
  else cap = STOP_LOSS_BPS;
  if (!VOL_SCALED_STOP_ENABLED) return cap;
  const sigma = Number(volatilityBps);
  if (!Number.isFinite(sigma) || sigma <= 0) return cap;
  const scaled = STOP_LOSS_VOL_K * sigma * Math.sqrt(STOP_LOSS_HORIZON_BARS);
  const spread = Number(spreadBps);
  const spreadFloor = Number.isFinite(spread) && spread > 0 ? spread + STOP_OVER_SPREAD_BPS : 0;
  const minimum = Math.max(STOP_LOSS_BPS_FLOOR, spreadFloor);
  return Math.max(minimum, Math.min(cap, scaled));
}

// --- staircase exit ---------------------------------------------------------
//
// "If I'm going to lose money on this, I need to let the crypto ride until
// it gets to the breakeven point." — operator instruction.
//
// The GTC sell limit on every position is gradually walked DOWN over time
// from the initial signal-derived TP toward break-even-after-fees. Floor:
// entry × (1 + FEE_BPS_ROUND_TRIP / 10000), which is $0 net P&L. The bot
// never reposts below that, so a fill always yields >= $0. Position can
// stay stuck if price never reaches break-even — but no realised loss.
//
// Decay is linear over BREAKEVEN_TIMEOUT_MS (default 4 h) from the initial
// gross target to the break-even gross target. Reposts only fire when the
// desired price is at least STAIRCASE_REPOST_TOLERANCE_BPS below the
// resting limit, so we don't churn cancel/repost on tiny age increments.
//
// This SUPERSEDES the legacy one-shot break-even-replace at T = 4 h. When
// STAIRCASE_EXIT_ENABLED=false, the legacy path runs as a fallback.
const STAIRCASE_EXIT_ENABLED = readBoolean('STAIRCASE_EXIT_ENABLED', true);
const STAIRCASE_REPOST_TOLERANCE_BPS = Math.max(0.5, readNumber('STAIRCASE_REPOST_TOLERANCE_BPS', 3));

function computeStaircaseExitGrossBps(initialGrossBps, ageMs, timeoutMsOverride = null) {
  if (!STAIRCASE_EXIT_ENABLED) return initialGrossBps;
  const breakeven = FEE_BPS_ROUND_TRIP;
  const initial = Number(initialGrossBps);
  if (!Number.isFinite(initial)) return breakeven;
  if (initial <= breakeven) return breakeven;
  if (!Number.isFinite(ageMs) || ageMs <= 0) return initial;
  const timeoutMs = Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0
    ? timeoutMsOverride
    : BREAKEVEN_TIMEOUT_MS;
  if (ageMs >= timeoutMs) return breakeven;
  const t = ageMs / timeoutMs;
  const decayed = initial + (breakeven - initial) * t;
  return Math.max(breakeven, decayed);
}

// Resolve the staircase clock anchor for a position. The in-memory
// positionFirstSeenAt resets on every process restart (PR #351 — to avoid
// instant break-even snaps right after a deploy), but the broker's GTC sell
// order survives restarts and its `created_at` proxies the original buy
// fill. Take the OLDER of (broker created_at age, in-memory first-seen age)
// so positions opened well before a deploy resume their staircase decay
// instead of resetting to t=0 on reboot.
function resolveStaircaseAgeMs(pair, existing) {
  const candidates = [];
  const brokerCreatedAt = existing?.created_at ? Date.parse(existing.created_at) : NaN;
  if (Number.isFinite(brokerCreatedAt)) candidates.push(Date.now() - brokerCreatedAt);
  const memoryFirstSeen = positionFirstSeenAt.get(pair);
  if (Number.isFinite(memoryFirstSeen)) candidates.push(Date.now() - memoryFirstSeen);
  if (candidates.length === 0) return 0;
  return Math.max(...candidates);
}

// Scan interval (ms).
const ENTRY_SCAN_INTERVAL_MS = Math.max(3000, readNumber('ENTRY_SCAN_INTERVAL_MS', runtimeConfig.entryScanIntervalMs || 12000));
// Exit-manager reconcile interval (ms).
const EXIT_SCAN_INTERVAL_MS = Math.max(5000, readNumber('EXIT_SCAN_INTERVAL_MS', 15000));
// Trading master switch.
const TRADING_ENABLED = readBoolean('TRADING_ENABLED', true);
// Quote staleness cutoff (ms). Default lowered from 180s → 15s (Fix 5) after
// live scorecard showed an average entry quote age of 49.5 s and a 0% win rate
// on closed trades — crypto can move 20–30 bps in 30 s, which is most of the
// strategy's signal-derived TP. The "quote looks new" grace path below still
// admits a fresh-but-late quote within (MAX_AGE + GRACE), so provider-timestamp
// lag doesn't blanket-reject entries.
const QUOTE_MAX_AGE_MS = Math.max(1000, readNumber('ENTRY_QUOTE_MAX_AGE_MS', 15000));
const QUOTE_STALE_GRACE_MS = Math.max(0, readNumber('ENTRY_QUOTE_STALE_GRACE_MS', 15000));
// Per-symbol stale-quote pruner. Skips chronically-stale pairs (those whose
// recent quotes are reliably older than the QUOTE_MAX_AGE_MS+grace ceiling)
// after we've observed them stale for STALE_QUOTE_PRUNE_LOOKBACK samples,
// without paying for the downstream bars-fetch and predictor each scan.
// Symbols re-enter after STALE_QUOTE_PRUNE_PROBATION_FRESH consecutive
// fresh observations.
const STALE_QUOTE_PRUNE_ENABLED = readBoolean('STALE_QUOTE_PRUNE_ENABLED', true);
const STALE_QUOTE_PRUNE_LOOKBACK = Math.max(2, readNumber('STALE_QUOTE_PRUNE_LOOKBACK', 8));
const STALE_QUOTE_PRUNE_MIN_FRESH_RATIO = Math.min(1, Math.max(0, readNumber('STALE_QUOTE_PRUNE_MIN_FRESH_RATIO', 0.4)));
const STALE_QUOTE_PRUNE_PROBATION_FRESH = Math.max(1, readNumber('STALE_QUOTE_PRUNE_PROBATION_FRESH', 2));
const quoteFreshness = createQuoteFreshnessTracker({
  lookback: STALE_QUOTE_PRUNE_LOOKBACK,
  minFreshRatio: STALE_QUOTE_PRUNE_MIN_FRESH_RATIO,
  freshThresholdMs: QUOTE_MAX_AGE_MS + QUOTE_STALE_GRACE_MS,
  probationFreshObservations: STALE_QUOTE_PRUNE_PROBATION_FRESH,
});
// Hard spread cap for entries (safety net above the implicit edge-gate bound).
// 2026-05-31: tightened 60 → 30 so the ceiling sits below the ~45 bps net TP
// target — a book wider than the achievable TP can never net positive, so
// admitting it only bleeds. These fallbacks mirror
// liveDefaults.js (LIVE_CRITICAL_DEFAULTS wins at runtime; kept in sync per
// CLAUDE.md so a bare process invocation matches the live posture).
const SPREAD_MAX_BPS = Math.max(1, readNumber('SPREAD_MAX_BPS', 30));
// Tier-aware spread caps, each clamped to the global SPREAD_MAX_BPS at
// resolution so the flat cap stays an authoritative ceiling. Collapsed to a
// uniform 30 bps: on Binance.US's USDT books the liquid majors quote well
// inside 30 bps, while the thin alt books (60-920 bps) are exactly the names
// the 2026-05-31 diagnosis showed bleeding — so the cap doubles as a
// liquidity filter.
const SPREAD_MAX_BPS_TIER1 = Math.max(1, readNumber('SPREAD_MAX_BPS_TIER1', 30));
const SPREAD_MAX_BPS_TIER2 = Math.max(1, readNumber('SPREAD_MAX_BPS_TIER2', 30));
const SPREAD_MAX_BPS_TIER3 = Math.max(1, readNumber('SPREAD_MAX_BPS_TIER3', 30));
const TIER1_SYMBOL_SET = new Set(runtimeConfig.executionTier1Symbols || []);
const TIER2_SYMBOL_SET = new Set(runtimeConfig.executionTier2Symbols || []);
function resolveSymbolTier(pair) {
  if (TIER1_SYMBOL_SET.has(pair)) return 'tier1';
  if (TIER2_SYMBOL_SET.has(pair)) return 'tier2';
  return runtimeConfig.executionTier3Default ? 'tier3' : 'unclassified';
}
function resolveSpreadCapBps(pair) {
  const tier = resolveSymbolTier(pair);
  let tierCap;
  if (tier === 'tier1') tierCap = SPREAD_MAX_BPS_TIER1;
  else if (tier === 'tier2') tierCap = SPREAD_MAX_BPS_TIER2;
  else if (tier === 'tier3') tierCap = SPREAD_MAX_BPS_TIER3;
  else tierCap = SPREAD_MAX_BPS_TIER1; // unclassified: most conservative
  return Math.min(tierCap, SPREAD_MAX_BPS);
}
// Keep the microstructure spread gate aligned with the primary spread cap by
// default; the economics gates below (execution-cost floor, alpha, EV) are the
// intended profitability filters. A lower hidden default here can starve entry
// attempts before those profitability checks run.
const SPREAD_ENTRY_MAX_BPS = Math.max(1, readNumber('SPREAD_ENTRY_MAX_BPS', SPREAD_MAX_BPS));
const SPREAD_SHOCK_MAX_BPS = Math.max(SPREAD_ENTRY_MAX_BPS, readNumber('SPREAD_SHOCK_MAX_BPS', 30));
const MAX_SLIPPAGE_ESTIMATE_BPS = Math.max(0, readNumber('MAX_SLIPPAGE_ESTIMATE_BPS', 5));
const MICRO_MOMENTUM_TICKS = Math.max(3, readNumber('MICRO_MOMENTUM_TICKS', 4));
const MICRO_EMA_LENGTH = Math.max(3, readNumber('MICRO_EMA_LENGTH', 6));
const MICRO_MEAN_REVERSION_MIN_DEV_BPS = Math.max(0.1, readNumber('MICRO_MEAN_REVERSION_MIN_DEV_BPS', 2));
const TIGHT_QUOTE_MAX_BPS = Math.max(1, readNumber('TIGHT_QUOTE_MAX_BPS', 12));
const STABLE_QUOTE_VOL_MAX_BPS = Math.max(0.1, readNumber('STABLE_QUOTE_VOL_MAX_BPS', 8));
const SPREAD_CANARY_EXTRA_BPS = Math.max(0, readNumber('SPREAD_CANARY_EXTRA_BPS', 0));
const SPREAD_CANARY_SYMBOLS = new Set(readList('SPREAD_CANARY_SYMBOLS', []));
const SPREAD_COMPARISON_EPSILON_BPS = Math.max(0, readNumber('SPREAD_COMPARISON_EPSILON_BPS', 0.5));
const REJECTION_WINDOW_MS = Math.max(60000, readNumber('ENTRY_REJECTION_WINDOW_MS', 600000));
const MAJOR_ASSET_DIP_EXCEPTION = new Set(readList('MAJOR_ASSET_DIP_EXCEPTION', ['BTC/USD', 'ETH/USD', 'SOL/USD']));

// --- entry prediction ---------------------------------------------------
// The bot only buys when recent 1m closes form a statistically meaningful
// uptrend. The net-edge gate below (slope t-stat → logistic CDF → expected-
// edge inequality) is the real filter; it subsumes the old slope-floor and
// R^2-floor gates. Only a cheap short-term-dip sanity check runs alongside.
const PREDICT_BARS = Math.max(5, readNumber('PREDICT_BARS', 20));

// Reject entries when 1m return volatility (bps, stddev) exceeds this cap.
// A high value before entry is strongly associated with post-entry reversal.
const VOLATILITY_MAX_BPS = Math.max(10, readNumber('VOLATILITY_MAX_BPS', 100));

// Higher-timeframe confirmation. Require recent 5m bars to show positive
// drift before accepting a 1m entry signal. Default raised from 0 → 1
// bps/bar after live diagnostics showed ADA (htf=1.03) and ETH (htf=2.37)
// entering at the top of a broader market sell-off — slopes statistically
// indistinguishable from zero were passing the "not in a downtrend" gate.
const HTF_FILTER_ENABLED = readBoolean('HTF_FILTER_ENABLED', true);
const HTF_TIMEFRAME = String(process.env.HTF_TIMEFRAME || '5Min');
const HTF_BARS = Math.max(5, readNumber('HTF_BARS', 12));
const HTF_MIN_SLOPE_BPS_PER_BAR = readNumber('HTF_MIN_SLOPE_BPS_PER_BAR', 1);

// Expected-value gate. Require probability-weighted net edge (after fees and
// slippage buffers) to clear this bar before we submit a buy. Entry-only —
// sell behavior is unchanged.
//
// realizedWinBps = TARGET_NET_PROFIT_BPS - ENTRY_SLIPPAGE_BPS, and the gate
// requires realizedWinBps × fillProbability >= MIN_NET_EDGE_BPS. With the
// scalper-friendly defaults below (target=15, slip=3, MIN=2), the gate is
// `12 × p >= 2` ⇒ p >= ~0.17 — comfortably looser than the slope-positive
// guard (p > 0.5 ⇔ t > 0) and the alpha_below_execution_cost guard, both of
// which continue to enforce per-trade economic floors. The cost-floor gate
// further requires GROSS_TARGET >= entrySlip + exitSlip + fees + MIN, i.e.
// TARGET >= 3 + 3 + 2 = 8 bps, so the documented 10..50 bps target range
// always clears the friction floor. Raising MIN, slippage, or fees without
// also raising TARGET will resurrect the small-target rejection problem.
const NET_EDGE_GATE_ENABLED = readBoolean('NET_EDGE_GATE_ENABLED', true);
const MIN_NET_EDGE_BPS = readNumber('MIN_NET_EDGE_BPS', 2);
// Hard floor on the OLS-projected forward move (bps) required to enter.
// After lowering TARGET_NET_PROFIT_BPS to 8, the EV gate (5 × fillProb ≥ 2,
// i.e. fillProb ≥ 0.4) lets through trades with sub-3 bps projections —
// statistically indistinguishable from noise. Default 15 bps ≈ 3× modelled
// slippage and ~half a fee round-trip, so sub-floor signals never even
// reach the EV math.
const MIN_PROJECTED_BPS_TO_ENTER = Math.max(0, readNumber('MIN_PROJECTED_BPS_TO_ENTER', 15));
// Top-detection gates. Defaults flipped ON after the dashboard's auto-run
// backtest A/B confirmed both prune ~10–45% of entries with near-zero
// expectancy cost (primary 5.46 → alt 5.41 / alt2 5.42 bps net per entry)
// while live diagnostics showed an 11-position cluster firing into a broad
// crypto roll-over because both gates were silently OFF (every entry's
// forensics had `btcLeadLag: null`, including a DOT entry with
// `volumeRatio: 0`). Set to 0 to disable.
//
// MIN_VOLUME_RATIO_TO_ENTER: refuse entries when recent-window volume
// dropped below `ratio × all-window volume`. >1 means rising volume
// (confirmation), <1 means fading. Tops typically print on declining
// volume. Default 1.0 = recent volume must at least equal the lookback
// mean. Set to 0 to disable.
const MIN_VOLUME_RATIO_TO_ENTER = Math.max(0, readNumber('MIN_VOLUME_RATIO_TO_ENTER', 1.0));
// MAX_BTC_LEAD_LAG_DROP_BPS: refuse non-BTC entries when BTC's last-5-bar
// return is more negative than this threshold. Alts lag BTC by 30–90s in
// crypto, so a recent BTC drop is a leading indicator that alt momentum
// is about to reverse. Negative number; 0 or positive = gate off. Default
// -10 bps after the alt-backtest at -15 bps showed negligible expectancy
// cost; -10 is slightly tighter to bias toward fewer-but-cleaner entries.
// Skipped when BTC lead-lag snapshot is missing or stale (>5 min old).
const MAX_BTC_LEAD_LAG_DROP_BPS = readNumber('MAX_BTC_LEAD_LAG_DROP_BPS', -10);
// MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER: portfolio-level drawdown gate.
// When the live book's aggregate unrealized P&L (sum / equity, in percent)
// is below this threshold, refuse all new entries until the situation
// improves. The per-symbol gates can each individually pass during a
// broad market top because they have no portfolio context — live
// diagnostics observed 11 simultaneous losers entered over a 10-hour
// window into a crypto-wide sell-off, with UNI already -100+ bps when
// XRP fired 3 hours later. This is the missing macro filter. Default
// tightened from -2.0 → -0.5 (= -0.5% book drawdown): operator target is
// +1%/day via tiny scalps, so a -0.5% portfolio drawdown is already half
// a day's P&L — pause new entries before giving up the day. Set to 0 to
// disable. Negative threshold only.
const MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER = readNumber(
  'MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER',
  -0.5,
);
// Recent-high proximity gate. Operator pain: "we do good but then get stuck
// when we bought when the market was too high." Refuses entries where the
// bid is within REJECT_NEAR_HIGH_BPS of the highest close in the last
// REJECT_NEAR_HIGH_LOOKBACK_BARS 1-minute bars. Uses already-fetched closes;
// no extra Alpaca call. Set REJECT_NEAR_HIGH_ENABLED=false to disable.
const REJECT_NEAR_HIGH_ENABLED = readBoolean('REJECT_NEAR_HIGH_ENABLED', true);
const REJECT_NEAR_HIGH_BPS = Math.max(0, readNumber('REJECT_NEAR_HIGH_BPS', 30));
const REJECT_NEAR_HIGH_LOOKBACK_BARS = Math.max(1, readNumber('REJECT_NEAR_HIGH_LOOKBACK_BARS', 60));
// Orderbook-imbalance feature. Default OFF — enabling adds an extra
// /latest/orderbooks fetch per scan (≈ same cost as the existing /latest/quotes
// hit), against Alpaca's 200/min crypto data cap. When ON, every entry's
// `bookImbalance` field reflects (bid − ask) notional over the top
// ORDERBOOK_IMBALANCE_LEVELS levels, range [-1, +1]. Pure observation —
// not a gate. Flip on once you've confirmed via backtest that the signal
// has edge worth the API budget.
const ORDERBOOK_IMBALANCE_FEATURE_ENABLED = readBoolean('ORDERBOOK_IMBALANCE_FEATURE_ENABLED', false);
const ORDERBOOK_IMBALANCE_LEVELS = Math.max(1, readNumber('ORDERBOOK_IMBALANCE_LEVELS', 5));
const ENTRY_SLIPPAGE_BPS = Math.max(0, readNumber('ENTRY_SLIPPAGE_BPS', 3));
const EXIT_SLIPPAGE_BPS = Math.max(0, readNumber('EXIT_SLIPPAGE_BPS', 3));

// --- corrected entry economics (see backend/modules/entryEconomics.js) ----
//
// The OLS slope t-statistic the predictor returns measures how statistically
// significant the past slope was, NOT the forward probability that the
// take-profit fills inside the breakeven-timeout window. Using
// logistic_cdf(slopeTStat) as `fillProbability` is wrong, and combined with
// the no-stop-loss exit structure it makes the EV gate optimistic by
// construction (every non-fill is treated as 0 P&L when in reality stuck
// positions accumulate negative MTM). The simulator at
// backend/scripts/simulate_strategy.js shows expectancy turns sharply
// negative under flat / adverse drift even though the live engine's EV gate
// reports +5 bps for the same candidates.
//
// Two corrections are applied, both gated by env flags so live behaviour
// can be rolled back instantly:
//   1. CORRECTED_FILL_PROB_ENABLED: replace the logistic-CDF proxy with a
//      forward-looking GBM barrier-hitting probability using the recent
//      slope as drift μ and recent realised vol as σ. This is still cheap
//      (one Φ evaluation) and produces a probability that actually answers
//      "what's the chance the TP fills in the next BARRIER_HORIZON_BARS?".
//   2. ENFORCE_GROSS_TARGET_FLOOR: refuse trades whose GTC target cannot
//      pay for spread + entry slippage + exit slippage + fees + min-net.
//      This is a pure cost equation — no probabilistic assumption — and
//      is the floor the user explicitly asked us to enforce.
//
// HONEST_EV_GATE_ENABLED prices the no-fill branch as a non-zero MTM loss so
// the asymmetric "no stop-loss + GTC TP only" structure is gated honestly:
//     E[net] = hitProb × TARGET_NET_PROFIT_BPS - (1 - hitProb) × STUCK_LOSS_ASSUMED_BPS
// and skips trades whose honest expectancy is below MIN_NET_EDGE_BPS.
// Default ON: live diagnostics observed entries (e.g. BCH at projectedBps=2.6
// with honestEvBps=-54, DOGE at honestEvBps=-3.7) clearing the cheaper net-edge
// gate while having negative honest expectancy — exactly the trades the
// no-stop design has no way to recover from. Operator can set
// HONEST_EV_GATE_ENABLED=false to revert to the legacy permissive behavior.
// STUCK_LOSS_ASSUMED_BPS default raised from 100 → 250 after live diagnostics
// measured the actual unrealized drawdown on a 11-position stuck cluster at
// ~270 bps per position — the previous 100 bps assumption was systematically
// rating marginal entries +EV when reality was -EV.
const CORRECTED_FILL_PROB_ENABLED = readBoolean('CORRECTED_FILL_PROB_ENABLED', true);
const ENFORCE_GROSS_TARGET_FLOOR = readBoolean('ENFORCE_GROSS_TARGET_FLOOR', true);
const HONEST_EV_GATE_ENABLED = readBoolean('HONEST_EV_GATE_ENABLED', true);
const STUCK_LOSS_ASSUMED_BPS = Math.max(0, readNumber('STUCK_LOSS_ASSUMED_BPS', 250));
// Entry-signal dispatch. Two modes:
//   'auto' (default): the runtime signal selector picks 'ols' or 'multi_factor'
//     each scan based on the most recent backtest evidence. If neither signal
//     has cleared SIGNAL_SELECTOR_MIN_BPS in its 30-day backtest, all entries
//     are vetoed (skip reason: backtest_veto_active). The selector boots in
//     "veto" state and re-evaluates after every backtest auto-run; the live
//     engine consults its decision on every scan via getCurrentDecision().
//   'ols' / 'multi_factor': operator override — the named signal is used
//     regardless of backtest performance. The veto still applies UNLESS
//     BACKTEST_VETO_ENABLED=false (see SIGNAL_SELECTOR_VETO_ENABLED below).
// When 'multi_factor' is active the OLS-specific gates (slope_not_positive,
// net_edge_below_min, honest_ev_below_min) are skipped — the new signal's
// own factor vote replaces them. Structural gates (drawdown, sizing,
// freshness, spread, vol-cap, HTF) still apply to both signals.
const SIGNAL_VERSION_RAW = String(process.env.SIGNAL_VERSION || '').trim().toLowerCase();
const SIGNAL_VERSION_OPERATOR_OVERRIDE = [
  'ols', 'multi_factor', 'mean_reversion', 'mean_reversion_5m', 'mean_reversion_15m', 'barrier',
  'microstructure_5m', 'microstructure_15m', 'microstructure_30m', 'microstructure_45m',
  'btc_lead_lag',
].includes(SIGNAL_VERSION_RAW)
  ? SIGNAL_VERSION_RAW
  : null;
const SIGNAL_VERSION_MODE = SIGNAL_VERSION_OPERATOR_OVERRIDE || 'auto';
// Threshold (bps) the backtest avgNetBpsPerEntry must clear for a signal
// to be considered "validated" by the selector. Default +3 bps. Set lower
// (e.g. 0 or negative) to relax. The veto + selector live in
// backend/modules/signalSelector.js.
const SIGNAL_SELECTOR_MIN_BPS = readNumber('SIGNAL_SELECTOR_MIN_BPS', 3);
// When true (default), the selector vetos entries when no signal has cleared
// the activation threshold. Set to false to revert to legacy behaviour
// (trade whatever SIGNAL_VERSION says, even if backtests show losses).
const SIGNAL_SELECTOR_VETO_ENABLED = readBoolean('SIGNAL_SELECTOR_VETO_ENABLED', true);
// Minimum backtest sample size — below this, the result is statistically
// meaningless and the selector falls back to veto for that signal.
const SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES = Math.max(1, readNumber('SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES', 5));

// Realized-expectancy circuit breaker (2026-05-27). The selector's pick is
// backtest-driven and the backtest fill model over-states edge (no penalty
// for passive-limit adverse selection), so a signal can backtest positive yet
// bleed live — microstructure_30m backtested +7.8 bps but realized −31 bps
// over 29 live fills. These knobs halt NEW entries when the active signal's
// recent realized net bps proves it is losing. Open positions still exit
// normally. Disable wholesale with SIGNAL_SELECTOR_REALIZED_VETO_ENABLED=false.
const SIGNAL_SELECTOR_REALIZED_VETO_ENABLED = readBoolean('SIGNAL_SELECTOR_REALIZED_VETO_ENABLED', true);
const SIGNAL_SELECTOR_REALIZED_MIN_TRADES = Math.max(1, readNumber('SIGNAL_SELECTOR_REALIZED_MIN_TRADES', 10));
const SIGNAL_SELECTOR_REALIZED_FLOOR_BPS = readNumber('SIGNAL_SELECTOR_REALIZED_FLOOR_BPS', -10);
// 2026-06-11: self-recovery clock for the realized breaker (default 24h). A
// count-only window freezes while the veto halts all entries, so the breaker
// deadlocks at zero trades. Aging out trades older than this drains a frozen
// sample → the veto lifts as insufficient_sample → the bot re-probes at its
// tiny configured size → the breaker re-judges on fresh fills. 0 disables it
// (pre-2026-06-11 count-only behaviour). See signalSelector.evaluateRealizedVeto.
const SIGNAL_SELECTOR_REALIZED_MAX_AGE_MS = Math.max(
  0,
  readNumber('SIGNAL_SELECTOR_REALIZED_MAX_AGE_MS', 86400000),
);
const SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES = Math.max(
  SIGNAL_SELECTOR_REALIZED_MIN_TRADES,
  readNumber('SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES', 50),
);

// Exploration budget (2026-05-29). The middle ground between the backtest
// veto's two failure modes (veto-all → never trades; veto-off → bleeds). When
// the BACKTEST veto would halt all entries, allow a strictly-capped trickle of
// tiny-notional entries — only on candidates the active signal still likes —
// so the bot keeps a metered toe in the water and accumulates the labeled
// trade data needed to ever lift the veto. Bounded by construction: total
// exploration exposure ≤ maxConcurrent × notionalUsd, independent of runtime.
// Does NOT bypass the realized-expectancy circuit breaker (that veto runs
// after this decision in scanAndEnter — a signal proven to bleed live still
// halts). See modules/explorationBudget.js for the full rationale.
const EXPLORATION_ENTRIES_ENABLED = readBoolean('EXPLORATION_ENTRIES_ENABLED', false);
const EXPLORATION_MAX_ENTRIES_PER_DAY = Math.max(0, readNumber('EXPLORATION_MAX_ENTRIES_PER_DAY', 3));
const EXPLORATION_MAX_CONCURRENT = Math.max(0, readNumber('EXPLORATION_MAX_CONCURRENT', 2));
const EXPLORATION_NOTIONAL_USD = Math.max(0, readNumber('EXPLORATION_NOTIONAL_USD', 10));
const EXPLORATION_CONFIG = Object.freeze({
  enabled: EXPLORATION_ENTRIES_ENABLED,
  maxEntriesPerDay: EXPLORATION_MAX_ENTRIES_PER_DAY,
  maxConcurrent: EXPLORATION_MAX_CONCURRENT,
  notionalUsd: EXPLORATION_NOTIONAL_USD,
});

const signalSelector = require('./modules/signalSelector');
// Bootstrap: when the operator has overridden the signal AND disabled the
// veto, allow trading from the moment the engine starts (without waiting
// for the first backtest to complete). Otherwise the selector keeps its
// safe default (no_backtest_completed_yet → veto until first backtest).
signalSelector.bootstrapDecisionFromEnv({
  operatorOverride: SIGNAL_VERSION_OPERATOR_OVERRIDE,
  vetoEnabled: SIGNAL_SELECTOR_VETO_ENABLED,
});

// Resolve the signal version the entry path should use right now. Reads
// the runtime selector (which is updated whenever a backtest completes).
// Falls back to 'ols' as a last-resort label if the selector somehow
// returns null AND trading is happening anyway (shouldn't be reachable
// because the veto check fires first; defensive default).
function getActiveSignalVersion() {
  // 2026-05-30: the entry path no longer consults the backtest signal-selector
  // decision — it trades the operator override or the mean_reversion default.
  // This getter mirrors that exactly so the dashboard reports the signal the
  // bot is actually trading, not the selector's (now unused) pick.
  return SIGNAL_VERSION_OPERATOR_OVERRIDE || 'mean_reversion';
}
function getSignalSelectorDecision() {
  return signalSelector.getCurrentDecision();
}
// Last realized-expectancy veto evaluation (refreshed each scan in
// scanAndEnter). Surfaced on the dashboard at meta.signalSelector.realizedVeto
// so the operator can see WHY the bot stopped trading the active signal.
let lastRealizedVetoState = null;
function getRealizedVetoState() {
  return lastRealizedVetoState;
}
// Warn-once latch for the btc_lead_lag maker-execution guard so a misconfigured
// pin doesn't spam the log every 5s scan. Reset is process-lifetime (a restart
// re-warns), which is fine — the point is one loud line per misconfig session.
let btcLeadLagUnsafeExecutionWarned = false;
// Exploration-budget state for the dashboard meta surface. Shows whether the
// metered "middle ground" path is enabled, how much of the rolling daily
// budget is used, and the bounded worst-case exposure.
function getExplorationBudgetState() {
  try {
    return explorationBudget.getState({ config: EXPLORATION_CONFIG });
  } catch (_) {
    return null;
  }
}
// Chronic-wide-spread suppressor state for the dashboard meta surface: which
// symbols are currently being skipped before the quote fetch, and the rolling
// per-symbol pass-rate that drove it.
function getSpreadSuppressionState() {
  try {
    if (!SPREAD_SUPPRESS_ENABLED) return { enabled: false };
    return {
      enabled: true,
      ...spreadSuppressionTracker.summary({
        minObservations: SPREAD_SUPPRESS_MIN_OBSERVATIONS,
        maxAcceptableRate: SPREAD_SUPPRESS_MAX_PASS_RATE,
      }),
    };
  } catch (_) {
    return null;
  }
}
// Maker-fill-rate state for the dashboard meta surface. The BTC lead-lag edge
// only exists on maker fills (+1.94 bps) vs taker (-0.38), so during a live
// trial this funnel — submitted -> {filled | unfilled_cancelled |
// rejected_post_only} — is the go/no-go instrument. Observational only.
function getMakerFillState() {
  try {
    return { postOnly: ENTRY_POST_ONLY, ...makerFillTracker.buildSummary() };
  } catch (_) {
    return null;
  }
}
// Legacy export-shape compatibility: code paths that read SIGNAL_VERSION as
// a constant continue to work, but they always see the live decision.
// Note: this is now a getter, not a static value.
const SIGNAL_VERSION = SIGNAL_VERSION_OPERATOR_OVERRIDE || 'auto';
// Horizon (in 1-minute bars) over which we expect the take-profit to fill.
// Defaults to BREAKEVEN_TIMEOUT_MS in minutes — i.e., the same window after
// which the engine would otherwise replace the TP with a break-even sell.
const BARRIER_HORIZON_BARS = Math.max(1, readNumber(
  'BARRIER_HORIZON_BARS',
  Math.max(1, Math.round(BREAKEVEN_TIMEOUT_MS / 60000)),
));

// --- signal-sized exit -------------------------------------------------------
//
// When ON, each entry's TP is sized from that entry's own `projectedBps`
// (the OLS slope-based forward move estimate), floored at TARGET_NET_PROFIT_BPS
// and capped at SIGNAL_TARGET_MAX_NET_BPS. Confident signals get bigger TPs;
// weak signals fall back to the floor. Wins are no longer all the same size.
//
// SIGNAL_TARGET_FRACTION (default 1.0) is the operator-tunable knob: target
// is `fraction × projectedBps − fees`. Setting it to 1.0 means we aim to
// fill at the full predicted move; the staircase exit catches the misses
// at break-even or above (97% fill rate observed) so the lower-than-it-
// looks TP fill rate doesn't hurt expectancy. The original ship default
// was 0.5 (target half the move for higher fill rate), but a 30-day
// 12-symbol Alpaca-bar backtest measured fraction=1.0 at +5.73 bps/entry
// vs +3.97 bps/entry for fraction=0.5 — a 44% boost with virtually
// identical risk profile (stuck rate moved by 0.1pp). Reverted to 1.0
// based on that data; flip back to 0.5 here or via env if you want to
// re-test.
const SIGNAL_SIZED_EXIT_ENABLED = readBoolean('SIGNAL_SIZED_EXIT_ENABLED', true);
const SIGNAL_TARGET_FRACTION = Math.min(2, Math.max(0.1, readNumber('SIGNAL_TARGET_FRACTION', 1.0)));
// Absolute upper safety bound on any per-trade signal-sized TP, regardless
// of which signal is active. Anything above 500 bps net is almost certainly
// a configuration error rather than a real trade intent.
const ABSOLUTE_TARGET_NET_BPS_CEILING = 500;
const SIGNAL_TARGET_MAX_NET_BPS = Math.min(
  ABSOLUTE_TARGET_NET_BPS_CEILING,
  Math.max(TARGET_NET_PROFIT_BPS, readNumber('SIGNAL_TARGET_MAX_NET_BPS', 50)),
);
// Multi-factor signal sizing overrides. Only consulted when
// SIGNAL_VERSION='multi_factor'. The new signal's projectedBps is an
// ATR-derived per-trade TP target sized in [40, 150] bps; the OLS-tuned
// floor of 8 bps and cap of 50 bps would clamp every multi-factor trade
// to a tiny TP that the wider stop can't pay for. These knobs are read
// once at startup; OLS behavior is unaffected.
const MF_TARGET_NET_PROFIT_BPS_FLOOR = Math.min(
  ABSOLUTE_TARGET_NET_BPS_CEILING,
  Math.max(1, readNumber('MF_TARGET_NET_PROFIT_BPS_FLOOR', 40)),
);
const MF_SIGNAL_TARGET_MAX_NET_BPS = Math.min(
  ABSOLUTE_TARGET_NET_BPS_CEILING,
  Math.max(MF_TARGET_NET_PROFIT_BPS_FLOOR, readNumber('MF_SIGNAL_TARGET_MAX_NET_BPS', 150)),
);
// Mean-reversion-at-extremes sizing knobs. The signal's projectedBps is
// "half the cumulative drop" sized in bps; default floor 20 bps net /
// cap 120 bps net is much tighter than MF's 40-150 because mean-reversion
// targets are statistically near-guaranteed only when small relative to
// the drop magnitude. Read once at startup.
// Mean-reversion sizing. The signal returns projectedBps = "half the drop"
// (gross). Convert: net target = gross_target - fees. With minimum 100 bps
// drop trigger, projectedBps starts at 50, net at 50 - 40 = 10 bps. Tiny,
// statistical, by design. Floor at 5 bps net so even with small drops we
// don't size sub-fee targets; cap at MR_SIGNAL_TARGET_MAX_NET_BPS to bound
// the per-trade target on extreme drops.
const MR_TARGET_NET_PROFIT_BPS_FLOOR = Math.min(
  ABSOLUTE_TARGET_NET_BPS_CEILING,
  Math.max(1, readNumber('MR_TARGET_NET_PROFIT_BPS_FLOOR', 5)),
);
const MR_SIGNAL_TARGET_MAX_NET_BPS = Math.min(
  ABSOLUTE_TARGET_NET_BPS_CEILING,
  Math.max(MR_TARGET_NET_PROFIT_BPS_FLOOR, readNumber('MR_SIGNAL_TARGET_MAX_NET_BPS', 120)),
);

function deriveSignalTargetNetBps(projectedBps, signalVersion = 'ols') {
  // Mean-reversion (1m / 5m / 15m all behave identically): projectedBps is
  // already a GROSS target (half the drop), not a forward-move prediction.
  // Convert directly to net by subtracting fees, then clamp to MR's tighter
  // range. Don't multiply by SIGNAL_TARGET_FRACTION (the half-drop math is
  // the fraction).
  if (signalVersion === 'mean_reversion'
      || signalVersion === 'mean_reversion_5m'
      || signalVersion === 'mean_reversion_15m') {
    const projected = Number(projectedBps);
    if (!Number.isFinite(projected)) return MR_TARGET_NET_PROFIT_BPS_FLOOR;
    const signalNet = projected - FEE_BPS_ROUND_TRIP;
    return Math.max(MR_TARGET_NET_PROFIT_BPS_FLOOR, Math.min(MR_SIGNAL_TARGET_MAX_NET_BPS, signalNet));
  }
  // Microstructure (all four horizons): projectedBps is the required GROSS
  // exit (signal-internal math already includes fees + spread + slippage to
  // meet the per-horizon desiredNet target). Net = gross − fees, clamped to
  // the microstructure floor/cap. Mirrors the barrier signal's sizing
  // convention, just with a tighter floor since the smaller-horizon variants
  // target sub-100-bps gross.
  if (signalVersion === 'microstructure_5m'
      || signalVersion === 'microstructure_15m'
      || signalVersion === 'microstructure_30m'
      || signalVersion === 'microstructure_45m') {
    const projected = Number(projectedBps);
    if (!Number.isFinite(projected)) return MICRO_TARGET_NET_BPS_FLOOR;
    const signalNet = projected - FEE_BPS_ROUND_TRIP;
    return Math.max(MICRO_TARGET_NET_BPS_FLOOR, Math.min(MICRO_SIGNAL_TARGET_MAX_NET_BPS, signalNet));
  }
  // BTC lead-lag: projectedBps is the expected forward catch-up move (gross).
  // Net = gross − fees, clamped to the lead-lag floor/cap. Same convention as
  // microstructure (a forward-move prediction, not a half-drop).
  if (signalVersion === 'btc_lead_lag') {
    const projected = Number(projectedBps);
    if (!Number.isFinite(projected)) return BLL_TARGET_NET_PROFIT_BPS_FLOOR;
    const signalNet = projected - FEE_BPS_ROUND_TRIP;
    return Math.max(BLL_TARGET_NET_PROFIT_BPS_FLOOR, Math.min(BLL_SIGNAL_TARGET_MAX_NET_BPS, signalNet));
  }
  // Range mean-reversion: projectedBps is the half-distance to the range
  // midpoint. Same conversion pattern as MR — gross to net by subtracting
  // fees, clamped to the range-MR-specific floor and cap (smaller than MR
  // because the per-trade move is smaller).
  if (signalVersion === 'range_mean_reversion') {
    const projected = Number(projectedBps);
    if (!Number.isFinite(projected)) return RANGE_MR_TARGET_NET_PROFIT_BPS_FLOOR;
    const signalNet = projected - FEE_BPS_ROUND_TRIP;
    return Math.max(
      RANGE_MR_TARGET_NET_PROFIT_BPS_FLOOR,
      Math.min(RANGE_MR_SIGNAL_TARGET_MAX_NET_BPS, signalNet),
    );
  }
  let floor;
  let ceiling;
  if (signalVersion === 'multi_factor') {
    floor = MF_TARGET_NET_PROFIT_BPS_FLOOR;
    ceiling = MF_SIGNAL_TARGET_MAX_NET_BPS;
  } else {
    floor = TARGET_NET_PROFIT_BPS;
    ceiling = SIGNAL_TARGET_MAX_NET_BPS;
  }
  if (!SIGNAL_SIZED_EXIT_ENABLED) return floor;
  const projected = Number(projectedBps);
  if (!Number.isFinite(projected)) return floor;
  // Aim to fill at SIGNAL_TARGET_FRACTION of the projected forward move.
  // To net X bps after fees, set TP at X + fees gross, so:
  //   signalNet = fraction × projected − fees.
  // Then floor at the per-signal scalp target and cap at the per-signal max.
  // For multi_factor, projectedBps is already a per-trade TP sized from ATR
  // (1.5 × ATR_BPS clamped to [40, 150]); the per-signal floor preserves the
  // wider payoff shape even when the projection itself sits at the ATR floor.
  const signalNet = SIGNAL_TARGET_FRACTION * projected - FEE_BPS_ROUND_TRIP;
  return Math.max(floor, Math.min(ceiling, signalNet));
}

// --- Alpaca base URLs / auth ---------------------------------------------

const TRADE_BASE = (process.env.TRADE_BASE || process.env.ALPACA_BASE_URL || 'https://api.alpaca.markets').replace(/\/+$/, '');
const DATA_BASE = (process.env.DATA_BASE || process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');

const KEY_VARS = ['APCA_API_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_API_KEY_ID', 'ALPACA_API_KEY'];
const SECRET_VARS = [`AP${'CA'}_API_SECRET_KEY`, 'ALPACA_SECRET_KEY', `ALPACA_AP${'I'}_SECRET_KEY`];

function pickEnv(vars) {
  for (const name of vars) {
    const v = String(process.env[name] || '').trim();
    if (v) return { name, value: v };
  }
  return { name: null, value: '' };
}

function resolveAlpacaAuth() {
  const key = pickEnv(KEY_VARS);
  const secret = pickEnv(SECRET_VARS);
  const missing = [];
  if (!key.value) missing.push('APCA_API_KEY_ID');
  if (!secret.value) missing.push(`AP${'CA'}_API_SECRET_KEY`);
  return {
    alpacaAuthOk: missing.length === 0,
    alpacaKeyIdPresent: Boolean(key.value),
    keyVar: key.name,
    secretVar: secret.name,
    missing,
    checkedKeyVars: KEY_VARS,
    checkedSecretVars: SECRET_VARS,
    apiKey: key.value,
    apiSecret: secret.value,
  };
}

function getAlpacaAuthStatus() {
  const a = resolveAlpacaAuth();
  return {
    alpacaAuthOk: a.alpacaAuthOk,
    alpacaKeyIdPresent: a.alpacaKeyIdPresent,
    missing: a.missing,
    checkedKeyVars: a.checkedKeyVars,
    checkedSecretVars: a.checkedSecretVars,
  };
}

function getAlpacaBaseStatus() {
  return { tradeBase: TRADE_BASE, dataBase: DATA_BASE, tradeBaseUrl: TRADE_BASE, dataBaseUrl: DATA_BASE };
}

// --- HTTP ---------------------------------------------------------------

const HTTP_TIMEOUT_MS = Math.max(1000, readNumber('HTTP_TIMEOUT_MS', 10000));
const ALPACA_REQ_MIN_DELAY_MS = Math.max(0, readNumber('ALPACA_REQ_MIN_DELAY_MS', 120));
const ALPACA_REQ_MAX_RETRIES = Math.max(0, readNumber('ALPACA_REQ_MAX_RETRIES', 4));
const ALPACA_REQ_BASE_BACKOFF_MS = Math.max(50, readNumber('ALPACA_REQ_BASE_BACKOFF_MS', 300));
const ORDER_SUBMIT_CONCURRENCY = Math.min(2, Math.max(1, readNumber('ORDER_SUBMIT_CONCURRENCY', 1)));
const SPREAD_TOLERANCE_BPS = Math.max(0, readNumber('SPREAD_TOLERANCE_BPS', 2));
// Chronic-wide-spread auto-suppress (2026-05-29). Skips per-symbol scan work
// for symbols that fail the spread gate on essentially every scan (structurally
// illiquid books on the active venue). Self-healing via a rolling FIFO window.
// SAFE: only skips symbols the spread gate already rejects — never affects a
// trade. Surfaced at meta.spreadSuppression. Disable with
// SPREAD_SUPPRESS_ENABLED=false to scan (and reject) every wide symbol each cycle.
const SPREAD_SUPPRESS_ENABLED = readBoolean('SPREAD_SUPPRESS_ENABLED', true);
const SPREAD_SUPPRESS_MIN_OBSERVATIONS = Math.max(1, readNumber('SPREAD_SUPPRESS_MIN_OBSERVATIONS', 20));
const SPREAD_SUPPRESS_MAX_PASS_RATE = Math.max(0, readNumber('SPREAD_SUPPRESS_MAX_PASS_RATE', 0.05));
const spreadSuppressionTracker = createSpreadSuppressionTracker();
const BARS_FETCH_RETRIES = Math.max(0, readNumber('BARS_FETCH_RETRIES', 2));
const BARS_CACHE_TTL_MS = Math.max(5000, readNumber('BARS_CACHE_TTL_MS', 45000));
let lastHttpError = null;
let lastQuoteAt = 0;
let lastQuoteSymbol = null;
const lastQuoteFingerprintBySymbol = new Map();

function getLastHttpError() { return lastHttpError; }
function getLastQuoteSnapshot() {
  if (!lastQuoteAt) return null;
  return { ts: lastQuoteAt, ageMs: Date.now() - lastQuoteAt, symbol: lastQuoteSymbol };
}

let alpacaReqLastStartMs = 0;
let orderSubmitActive = 0;
const orderSubmitQueue = [];
const barsCache = new Map();

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseResetMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1000;
  return Date.now() + (n * 1000);
}

async function throttleAlpacaRequestStart() {
  const since = Date.now() - alpacaReqLastStartMs;
  const waitMs = Math.max(0, ALPACA_REQ_MIN_DELAY_MS - since);
  if (waitMs > 0) await sleep(waitMs);
  alpacaReqLastStartMs = Date.now();
}

async function withOrderSubmitQueue(task) {
  if (orderSubmitActive < ORDER_SUBMIT_CONCURRENCY) {
    orderSubmitActive += 1;
    try { return await task(); } finally { orderSubmitActive = Math.max(0, orderSubmitActive - 1); if (orderSubmitQueue.length) orderSubmitQueue.shift()(); }
  }
  return new Promise((resolve, reject) => {
    orderSubmitQueue.push(async () => {
      orderSubmitActive += 1;
      try { resolve(await task()); } catch (e) { reject(e); } finally { orderSubmitActive = Math.max(0, orderSubmitActive - 1); if (orderSubmitQueue.length) orderSubmitQueue.shift()(); }
    });
  });
}

async function alpacaRequest({ base, path, method = 'GET', query, body, label }) {
  const auth = resolveAlpacaAuth();
  if (!auth.alpacaAuthOk) {
    const err = new Error('alpaca_auth_missing');
    err.statusCode = 401;
    err.errorCode = 'ALPACA_AUTH_MISSING';
    err.error = 'alpaca_auth_missing';
    throw err;
  }
  const baseUrl = base === 'data' ? DATA_BASE : TRADE_BASE;
  const url = new URL(`${baseUrl}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const init = {
    method,
    headers: {
      'APCA-API-KEY-ID': auth.apiKey,
      'APCA-API-SECRET-KEY': auth.apiSecret,
      Accept: 'application/json',
    },
    signal: controller.signal,
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    let lastErr = null;
    for (let attempt = 0; attempt <= ALPACA_REQ_MAX_RETRIES; attempt += 1) {
      try {
        await throttleAlpacaRequestStart();
        const res = await fetch(url.toString(), init);
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.statusCode = res.status;
      err.errorMessage = json?.message || text || `HTTP ${res.status}`;
      err.errorCode = json?.code || null;
      err.urlHost = url.host;
      err.urlPath = url.pathname;
      err.responseSnippet = typeof text === 'string' ? text.slice(0, 400) : null;
      err.responseSnippet200 = err.responseSnippet;
      err.requestId = res.headers.get('x-request-id') || null;
      lastHttpError = {
        statusCode: err.statusCode,
        errorMessage: err.errorMessage,
        errorCode: err.errorCode,
        urlHost: err.urlHost,
        urlPath: err.urlPath,
        responseSnippet200: err.responseSnippet200,
        label: label || null,
        requestId: err.requestId,
        at: new Date().toISOString(),
      };
          throw err;
        }
        return json != null ? json : {};
      } catch (err) {
        const status = Number(err?.statusCode);
        const retryable = status === 429 || (Number.isFinite(status) && status >= 500);
        if (!retryable || attempt >= ALPACA_REQ_MAX_RETRIES) throw err;
        const resetMs = parseResetMs(err?.responseHeaders?.['x-ratelimit-reset'] || err?.responseHeaders?.['X-RateLimit-Reset']);
        const expMs = ALPACA_REQ_BASE_BACKOFF_MS * (2 ** attempt);
        const jitterMs = Math.floor(Math.random() * ALPACA_REQ_BASE_BACKOFF_MS);
        const delayMs = Math.max(expMs, resetMs ? Math.max(0, resetMs - Date.now()) : 0) + jitterMs;
        await sleep(delayMs);
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return {};
  } catch (err) {
    if (err?.name === 'AbortError') {
      const te = new Error(`HTTP timeout after ${HTTP_TIMEOUT_MS}ms`);
      te.isTimeout = true;
      te.statusCode = null;
      throw te;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function logMarketDataUrlSelfCheck() {
  console.log('market_data_url_self_check', { tradeBase: TRADE_BASE, dataBase: DATA_BASE });
}

async function getAlpacaConnectivityStatus() {
  const auth = resolveAlpacaAuth();
  const status = {
    tradeBase: TRADE_BASE,
    dataBase: DATA_BASE,
    alpacaAuthOk: auth.alpacaAuthOk,
    clockOk: false,
    error: null,
  };
  if (!auth.alpacaAuthOk) return status;
  try {
    await alpacaRequest({ base: 'trade', path: '/v2/clock', label: 'connectivity_clock' });
    status.clockOk = true;
  } catch (err) {
    status.error = err?.errorMessage || err?.message || 'unknown';
  }
  return status;
}

// --- account / portfolio / clock ----------------------------------------

// Binance adapter helper: snapshot the latest mid-price for a base asset
// (e.g. 'BTC') from the quote cache. The Binance adapter needs this to
// (a) value non-quote balances when computing equity, (b) convert notional
// → quantity at submit time. Returns 0 when unknown — callers handle that
// case (skip equity, throw on submit).
function binanceMidPriceLookup(baseAsset) {
  if (!baseAsset) return 0;
  const canonical = `${String(baseAsset).toUpperCase()}/USD`;
  const lastQuote = lastQuoteFingerprintBySymbol.get(canonical);
  if (!lastQuote) return 0;
  const parts = String(lastQuote).split(':');
  const bid = Number(parts[0]);
  const ask = Number(parts[1]);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return 0;
  return (bid + ask) / 2;
}

async function fetchAccount() {
  if (IS_BINANCE_EXECUTION) {
    return binanceExecution.fetchAccount({ midPriceLookup: binanceMidPriceLookup });
  }
  return alpacaRequest({ base: 'trade', path: '/v2/account', label: 'account' });
}

async function fetchPortfolioHistory(query = {}) {
  // Phase 2 (venue=binance_us): Binance.US has no equity-history endpoint
  // analogous to Alpaca's `/v2/account/portfolio/history`. Dashboard
  // consumers receive empty arrays and surface "history unavailable" —
  // safer than 401-ing on every fetch.
  if (IS_BINANCE_EXECUTION) {
    return { timestamp: [], equity: [], profit_loss: [], profit_loss_pct: [], base_value: 0, timeframe: query?.timeframe || '1H' };
  }
  return alpacaRequest({ base: 'trade', path: '/v2/account/portfolio/history', query, label: 'portfolio_history' });
}

async function fetchActivities(query = {}) {
  // Phase 2 (venue=binance_us): Alpaca-only activities feed. Binance.US
  // has `/api/v3/myTrades` per-symbol — different shape, more granular —
  // so a faithful translation would have to fan out per held symbol. The
  // only live consumer is the dashboard's `getRecentBuyFillLookup` cache
  // (display-only, not in the trade decision path), so empty is the
  // honest answer until a Binance fills translator ships.
  if (IS_BINANCE_EXECUTION) return { items: [], nextPageToken: null };
  const items = await alpacaRequest({ base: 'trade', path: '/v2/account/activities', query, label: 'activities' });
  return { items: Array.isArray(items) ? items : [], nextPageToken: null };
}

async function fetchClock() {
  // Phase 2 (venue=binance_us): crypto trades 24/7 on Binance.US — there's
  // no concept of "market closed." Returning a synthetic clock keeps any
  // existing consumer of `fetchClock` venue-agnostic without an Alpaca call.
  if (IS_BINANCE_EXECUTION) {
    const nowIso = new Date().toISOString();
    return { is_open: true, timestamp: nowIso, next_open: nowIso, next_close: nowIso };
  }
  return alpacaRequest({ base: 'trade', path: '/v2/clock', label: 'clock' });
}

// --- positions / assets --------------------------------------------------

async function fetchPositions() {
  if (IS_BINANCE_EXECUTION) {
    return binanceExecution.fetchPositions({
      universe: binanceSymbols.listCanonicalSymbols(),
      midPriceLookup: binanceMidPriceLookup,
    });
  }
  const list = await alpacaRequest({ base: 'trade', path: '/v2/positions', label: 'positions' });
  return Array.isArray(list) ? list : [];
}

async function fetchPosition(symbol) {
  if (IS_BINANCE_EXECUTION) {
    return binanceExecution.fetchPosition(symbol, {
      midPriceLookup: binanceMidPriceLookup,
    });
  }
  const apiSym = toAlpacaSymbol(symbol) || symbol;
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/positions/${encodeURIComponent(apiSym)}`, label: 'position' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function fetchAsset(symbol) {
  // Phase 2 (venue=binance_us): Alpaca's `/v2/assets/{symbol}` returns
  // an Asset object (tradable flag, class, fractionable). The Binance
  // equivalent — `binanceSymbols.resolveBinanceSymbol` — exposes
  // tradability via the LOT_SIZE / status fields. Synthesise an
  // Alpaca-shape asset record so existing consumers stay venue-agnostic.
  if (IS_BINANCE_EXECUTION) {
    const resolution = binanceSymbols.resolveBinanceSymbol(symbol);
    if (!resolution) return null;
    return {
      symbol,
      name: symbol,
      class: 'crypto',
      exchange: 'BINANCEUS',
      status: resolution.status === 'TRADING' ? 'active' : 'inactive',
      tradable: resolution.status === 'TRADING',
      fractionable: true,
      min_order_size: resolution.minQty != null ? String(resolution.minQty) : '0',
      min_trade_increment: resolution.stepSize || '0',
      price_increment: resolution.tickSize || '0',
    };
  }
  const apiSym = toAlpacaSymbol(symbol) || symbol;
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/assets/${encodeURIComponent(apiSym)}`, label: 'asset' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

// --- orders --------------------------------------------------------------

const OPEN_ORDER_STATUSES = new Set([
  'new', 'accepted', 'pending_new', 'accepted_for_bidding', 'partially_filled',
  'pending_replace', 'pending_cancel', 'replaced', 'done_for_day', 'stopped',
  'held',
]);

function isOpenLikeOrderStatus(status) {
  return OPEN_ORDER_STATUSES.has(String(status || '').toLowerCase());
}

function expandNestedOrders(orders) {
  const flat = [];
  (Array.isArray(orders) ? orders : []).forEach((o) => {
    if (!o) return;
    flat.push(o);
    if (Array.isArray(o.legs)) o.legs.forEach((leg) => leg && flat.push(leg));
  });
  return flat;
}

async function fetchOrders(query = {}) {
  if (IS_BINANCE_EXECUTION) {
    return binanceExecution.fetchOrders({
      status: query.status || 'open',
      symbol: query.symbol || null,
      limit: query.limit,
    });
  }
  const q = { ...query };
  if (q.nested === true) q.nested = 'true';
  if (q.nested === false) delete q.nested;
  const list = await alpacaRequest({ base: 'trade', path: '/v2/orders', query: q, label: 'orders' });
  return Array.isArray(list) ? list : [];
}

async function fetchOrderById(id, opts = {}) {
  if (IS_BINANCE_EXECUTION) {
    return binanceExecution.fetchOrderById(id, { symbol: opts.symbol || null });
  }
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, label: 'order_by_id' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function replaceOrder(id, body) {
  if (IS_BINANCE_EXECUTION) {
    return binanceExecution.replaceOrder(id, body, { symbol: body?.symbol || null });
  }
  return alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, method: 'PATCH', body: body || {}, label: 'replace_order' });
}

async function cancelOrder(id, opts = {}) {
  if (IS_BINANCE_EXECUTION) {
    return binanceExecution.cancelOrder(id, { symbol: opts.symbol || null });
  }
  try {
    await alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, method: 'DELETE', label: 'cancel_order' });
    return { canceled: true, id };
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 422) {
      return { canceled: false, id, status: err?.statusCode || null, reason: err?.errorMessage || null };
    }
    throw err;
  }
}

// `submitOrder` handles /buy, /orders, and /trade POSTs. For a BUY it returns
// { ok, buy, sell } (sell attaches later via the exit manager once filled).
async function submitOrder(payload = {}) {
  if (IS_BINANCE_EXECUTION) {
    // Inject midPriceLookup so the adapter can convert notional→quantity
    // and run the MIN_NOTIONAL pre-flight. limit_price is also used as
    // a fallback reference (see binanceExecution.js submitOrder).
    return withOrderSubmitQueue(() => binanceExecution.submitOrder({
      ...payload,
      midPriceLookup: (canonical) => {
        const base = String(canonical).split('/')[0];
        return binanceMidPriceLookup(base);
      },
    }));
  }
  const symbol = payload.symbol;
  const side = String(payload.side || 'buy').toLowerCase();
  const apiSym = toAlpacaSymbol(symbol) || symbol;
  const body = {
    symbol: apiSym,
    side,
    type: payload.type || 'limit',
    time_in_force: payload.time_in_force || 'gtc',
  };
  if (payload.qty != null) body.qty = String(payload.qty);
  if (payload.notional != null) body.notional = String(payload.notional);
  if (payload.limit_price != null) body.limit_price = String(payload.limit_price);
  if (payload.client_order_id) body.client_order_id = payload.client_order_id;
  const order = await withOrderSubmitQueue(() => alpacaRequest({ base: 'trade', path: '/v2/orders', method: 'POST', body, label: 'submit_order' }));
  if (side === 'buy') {
    return { ok: true, buy: order, sell: null };
  }
  return order;
}

// --- market data --------------------------------------------------------

function normalizeSymbolsParam(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    const norm = normalizePair(String(s || '').trim());
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(norm); }
  }
  return out;
}

async function fetchCryptoQuotes({ symbols, location = 'us' }) {
  const list = normalizeSymbolsParam(symbols);
  if (!list.length) return { quotes: {} };
  if (IS_BINANCE_EXECUTION) {
    // Phase 2 data dispatch: Binance.US bookTicker. Response shape
    // matches Alpaca's `{ quotes: { 'BTC/USD': { ap, as, bp, bs, t } } }`
    // so downstream callers (entry-quote prefetch, staleness check,
    // signal evaluators) see identical inputs.
    const payload = await binanceMarketData.fetchBookTickers({ symbols: list });
    lastQuoteAt = Date.now();
    lastQuoteSymbol = list[0] || null;
    return payload || { quotes: {} };
  }
  const payload = await alpacaRequest({
    base: 'data',
    path: `/v1beta3/crypto/${encodeURIComponent(location)}/latest/quotes`,
    query: { symbols: list.join(',') },
    label: 'crypto_quotes_latest',
  });
  lastQuoteAt = Date.now();
  lastQuoteSymbol = list[0] || null;
  return payload || { quotes: {} };
}

// Batched warm-up for the entry-scan quote loop. Splits the candidate list
// into chunks of `chunkSize` (capped at 20 by Alpaca's URL-length limits) and
// issues one multi-symbol /latest/quotes call per chunk instead of one call
// per symbol from the entry loop. A single chunk that fails just leaves its
// symbols absent from the returned Map — the per-symbol entry loop falls back
// to a single-symbol fetch for any missing pair.
async function prefetchQuotesForCandidates(candidates, chunkSize) {
  const map = new Map();
  if (!Array.isArray(candidates) || candidates.length === 0) return map;
  const size = Math.max(1, Math.min(20, Math.floor(Number(chunkSize) || 8)));
  for (let i = 0; i < candidates.length; i += size) {
    const chunk = candidates.slice(i, i + size);
    try {
      const payload = await fetchCryptoQuotes({ symbols: chunk });
      const quotes = payload?.quotes || {};
      for (const pair of chunk) {
        const q = quotes[pair] || quotes[toAlpacaSymbol(pair)];
        if (q) map.set(pair, q);
      }
    } catch (err) {
      console.warn('entry_quote_prefetch_chunk_failed', {
        symbols: chunk,
        error: err?.errorMessage || err?.message,
      });
    }
  }
  return map;
}

async function fetchCryptoTrades({ symbols, location = 'us' }) {
  const list = normalizeSymbolsParam(symbols);
  if (!list.length) return { trades: {} };
  // Phase 2 (venue=binance_us): trades feed is only consumed by the
  // microstructure signal's flow-imbalance feature (MICRO_TRADES_ENABLED,
  // default off). Return empty until the Binance trades feed is wired
  // (Phase 3 follow-up). With the default flag off this branch is
  // observational; downstream `computeFlowImbalance` returns 0 when the
  // trades array is empty, which matches the Phase 1 default behaviour.
  if (IS_BINANCE_EXECUTION) return { trades: {} };
  return alpacaRequest({
    base: 'data',
    path: `/v1beta3/crypto/${encodeURIComponent(location)}/latest/trades`,
    query: { symbols: list.join(',') },
    label: 'crypto_trades_latest',
  }) || { trades: {} };
}

// Latest L2 snapshot from Alpaca crypto. Only invoked when
// ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true so the default deployment adds
// no incremental rate-limit pressure. Each entry is { symbol -> { a: [...], b: [...] } }
// where a/b are arrays of { p, s } (price, size) sorted best-first.
async function fetchCryptoOrderbooks({ symbols, location = 'us' }) {
  const list = normalizeSymbolsParam(symbols);
  if (!list.length) return { orderbooks: {} };
  // Phase 3 (2026-06-02): venue=binance_us routes the L2 orderbook through
  // Binance.US's public /api/v3/depth feed so the microstructure signal's
  // bookImbalance / microprice features see real depth instead of a null
  // book. Consumed only when ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true
  // (default off), so this fetch stays dormant until an operator opts in.
  if (IS_BINANCE_EXECUTION) {
    try {
      return await binanceMarketData.fetchOrderbooks({ symbols: list });
    } catch (err) {
      return { orderbooks: {} };
    }
  }
  return alpacaRequest({
    base: 'data',
    path: `/v1beta3/crypto/${encodeURIComponent(location)}/latest/orderbooks`,
    query: { symbols: list.join(',') },
    label: 'crypto_orderbooks_latest',
  }) || { orderbooks: {} };
}

// Top-N orderbook imbalance: (bidNotional − askNotional) / (bidNotional + askNotional)
// summed over the best `levels` levels per side. Range [-1, +1]; positive
// means more buy-side depth, negative means more sell-side. Returns null if
// the book is malformed or one side is empty.
function computeOrderbookImbalance(book, levels = 5) {
  const asks = Array.isArray(book?.a) ? book.a : [];
  const bids = Array.isArray(book?.b) ? book.b : [];
  if (!asks.length || !bids.length) return null;
  const sumNotional = (side) => {
    let total = 0;
    for (let i = 0; i < Math.min(levels, side.length); i += 1) {
      const p = Number(side[i]?.p);
      const s = Number(side[i]?.s);
      if (Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0) total += p * s;
    }
    return total;
  };
  const askNotional = sumNotional(asks);
  const bidNotional = sumNotional(bids);
  const denom = askNotional + bidNotional;
  if (denom <= 0) return null;
  return (bidNotional - askNotional) / denom;
}

async function fetchCryptoBars({ symbols, location = 'us', limit = 6, timeframe = '1Min' }) {
  const list = normalizeSymbolsParam(symbols);
  if (!list.length) return { bars: {} };
  const cacheKey = `${location}:${timeframe}:${limit}:${list.join(',')}`;
  if (IS_BINANCE_EXECUTION) {
    // Phase 2 data dispatch: Binance.US klines. Returns oldest-first
    // bars matching the post-reverse Alpaca shape. The cache and the
    // engine's `bars.slice(0, -1)` (drop in-progress bar) semantics
    // work unchanged.
    try {
      const payload = await binanceMarketData.fetchKlines({
        symbols: list, timeframe, limit,
      });
      barsCache.set(cacheKey, { at: Date.now(), payload });
      return payload;
    } catch (err) {
      const cached = barsCache.get(cacheKey);
      if (cached && (Date.now() - cached.at) <= BARS_CACHE_TTL_MS) return cached.payload;
      return { bars: {} };
    }
  }
  // Without an explicit `start`, /v1beta3/crypto/{loc}/bars has been observed
  // in production to return 200 OK with empty `bars:{}` for every requested
  // symbol — which the predictor surfaces as `insufficient_bars` for every
  // scan, blocking all entries. We pass a 24 h lookback `start` (more than
  // enough for our 1m and 5m timeframes) and `sort=desc` so the endpoint
  // returns the most recent `limit` bars regardless of how many bars exist
  // in the lookback window. We then reverse to chronological order so
  // existing callers continue to see oldest-first arrays and the
  // `bars.slice(0, -1)` "drop the in-progress newest bar" semantics keep
  // working unchanged.
  const startIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (let attempt = 0; attempt <= BARS_FETCH_RETRIES; attempt += 1) {
    try {
      const payload = await alpacaRequest({
        base: 'data',
        path: `/v1beta3/crypto/${encodeURIComponent(location)}/bars`,
        query: { symbols: list.join(','), timeframe, limit, start: startIso, sort: 'desc' },
        label: 'crypto_bars',
      }) || { bars: {} };
      if (payload && payload.bars && typeof payload.bars === 'object') {
        for (const key of Object.keys(payload.bars)) {
          const arr = payload.bars[key];
          if (Array.isArray(arr)) payload.bars[key] = arr.slice().reverse();
        }
      }
      barsCache.set(cacheKey, { at: Date.now(), payload });
      return payload;
    } catch (err) {
      if (attempt >= BARS_FETCH_RETRIES) break;
      await sleep(ALPACA_REQ_BASE_BACKOFF_MS * (2 ** attempt));
    }
  }
  const cached = barsCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) <= BARS_CACHE_TTL_MS) return cached.payload;
  return { bars: {} };
}

async function fetchStockQuotes({ symbols }) {
  const list = (Array.isArray(symbols) ? symbols : String(symbols || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { quotes: {} };
  return alpacaRequest({ base: 'data', path: '/v2/stocks/quotes/latest', query: { symbols: list.join(',') }, label: 'stocks_quotes_latest' }) || { quotes: {} };
}

async function fetchStockTrades({ symbols }) {
  const list = (Array.isArray(symbols) ? symbols : String(symbols || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { trades: {} };
  return alpacaRequest({ base: 'data', path: '/v2/stocks/trades/latest', query: { symbols: list.join(',') }, label: 'stocks_trades_latest' }) || { trades: {} };
}

async function fetchStockBars({ symbols, limit = 6, timeframe = '1Min' }) {
  const list = (Array.isArray(symbols) ? symbols : String(symbols || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { bars: {} };
  return alpacaRequest({ base: 'data', path: '/v2/stocks/bars', query: { symbols: list.join(','), timeframe, limit }, label: 'stocks_bars' }) || { bars: {} };
}

async function getLatestQuote(symbol) {
  const pair = normalizePair(symbol);
  if (!pair) return null;
  const payload = await fetchCryptoQuotes({ symbols: [pair] });
  const key = pair;
  const quote = payload?.quotes?.[key] || payload?.quotes?.[toAlpacaSymbol(pair)] || null;
  return quote;
}

async function getLatestPrice(symbol) {
  const pair = normalizePair(symbol);
  if (!pair) return null;
  const payload = await fetchCryptoTrades({ symbols: [pair] });
  const trade = payload?.trades?.[pair] || payload?.trades?.[toAlpacaSymbol(pair)] || null;
  const price = Number(trade?.p);
  return Number.isFinite(price) ? price : null;
}

// --- supported crypto universe ------------------------------------------

let supportedPairsSnapshot = { pairs: [], lastUpdated: null };
let supportedPairsLoading = null;

// Stablecoins can't realistically move our desired-profit target, so they'd
// sit on open-sell forever and eat a slot. Exclude the base assets here.
const STABLECOIN_BASES = new Set([
  'USDT', 'USDC', 'USDG', 'DAI', 'PYUSD', 'USDP', 'GUSD', 'TUSD', 'BUSD', 'FDUSD', 'LUSD', 'USDD', 'USDE',
]);

async function loadSupportedCryptoPairs() {
  if (supportedPairsLoading) return supportedPairsLoading;
  // Phase 2 (venue=binance_us): the bot's universe is `configured` by
  // default (post-2026-05-16 flip), so the dynamic universe filter that
  // consumes this snapshot is dormant. Skip the Alpaca call cleanly
  // rather than warning with `load_supported_crypto_pairs_failed`.
  // Binance.US equivalent (resolvedSymbols from binanceSymbols.hydrate)
  // is already populated separately at boot for the configured universe.
  if (IS_BINANCE_EXECUTION) {
    supportedPairsSnapshot = {
      pairs: Object.keys(binanceSymbols.getCanonicalResolution()),
      lastUpdated: new Date().toISOString(),
    };
    return supportedPairsSnapshot;
  }
  supportedPairsLoading = (async () => {
    try {
      const assets = await alpacaRequest({
        base: 'trade',
        path: '/v2/assets',
        query: { asset_class: 'crypto', status: 'active' },
        label: 'assets_crypto',
      });
      const tradable = (Array.isArray(assets) ? assets : [])
        .filter((a) => a && a.tradable !== false)
        .map((a) => normalizePair(a.symbol))
        .filter((pair) => pair && pair.endsWith('/USD'))
        .filter((pair) => !STABLECOIN_BASES.has(pair.split('/')[0]));
      supportedPairsSnapshot = {
        pairs: Array.from(new Set(tradable)),
        lastUpdated: new Date().toISOString(),
      };
    } catch (err) {
      console.warn('load_supported_crypto_pairs_failed', err?.errorMessage || err?.message || err);
    } finally {
      supportedPairsLoading = null;
    }
    return supportedPairsSnapshot;
  })();
  return supportedPairsLoading;
}

function getSupportedCryptoPairsSnapshot() { return supportedPairsSnapshot; }

function filterSupportedCryptoSymbols(symbols) {
  const allowed = new Set(supportedPairsSnapshot.pairs || []);
  if (!allowed.size) return normalizeSymbolsParam(symbols);
  return normalizeSymbolsParam(symbols).filter((s) => allowed.has(s));
}

// --- asset tick cache / price formatting -------------------------------
//
// Alpaca rejects limit prices that don't conform to the symbol's
// `price_increment`. The old code did `target.toFixed(8).replace(/0+$/, '')`,
// which emits "0.00002345"-style values that violate tick for low-priced
// coins → buy fills, sell rejects, position sits naked.

const assetTickCache = new Map(); // pair -> { priceIncrement, minTradeIncrement }

async function getAssetTickInfo(pair) {
  const cached = assetTickCache.get(pair);
  if (cached) return cached;
  let info = { priceIncrement: null, minTradeIncrement: null };
  try {
    const asset = await fetchAsset(pair);
    const priceInc = Number(asset?.price_increment);
    const minInc = Number(asset?.min_trade_increment);
    info = {
      priceIncrement: Number.isFinite(priceInc) && priceInc > 0 ? priceInc : null,
      minTradeIncrement: Number.isFinite(minInc) && minInc > 0 ? minInc : null,
    };
  } catch (_) { /* leave null; roundPriceToTick falls back to magnitude-based decimals */ }
  assetTickCache.set(pair, info);
  return info;
}

function tickDecimals(tick) {
  if (!Number.isFinite(tick) || tick <= 0) return 8;
  // Math.log10 of a power-of-10 tick can have FP drift; add a tiny epsilon.
  const raw = -Math.log10(tick);
  return Math.max(0, Math.min(10, Math.ceil(raw - 1e-9)));
}

function roundPriceToTick(price, tick) {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (Number.isFinite(tick) && tick > 0) {
    const rounded = Math.round(price / tick) * tick;
    return Number(rounded.toFixed(tickDecimals(tick)));
  }
  // Fallback: magnitude-based decimals.
  const abs = Math.abs(price);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return Number(price.toFixed(decimals));
}

function formatTickPrice(price, tick) {
  const rounded = roundPriceToTick(price, tick);
  if (!Number.isFinite(rounded) || rounded <= 0) return null;
  return String(rounded);
}

// --- entry predictor ----------------------------------------------------
//
// Given N recent 1m bars, fit a linear regression to the closes and emit
// slope, R^2, and the slope t-statistic. The net-edge gate downstream is
// the authoritative filter — it requires probability-weighted expected
// edge to clear MIN_NET_EDGE_BPS after fees and slippage, which implicitly
// demands both a meaningful slope and a clean fit. The only extra check
// here is that the last 3 closes are non-decreasing (current-candle
// direction sanity), which is a different signal from the t-stat.

async function getPredictionSignal(pair) {
  try {
    // Request PREDICT_BARS + headroom so that after dropping the (likely
    // in-progress) most recent bar there are still PREDICT_BARS closed bars to
    // fit on, even when the upstream occasionally returns one or two fewer
    // bars than `limit` (observed on /v1beta3/crypto/us/bars). With +1 a
    // single missing bar yields PREDICT_BARS-1 closes and rejects every
    // candidate as `insufficient_bars`. +5 is the smallest safe headroom.
    const payload = await fetchCryptoBars({
      symbols: [pair],
      limit: PREDICT_BARS + 5,
      timeframe: '1Min',
    });
    const bars = payload?.bars?.[pair] || payload?.bars?.[toAlpacaSymbol(pair)] || [];
    maybeUpdateMarketRegimeFromBars(pair, bars);
    const closedBars = bars.slice(0, -1);
    const closes = closedBars.map((b) => Number(b?.c)).filter((v) => Number.isFinite(v) && v > 0);
    const volumes = closedBars.map((b) => Number(b?.v)).filter((v) => Number.isFinite(v) && v >= 0);
    if (closes.length < PREDICT_BARS) {
      return { ok: false, reason: 'insufficient_bars' };
    }

    const n = closes.length;
    const meanX = (n - 1) / 2;
    const meanY = closes.reduce((s, c) => s + c, 0) / n;
    let num = 0;
    let denX = 0;
    let denY = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = i - meanX;
      const dy = closes[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const slope = denX > 0 ? num / denX : 0;
    const slopeBpsPerBar = meanY > 0 ? (slope / meanY) * 10000 : 0;
    const rSquared = denX > 0 && denY > 0 ? (num * num) / (denX * denY) : 0;

    const slopeTStat = slopeTStatFromOls({ slope, denX, denY, rSquared, n });

    const tail = closes.slice(-4);
    let downMoves = 0;
    for (let i = 1; i < tail.length; i += 1) if (tail[i] < tail[i - 1]) downMoves += 1;
    const tailDrawdownBps = tail.length >= 2 && tail[0] > 0 ? ((tail[tail.length - 1] - tail[0]) / tail[0]) * 10000 : 0;
    const shortTermOk = MAJOR_ASSET_DIP_EXCEPTION.has(pair) || !(downMoves >= 3 && tailDrawdownBps <= -8);

    // Volatility of 1m bar-to-bar returns, expressed in bps. Used by the
    // entry vol-cap gate; does not affect the sell-side logic.
    let volatilityBps = null;
    if (closes.length >= 2) {
      const returns = [];
      for (let i = 1; i < closes.length; i += 1) {
        const prev = closes[i - 1];
        if (prev > 0) returns.push((closes[i] - prev) / prev);
      }
      if (returns.length >= 2) {
        const meanR = returns.reduce((s, r) => s + r, 0) / returns.length;
        const varR = returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / (returns.length - 1);
        volatilityBps = Math.sqrt(Math.max(0, varR)) * 10000;
      }
    }

    // Volume features. volumeRatio = mean(recent N) / mean(all). >1 means
    // volume is rising in the recent window (momentum confirmation), <1 means
    // it's fading. volumeWeightedSlopeBps reweights the OLS by per-bar volume:
    // when it agrees with slopeBpsPerBar, the move is volume-confirmed; when
    // it disagrees, the trend is being pushed by low-volume noise.
    let volumeRatio = null;
    let volumeWeightedSlopeBps = null;
    let recentVolumeMean = null;
    if (volumes.length === closes.length && volumes.length >= PREDICT_BARS) {
      const totalVolMean = volumes.reduce((s, v) => s + v, 0) / volumes.length;
      const recentWindow = Math.max(3, Math.floor(volumes.length / 4));
      const recentSlice = volumes.slice(-recentWindow);
      recentVolumeMean = recentSlice.reduce((s, v) => s + v, 0) / recentSlice.length;
      if (totalVolMean > 0) volumeRatio = recentVolumeMean / totalVolMean;

      const totalVol = volumes.reduce((s, v) => s + v, 0);
      if (totalVol > 0) {
        let wMeanX = 0;
        let wMeanY = 0;
        for (let i = 0; i < n; i += 1) {
          wMeanX += i * volumes[i];
          wMeanY += closes[i] * volumes[i];
        }
        wMeanX /= totalVol;
        wMeanY /= totalVol;
        let wNum = 0;
        let wDenX = 0;
        for (let i = 0; i < n; i += 1) {
          const dx = i - wMeanX;
          wNum += volumes[i] * dx * (closes[i] - wMeanY);
          wDenX += volumes[i] * dx * dx;
        }
        const wSlope = wDenX > 0 ? wNum / wDenX : 0;
        volumeWeightedSlopeBps = wMeanY > 0 ? (wSlope / wMeanY) * 10000 : 0;
      }
    }

    const reason = shortTermOk ? null : 'short_term_dip';

    return {
      ok: reason == null,
      reason,
      slopeBpsPerBar,
      rSquared,
      slopeTStat,
      projectedBps: slopeBpsPerBar * PREDICT_BARS,
      volatilityBps,
      volumeRatio,
      volumeWeightedSlopeBps,
      recentVolumeMean,
      closes,
    };
  } catch (err) {
    return { ok: false, reason: 'bars_fetch_failed', error: err?.message };
  }
}

// Higher-timeframe confirmation. Fits a linear regression to the last
// HTF_BARS bars at HTF_TIMEFRAME (default 5m x 12 = 1h) and rejects when the
// slope is clearly negative. Catches the case where a faint 1m uptick is
// actually a bounce inside a larger downtrend.
async function getHigherTimeframeSignal(pair) {
  if (!HTF_FILTER_ENABLED) return { ok: true, reason: 'disabled' };
  try {
    // Request HTF_BARS + headroom so that after dropping the in-progress bar
    // we still have HTF_BARS closed bars even if upstream short-supplies by a
    // bar or two (same robustness fix as the 1m predictor above).
    const payload = await fetchCryptoBars({
      symbols: [pair],
      limit: HTF_BARS + 5,
      timeframe: HTF_TIMEFRAME,
    });
    const bars = payload?.bars?.[pair] || payload?.bars?.[toAlpacaSymbol(pair)] || [];
    const closedBars = bars.slice(0, -1);
    const closes = closedBars.map((b) => Number(b?.c)).filter((v) => Number.isFinite(v) && v > 0);
    if (closes.length < HTF_BARS) return { ok: false, reason: 'htf_insufficient_bars' };

    const n = closes.length;
    const meanX = (n - 1) / 2;
    const meanY = closes.reduce((s, c) => s + c, 0) / n;
    let num = 0;
    let denX = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = i - meanX;
      num += dx * (closes[i] - meanY);
      denX += dx * dx;
    }
    const slope = denX > 0 ? num / denX : 0;
    const slopeBpsPerBar = meanY > 0 ? (slope / meanY) * 10000 : 0;

    if (slopeBpsPerBar < HTF_MIN_SLOPE_BPS_PER_BAR) {
      return { ok: false, reason: 'htf_downtrend', slopeBpsPerBar };
    }
    return { ok: true, slopeBpsPerBar };
  } catch (err) {
    return { ok: false, reason: 'htf_fetch_failed', error: err?.message };
  }
}

// Multi-factor signal wrapper. Fetches the three timeframes the new signal
// needs (1m / 5m / 15m bars) plus the orderbook in parallel, then evaluates
// the factor vote. Returns the same shape as getPredictionSignal so the
// rest of the entry path can consume it without further branching.
async function getMultiFactorSignalForPair(pair, quote) {
  try {
    const [bars1mPayload, bars5mPayload, bars15mPayload, obPayload] = await Promise.all([
      fetchCryptoBars({ symbols: [pair], limit: 32, timeframe: '1Min' }),
      fetchCryptoBars({ symbols: [pair], limit: 24, timeframe: '5Min' }),
      fetchCryptoBars({ symbols: [pair], limit: 24, timeframe: '15Min' }),
      fetchCryptoOrderbooks({ symbols: [pair] }).catch((err) => {
        console.warn('orderbook_fetch_failed', { symbol: pair, error: err?.message });
        return { orderbooks: {} };
      }),
    ]);
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    const bars5m = bars5mPayload?.bars?.[pair] || bars5mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    const bars15m = bars15mPayload?.bars?.[pair] || bars15mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    const orderbook = obPayload?.orderbooks?.[pair] || obPayload?.orderbooks?.[toAlpacaSymbol(pair)] || null;
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const btcLeadLag = pair === BTC_LEAD_LAG_SYMBOL ? null : getBtcLeadLagSnapshot();
    const sig = evaluateMultiFactorSignal({
      pair,
      bars1m,
      bars5m,
      bars15m,
      orderbook,
      quote: quote ? { bid: Number(quote.bp), ask: Number(quote.ap) } : null,
      btcLeadLag,
    });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m, bars5m, bars15m, orderbook };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'multi_factor_signal_failed', error: err?.message };
  }
}

// Mean-reversion-at-extremes signal wrapper. Only needs 1m bars (the
// signal's math: cumulative drop + vol-normalized significance + volume
// confirmation + BTC decorrelation + RSI oversold). Fetches enough bars
// to satisfy meanReversionSignal.requiredBars + headroom for the drop +
// in-progress bar.
async function getMeanReversionSignalForPair(pair, timeframe = '1m') {
  // Per-timeframe blocklist guard (2026-05-18). Refuses entries on symbols
  // documented as structural losers for this MR timeframe. Returns BEFORE
  // any network call so a blocked pair costs zero bars-fetched per scan.
  if (symbolBlocklist.isMrPairBlocked(pair, timeframe, MR_BLOCKLISTS)) {
    return { ok: false, reason: 'mr_symbol_blocklisted' };
  }
  try {
    // Fetch enough 1m bars to support 1m, 5m (×5), or 15m (×15) aggregation.
    // 36 bars × 15 = 540 bars covers the 15m variant at requiredBars=32.
    const limit = timeframe === '15m' ? 540 : (timeframe === '5m' ? 180 : 36);
    const bars1mPayload = await fetchCryptoBars({ symbols: [pair], limit, timeframe: '1Min' });
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const btcLeadLag = pair === BTC_LEAD_LAG_SYMBOL ? null : getBtcLeadLagSnapshot();
    const sig = evaluateMeanReversionSignal({ pair, bars1m, btcLeadLag, timeframe, config: MR_SIGNAL_CONFIG_OVERRIDES });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'mean_reversion_signal_failed', error: err?.message };
  }
}

// BTC lead-lag signal wrapper (2026-06-08). Trades the cross-asset lag: when
// BTC has just moved up and this alt has not yet caught up, go long expecting
// it to follow. Reads the same btcLeadLag snapshot the engine already maintains
// (recorded when BTC/USD is scanned). BTC itself has no lead source, so the
// signal refuses BTC. Needs only a short 1m history for vol + the lag window.
async function getBtcLeadLagSignalForPair(pair) {
  // BTC is the LEADER, not a tradable target here. But we still must fetch its
  // bars and refresh the lead-lag snapshot — otherwise, with btc_lead_lag as
  // the active signal, nothing else would ever populate it (the legacy
  // recordBtcLeadLagSnapshot path needs an ok:true BTC signal, which this
  // signal never produces for BTC). Refresh here, then refuse to trade BTC.
  // NOTE: this relies on BTC/USD being scanned BEFORE the alts each cycle so
  // the alts see a fresh snapshot (enforced by orderUniverseBtcFirst).
  if (pair === BTC_LEAD_LAG_SYMBOL) {
    try {
      const btcPayload = await fetchCryptoBars({ symbols: [pair], limit: 40, timeframe: '1Min' });
      const btcBars = btcPayload?.bars?.[pair] || btcPayload?.bars?.[toAlpacaSymbol(pair)] || [];
      maybeUpdateMarketRegimeFromBars(pair, btcBars);
      // Closed bars only (drop the in-progress bar), matching the sig.closes
      // convention recordBtcLeadLagSnapshot expects.
      const closes = [];
      for (const b of btcBars.slice(0, -1)) {
        const c = Number(b?.c ?? b?.close);
        if (Number.isFinite(c) && c > 0) closes.push(c);
      }
      if (closes.length >= 5) recordBtcLeadLagSnapshot({ ok: true, closes });
    } catch (_) { /* snapshot refresh is best-effort; never fatal */ }
    return { ok: false, reason: 'btc_is_leader' };
  }
  try {
    const bars1mPayload = await fetchCryptoBars({ symbols: [pair], limit: 40, timeframe: '1Min' });
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const btcLeadLag = getBtcLeadLagSnapshot();
    const sig = evaluateBtcLeadLagSignal({ pair, bars1m, btcLeadLag, config: BLL_SIGNAL_CONFIG_OVERRIDES });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'btc_lead_lag_signal_failed', error: err?.message };
  }
}

// Phase 1: range mean-reversion signal wrapper. Smaller drops within an
// established range; only needs 1m bars (more of them than capitulation MR
// because the range identification window is wider).
async function getRangeMeanReversionSignalForPair(pair) {
  // Symbol blocklist (2026-05-18). Same pattern as MR — Range-MR ships with
  // an empty blocklist by default (no symbol has a documented edge problem
  // here yet); the knob exists so an operator can add one without a code
  // change if the live scorecard surfaces one.
  if (symbolBlocklist.isPairBlocked(pair, MR_BLOCKLISTS.rangeMr)) {
    return { ok: false, reason: 'range_mr_symbol_blocklisted' };
  }
  try {
    // limit=80: signal requires 64 closed bars; +1 for in-progress; +15
    // headroom for symbols where Alpaca returns a slightly thin bar set
    // (low-volume alts sometimes come back below the requested limit).
    const bars1mPayload = await fetchCryptoBars({ symbols: [pair], limit: 80, timeframe: '1Min' });
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const sig = evaluateRangeMeanReversionSignal({ pair, bars1m });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'range_mean_reversion_signal_failed', error: err?.message };
  }
}

// Barrier signal wrapper — restored from the project's initial commit
// (fbdb924, Jan 18 2026). The signal needs 16 1m bars (EWMA vol + EMA
// momentum lookback), the live quote (for spread + micro-momentum) and
// (optionally) the orderbook for the obBias term. Fetches in parallel
// matching the multi-factor wrapper's pattern.
async function getBarrierSignalForPair(pair, quote = null) {
  try {
    const [bars1mPayload, obPayload] = await Promise.all([
      fetchCryptoBars({ symbols: [pair], limit: 16, timeframe: '1Min' }),
      fetchCryptoOrderbooks({ symbols: [pair] }).catch((err) => {
        console.warn('orderbook_fetch_failed', { symbol: pair, error: err?.message });
        return { orderbooks: {} };
      }),
    ]);
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    const orderbook = obPayload?.orderbooks?.[pair] || obPayload?.orderbooks?.[toAlpacaSymbol(pair)] || null;
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const sig = evaluateBarrierSignal({
      pair,
      bars1m,
      orderbook,
      quote: quote ? { bid: Number(quote.bp), ask: Number(quote.ap) } : null,
      config: {
        desiredNetBps: BARRIER_DESIRED_NET_BPS,
        evMinBps: BARRIER_EV_MIN_BPS,
        feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
      },
    });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m, orderbook };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'barrier_signal_failed', error: err?.message };
  }
}

// Trend-following signal wrapper (2026-05-28). Needs ~70 1m bars to clear
// the requiredBars floor; fetch 80 for the same slack the range-MR wrapper
// uses. No orderbook or partner symbol dependency, so this is the simplest
// of the new wrappers.
async function getTrendFollowingSignalForPair(pair) {
  try {
    const bars1mPayload = await fetchCryptoBars({ symbols: [pair], limit: 80, timeframe: '1Min' });
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const sig = evaluateTrendFollowingSignal({
      pair,
      bars1m,
      config: {
        lookbackBars: TREND_FOLLOWING_LOOKBACK_BARS,
        volMultiplier: TREND_FOLLOWING_VOL_MULTIPLIER,
        minSlopeBpsPerBar: TREND_FOLLOWING_MIN_SLOPE_BPS_PER_BAR,
        maxStretchAboveSmaBps: TREND_FOLLOWING_MAX_STRETCH_ABOVE_SMA_BPS,
        targetNetBpsFloor: TREND_FOLLOWING_TARGET_NET_BPS_FLOOR,
        targetNetBpsCap: TREND_FOLLOWING_TARGET_NET_BPS_CAP,
      },
    });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'trend_following_signal_failed', error: err?.message };
  }
}

// Pairs signal wrapper (2026-05-28). The cross-symbol dependency is the
// architectural twist: each scan symbol has a configured partner (or none),
// and the signal evaluator needs bars for BOTH. We fetch them in parallel
// and short-circuit if the partner has no mapping configured for this pair.
async function getPairsSignalForPair(pair) {
  try {
    const partnerPair = PAIRS_PARTNER_INDEX.get(pair) || null;
    if (!partnerPair) {
      return { ok: false, reason: 'pairs_no_partner_defined' };
    }
    const [primaryPayload, partnerPayload] = await Promise.all([
      fetchCryptoBars({ symbols: [pair], limit: 130, timeframe: '1Min' }),
      fetchCryptoBars({ symbols: [partnerPair], limit: 130, timeframe: '1Min' }),
    ]);
    const bars1m = primaryPayload?.bars?.[pair] || primaryPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    const partnerBars1m = partnerPayload?.bars?.[partnerPair]
      || partnerPayload?.bars?.[toAlpacaSymbol(partnerPair)] || [];
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const sig = evaluatePairsSignal({
      pair,
      partnerPair,
      bars1m,
      partnerBars1m,
      config: {
        lookbackBars: PAIRS_LOOKBACK_BARS,
        minRSquared: PAIRS_MIN_R_SQUARED,
        zEntryThreshold: PAIRS_Z_ENTRY_THRESHOLD,
        freshnessBars: PAIRS_FRESHNESS_BARS,
        targetNetBpsFloor: PAIRS_TARGET_NET_BPS_FLOOR,
        targetNetBpsCap: PAIRS_TARGET_NET_BPS_CAP,
      },
    });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m, partnerBars1m };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'pairs_signal_failed', error: err?.message };
  }
}

// Shadow tracker for the trades-feed validation surface. Even when
// MICRO_TRADES_ENABLED=false, MICRO_TRADES_SHADOW_ENABLED (default true)
// causes recent trades to be fetched + flowImbalance observed so the
// operator can validate the trades feed before flipping the live flag.
// The tracker capacity intentionally exceeds the typical scan rate × 5
// minutes so the dashboard window is meaningful across short outages.
const microFlowShadowTracker = createMicroFlowShadowTracker({ windowSize: 500 });
function getMicroFlowShadowTrackerSnapshot() {
  return microFlowShadowTracker.snapshot();
}

// Regime-veto counters (2026-05-20 Phase 2). Tracks how often the
// regime veto fires (vetoed) and how often it WOULD fire if enabled
// (wouldHaveVetoed) — the second counter accumulates the evidence the
// operator needs to flip MARKET_REGIME_VETO_ENABLED=true.
const regimeVetoState = {
  vetoed: 0,
  wouldHaveVetoed: 0,
  lastDecisionAt: null,
  lastDecisionRegime: null,
  lastDecisionReason: null,
  lastDecisionShouldVeto: false,
};
function getRegimeVetoState() {
  return {
    enabled: MARKET_REGIME_VETO_ENABLED,
    config: {
      vetoRegimes: MARKET_REGIME_VETO_REGIMES.slice(),
      consecutiveMs: MARKET_REGIME_VETO_CONSECUTIVE_MS,
      maxSnapshotAgeMs: MARKET_REGIME_VETO_MAX_AGE_MS,
    },
    vetoed: regimeVetoState.vetoed,
    wouldHaveVetoed: regimeVetoState.wouldHaveVetoed,
    lastDecision: regimeVetoState.lastDecisionAt ? {
      at: new Date(regimeVetoState.lastDecisionAt).toISOString(),
      regime: regimeVetoState.lastDecisionRegime,
      reason: regimeVetoState.lastDecisionReason,
      shouldVeto: regimeVetoState.lastDecisionShouldVeto,
    } : null,
  };
}

// Stale-quote retry tracker (2026-05-20). Records every single-symbol
// retry attempt + outcome for dashboard surface. Per-symbol recoveryRate
// is the actionable number: < 10% means the fallback isn't helping and
// the symbol should be blocklisted or the operator should contact Alpaca.
const staleQuoteRetryTracker = createStaleQuoteRetryTracker({ windowSize: 500 });
function getStaleQuoteRetryTrackerSnapshot() {
  return staleQuoteRetryTracker.snapshot();
}

// Microstructure signal wrapper. The signal needs 60 1m bars (RSI(14) +
// 60-bar spread/sigma windows) plus the live quote (for spread + microprice)
// and (optionally) the orderbook for the bookImbalance term. Pattern matches
// the barrier wrapper — orderbook fetch is non-fatal, signal degrades to
// neutral when missing. When MICRO_TRADES_ENABLED=true the signal's
// computeFlowImbalance uses real Lee-Ready aggressor data; when false the
// scoring path uses flowImbalance=0 (Phase 1 behaviour). Independently,
// MICRO_TRADES_SHADOW_ENABLED (default true) still fetches trades and logs
// the flow value observationally — feeding the microFlowShadowTracker so
// the dashboard surfaces it without touching live scoring.
async function getMicrostructureSignalForPair(pair, quote, horizonMinutes) {
  // Per-horizon symbol blocklist (2026-05-20). Same early-return pattern as
  // MR — refuses entries on symbols whose per-trade expectancy is documented
  // as structurally negative for this horizon. Costs zero Alpaca calls for
  // a blocked pair. The auto-backtest applies the same filter via the
  // micro-blocklist plumbing in runBacktestAndStore (index.js) so the
  // selector validates the signal on the SAME universe the live engine trades.
  if (symbolBlocklist.isMicroPairBlocked(pair, horizonMinutes, MICRO_BLOCKLISTS)) {
    return { ok: false, reason: 'micro_symbol_blocklisted' };
  }
  try {
    // Fetch trades when EITHER live scoring or shadow observation is on.
    // Shadow mode is default-on so validation data accumulates automatically;
    // an operator who wants to skip the trades fetch entirely flips
    // MICRO_TRADES_SHADOW_ENABLED=false in Render env.
    //
    // The trades feed is venue-aware. On binance_us (Phase 3 — 2026-06-02)
    // it routes through Binance.US's public /api/v3/trades endpoint, which
    // needs NO auth — so flowImbalance is available on Binance for the first
    // time. On Alpaca it uses /v1beta3/crypto/{loc}/trades, which requires
    // creds: gate on Alpaca auth so a credential-less Alpaca venue silently
    // keeps Phase-1 flowImbalance=0 behaviour instead of hammering an endpoint
    // that can only throw alpaca_auth_missing every scan.
    const tradesDesired = MICRO_TRADES_ENABLED || MICRO_TRADES_SHADOW_ENABLED;
    const alpacaDataAvailable = resolveAlpacaAuth().alpacaAuthOk;
    let tradesFetch;
    if (tradesDesired && IS_BINANCE_EXECUTION) {
      tradesFetch = binanceMarketData.fetchRecentTrades({ symbols: [pair] })
        .catch((err) => {
          console.warn('crypto_trades_fetch_failed', { symbol: pair, venue: 'binance_us', error: err?.message });
          return {};
        });
    } else if (tradesDesired && alpacaDataAvailable) {
      tradesFetch = fetchRecentTrades({
        request: (args) => alpacaRequest({ base: 'data', ...args }),
        symbols: [pair],
      }).catch((err) => {
        console.warn('crypto_trades_fetch_failed', { symbol: pair, error: err?.message });
        return {};
      });
    } else {
      tradesFetch = Promise.resolve({});
    }
    const [bars1mPayload, obPayload, tradesBySymbol] = await Promise.all([
      fetchCryptoBars({ symbols: [pair], limit: 80, timeframe: '1Min' }),
      fetchCryptoOrderbooks({ symbols: [pair] }).catch((err) => {
        console.warn('orderbook_fetch_failed', { symbol: pair, error: err?.message });
        return { orderbooks: {} };
      }),
      tradesFetch,
    ]);
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    const orderbook = obPayload?.orderbooks?.[pair] || obPayload?.orderbooks?.[toAlpacaSymbol(pair)] || null;
    const recentTrades = tradesBySymbol?.[pair] || tradesBySymbol?.[toAlpacaSymbol(pair)] || null;
    maybeUpdateMarketRegimeFromBars(pair, bars1m);
    const btcLeadLag = pair === BTC_LEAD_LAG_SYMBOL ? null : getBtcLeadLagSnapshot();
    // Live quote shape includes top-of-book sizes when available; the
    // microprice computation falls back to neutral microBias if absent.
    const quoteForSignal = quote ? {
      bid: Number(quote.bp),
      ask: Number(quote.ap),
      bidSize: Number(quote.bs),
      askSize: Number(quote.as),
    } : null;
    const sig = evaluateMicrostructureSignal({
      pair,
      bars1m,
      orderbook,
      quote: quoteForSignal,
      btcLeadLag,
      recentTrades,
      horizonMinutes,
      config: {
        spreadZMax: MICRO_SPREAD_Z_MAX,
        minProb: MICRO_MIN_PROB,
        evMinBps: MICRO_EV_MIN_BPS,
        feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
        stopVolMult: MICRO_STOP_VOL_MULT,
        tradesEnabled: MICRO_TRADES_ENABLED,
      },
    });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m, orderbook };
    // Shadow observation: when trades were fetched but the live scoring
    // path used flow=0 (i.e. shadow on, live off), still compute the flow
    // value and record it so the dashboard tracker can show what the live
    // signal "would have seen" if MICRO_TRADES_ENABLED were flipped.
    // The recorded value is also exposed on sig.shadowFlowImbalance for
    // any downstream telemetry that wants the per-decision number.
    if (MICRO_TRADES_SHADOW_ENABLED && !MICRO_TRADES_ENABLED && Array.isArray(recentTrades)) {
      try {
        const shadowFlow = computeFlowImbalance(recentTrades, true);
        microFlowShadowTracker.record({
          ts: Date.now(),
          symbol: pair,
          horizonMinutes,
          flowImbalance: shadowFlow,
          tradesCount: recentTrades.length,
        });
        if (sig && typeof sig === 'object') sig.shadowFlowImbalance = shadowFlow;
      } catch (_) { /* observational; never fatal */ }
    }
    return sig;
  } catch (err) {
    return { ok: false, reason: 'microstructure_signal_failed', error: err?.message };
  }
}

// Shadow-labeler support (2026-06-05). Evaluate the microstructure signal
// OBSERVATIONALLY for one symbol — no order is ever placed — and, when it
// would fire, return the feature factors + entry mid so the shadow labeler can
// forward-grade it into a labeled training sample. This is the rule-respecting
// fix for the data-starvation deadlock: it lets the microstructure weights
// learn from would-be trades even while a different signal (e.g.
// mean_reversion_5m) is the live trader, WITHOUT placing real trades and
// WITHOUT bypassing any veto. Called only from the index.js shadow cycle, never
// from scanAndEnter — the live entry path is untouched.
async function getMicrostructureShadowSample(pair, horizonMinutes) {
  try {
    const quote = await getLatestQuote(pair).catch(() => null);
    const bid = Number(quote?.bp);
    const ask = Number(quote?.ap);
    if (!(bid > 0) || !(ask > 0)) return { ok: false, reason: 'no_quote' };
    const midPx = (bid + ask) / 2;
    const sig = await getMicrostructureSignalForPair(pair, quote, horizonMinutes);
    if (!sig || !sig.ok) return { ok: false, reason: sig?.reason || 'micro_not_fired' };
    const f = sig.factors || {};
    const features = {
      microBias: f.microBias,
      bookImbalance: f.bookImbalance,
      flowImbalance: f.flowImbalance,
      volNormReturn: f.volNormReturn,
      rsiDelta: f.rsiDelta,
      btcResidual: f.btcResidual,
      driftSharpe: f.driftSharpe,
      horizonMinutes,
    };
    return { ok: true, features, midPx, horizonMinutes };
  } catch (err) {
    return { ok: false, reason: 'micro_shadow_sample_failed', error: err?.message };
  }
}

// Fetch recent 1m bars for a pair and return the resolved bars array (handles
// the venue-specific symbol-key resolution internally). Used by the shadow
// labeler's forward grader; mirrors the bar resolution in the signal getters.
async function fetchBarsArray(pair, limit = 130) {
  const payload = await fetchCryptoBars({ symbols: [pair], limit, timeframe: '1Min' });
  return payload?.bars?.[pair] || payload?.bars?.[toAlpacaSymbol(pair)] || [];
}

const inventory = new Map();              // symbol -> { qty, avg_entry_price }
const exitState = new Map();              // symbol -> { sellOrderId, targetPrice, ... }
const entryIntentState = new Map();       // symbol -> { state, createdAt, updatedAt, reason }
const pendingBuys = new Map();            // symbol -> { orderId, submittedAt }
const positionFirstSeenAt = new Map();    // symbol -> ms epoch at first reconcile observation
const tradePredictions = new Map();       // symbol -> { tradeId, submittedAt, prediction, buyFillObserved, actualEntryPrice }
const skipReasonCounts = new Map();
const rollingSkipByReasonAndSymbol = [];
const lastQuoteUpdateBySymbol = new Map();

// BTC lead-lag cache. Updated whenever getPredictionSignal('BTC/USD')
// succeeds. Alts read this on every entry evaluation so the predictor sees
// what BTC has done in the last few minutes (alts typically lag BTC by
// 30–90s in crypto). Capped at BTC_LEAD_LAG_MAX_AGE_MS so stale data is
// dropped instead of silently scoring entries against the prior session.
const BTC_LEAD_LAG_SYMBOL = 'BTC/USD';
const BTC_LEAD_LAG_MAX_AGE_MS = 5 * 60 * 1000;
let btcLeadLagSnapshot = null;
let marketRegimeSnapshot = null;

// Regime update is decoupled from sig.ok so the dashboard's marketRegime
// field doesn't silently go null whenever the active signal (e.g. MR-1m)
// returns ok=false for non-data reasons like mr_no_drop. Called from each
// signal wrapper right after bars are fetched, BEFORE the signal's gates
// fire. Same closes already in memory; no extra Alpaca call. Observational
// only — no gate or signal reads marketRegimeSnapshot.
function maybeUpdateMarketRegimeFromBars(pair, bars1m) {
  if (!MARKET_REGIME_DETECTOR_ENABLED) return;
  if (pair !== BTC_LEAD_LAG_SYMBOL) return;
  if (!Array.isArray(bars1m) || bars1m.length < 2) return;
  try {
    const closes = [];
    for (const bar of bars1m) {
      const c = Number(bar?.c ?? bar?.close);
      if (Number.isFinite(c) && c > 0) closes.push(c);
    }
    if (closes.length < 2) return;
    const summary = marketRegimeDetector.summarizeRegime({
      closes,
      lookbackBars: MARKET_REGIME_LOOKBACK_BARS,
      thresholds: {
        benignDriftBpsPerMin: MARKET_REGIME_BENIGN_DRIFT_BPS_PER_MIN,
        adverseDriftBpsPerMin: MARKET_REGIME_ADVERSE_DRIFT_BPS_PER_MIN,
        quietSigmaBpsPerMin: MARKET_REGIME_QUIET_SIGMA_BPS_PER_MIN,
        wildSigmaBpsPerMin: MARKET_REGIME_WILD_SIGMA_BPS_PER_MIN,
      },
    });
    const now = Date.now();
    // Track when the current regime label began so the veto evaluator
    // can require a minimum consecutive duration. Reset to `now` whenever
    // the label changes; keep stable otherwise.
    const previousRegime = marketRegimeSnapshot ? marketRegimeSnapshot.regime : null;
    const previousStart = marketRegimeSnapshot ? marketRegimeSnapshot.consecutiveStartedAt : null;
    const consecutiveStartedAt = regimeVetoEvaluator.trackConsecutiveStart({
      previousRegime,
      currentRegime: summary.regime,
      previousStartedAt: previousStart,
      nowMs: now,
    });
    marketRegimeSnapshot = { ...summary, capturedAt: now, consecutiveStartedAt };
  } catch (_) { /* observational; never fatal */ }
}

function recordBtcLeadLagSnapshot(sig) {
  if (!sig || !sig.ok) return;
  const closes = Array.isArray(sig.closes) ? sig.closes : [];
  let recentReturnBps = null;
  if (closes.length >= 5) {
    const a = closes[closes.length - 5];
    const b = closes[closes.length - 1];
    if (Number.isFinite(a) && a > 0 && Number.isFinite(b)) {
      recentReturnBps = ((b - a) / a) * 10000;
    }
  }
  btcLeadLagSnapshot = {
    slopeBpsPerBar: Number.isFinite(sig.slopeBpsPerBar) ? sig.slopeBpsPerBar : null,
    projectedBps: Number.isFinite(sig.projectedBps) ? sig.projectedBps : null,
    recentReturnBps,
    volumeRatio: Number.isFinite(sig.volumeRatio) ? sig.volumeRatio : null,
    capturedAt: Date.now(),
  };
}
function getBtcLeadLagSnapshot() {
  if (!btcLeadLagSnapshot) return null;
  const ageMs = Date.now() - btcLeadLagSnapshot.capturedAt;
  if (ageMs > BTC_LEAD_LAG_MAX_AGE_MS) return null;
  return { ...btcLeadLagSnapshot, ageMs };
}
function getMarketRegimeSnapshot() {
  if (!marketRegimeSnapshot) return null;
  const ageMs = Date.now() - marketRegimeSnapshot.capturedAt;
  if (ageMs > BTC_LEAD_LAG_MAX_AGE_MS) return null;
  return { ...marketRegimeSnapshot, ageMs };
}

let entryManagerRunning = false;
let exitManagerRunning = false;
let entryManagerIntervalId = null;
let exitManagerIntervalId = null;
let lastEntryScanAt = null;
let lastEntryScanSummary = null;
let currentScanState = 'idle';
let currentScanStartedAt = null;
let currentScanLastProgressAt = null;
let currentScanSymbolsProcessed = 0;
let currentScanUniverseSize = 0;
let lastSuccessfulAction = null;
let lastExecutionFailure = null;
let engineState = 'booting';
let engineStateUpdatedAt = null;
let engineStateReason = null;

function setEngineState(state, reason) {
  engineState = state;
  engineStateUpdatedAt = new Date().toISOString();
  engineStateReason = reason || null;
}

function bumpSkipReason(reason) {
  if (!reason) return;
  skipReasonCounts.set(reason, (skipReasonCounts.get(reason) || 0) + 1);
}

function computeRollingSkipReasonCounts() {
  const cutoff = Date.now() - REJECTION_WINDOW_MS;
  while (rollingSkipByReasonAndSymbol.length > 0 && rollingSkipByReasonAndSymbol[0].ts < cutoff) {
    rollingSkipByReasonAndSymbol.shift();
  }
  const counts = {};
  for (const row of rollingSkipByReasonAndSymbol) {
    counts[row.reason] = (counts[row.reason] || 0) + 1;
  }
  return counts;
}

// Per-iteration scan context for the gate-rejection audit. Set by
// scanAndEnter at the top of each candidate iteration once a valid
// bid/ask is in hand; cleared at iteration boundary. rejectTrade reads
// this to capture the rejected candidate's mid-price + signal version
// for later forward-bar grading. Module-level state (rather than a
// per-call parameter) keeps the rejectTrade signature unchanged for
// every existing caller.
let currentScanAuditCandidate = null;
function setScanAuditCandidate(candidate) { currentScanAuditCandidate = candidate; }
function clearScanAuditCandidate() { currentScanAuditCandidate = null; }

function rejectTrade(pair, reason, details = {}) {
  bumpSkipReason(reason);
  rollingSkipByReasonAndSymbol.push({ ts: Date.now(), symbol: pair || 'unknown', reason: reason || 'unknown' });
  while (rollingSkipByReasonAndSymbol.length > 0 && (Date.now() - rollingSkipByReasonAndSymbol[0].ts) > REJECTION_WINDOW_MS) {
    rollingSkipByReasonAndSymbol.shift();
  }
  console.log('entry_rejected', { symbol: pair, reason, ...details });

  // Gate-rejection audit capture. Observational only — never affects the
  // entry decision. Context is only set after a valid quote is bound, so
  // early data-quality rejects (no_quote, stale_quote, etc.) fall through
  // with `currentScanAuditCandidate=null` and are skipped. The module's
  // own EXCLUDED_REASONS set is a second line of defence in case a future
  // refactor moves a data-quality reject into the post-quote window.
  if (GATE_REJECTION_AUDIT_ENABLED
      && currentScanAuditCandidate
      && currentScanAuditCandidate.symbol === pair) {
    try {
      gateRejectionAudit.capture({
        symbol: pair,
        reason,
        midPx: currentScanAuditCandidate.midPx,
        signalVersion: currentScanAuditCandidate.signalVersion,
      });
    } catch (_) { /* never fail the entry path on audit bookkeeping */ }
  }
}

// Snapshot of the rolling per-(symbol, reason) rejection buffer for
// downstream aggregators (tradeFeasibilityAudit consumes this). Trims
// expired entries first so the consumer always sees a current view.
function getRollingSkipSnapshot() {
  const cutoff = Date.now() - REJECTION_WINDOW_MS;
  while (rollingSkipByReasonAndSymbol.length > 0 && rollingSkipByReasonAndSymbol[0].ts < cutoff) {
    rollingSkipByReasonAndSymbol.shift();
  }
  return rollingSkipByReasonAndSymbol.slice();
}

function getRejectionWindowStats() {
  const cutoff = Date.now() - REJECTION_WINDOW_MS;
  while (rollingSkipByReasonAndSymbol.length > 0 && rollingSkipByReasonAndSymbol[0].ts < cutoff) rollingSkipByReasonAndSymbol.shift();
  const byReason = new Map();
  const bySymbolReason = new Map();
  for (const row of rollingSkipByReasonAndSymbol) {
    byReason.set(row.reason, (byReason.get(row.reason) || 0) + 1);
    const key = `${row.symbol}::${row.reason}`;
    bySymbolReason.set(key, (bySymbolReason.get(key) || 0) + 1);
  }
  const total = rollingSkipByReasonAndSymbol.length;
  const reasonPercentages = {};
  for (const [reason, count] of byReason.entries()) reasonPercentages[reason] = total > 0 ? (count / total) * 100 : 0;
  const symbolReasonPercentages = {};
  for (const [key, count] of bySymbolReason.entries()) symbolReasonPercentages[key] = total > 0 ? (count / total) * 100 : 0;
  return { windowMs: REJECTION_WINDOW_MS, total, reasonPercentages, symbolReasonPercentages };
}

function mapToObject(m) {
  const out = {};
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

function getEngineStateSnapshot() {
  if (!TRADING_ENABLED) return 'disabled';
  if (entryManagerRunning && currentScanState === 'scanning') return 'scanning';
  if (engineState) return engineState;
  return 'booting';
}

// --- snapshots consumed by /dashboard -----------------------------------

function getExitStateSnapshot() {
  const out = {};
  for (const [sym, s] of exitState.entries()) out[sym] = { ...s };
  return out;
}

function getLifecycleSnapshot() {
  const bySymbol = {};
  for (const [sym, s] of entryIntentState.entries()) {
    bySymbol[sym] = { symbol: sym, ...s };
  }
  return {
    bySymbol,
    authoritativeCount: entryIntentState.size,
    diagnostics: null,
  };
}

function getSessionGovernorSummary() {
  return { enabled: false, coolDownUntilMs: 0, coolDownActive: false, failedEntries: 0, lastReason: null };
}

function getTradingManagerStatus() {
  return {
    tradingEnabled: TRADING_ENABLED,
    entryManagerRunning,
    exitManagerRunning,
    entryManagerIntervalActive: Boolean(entryManagerIntervalId),
    exitManagerIntervalActive: Boolean(exitManagerIntervalId),
    exitRepairIntervalActive: false,
    engineV2Enabled: false,
    featureFlags: {},
    lifecycle: getLifecycleSnapshot(),
    sessionGovernor: getSessionGovernorSummary(),
    sizing: { activeMode: 'percent_of_equity', pct: PORTFOLIO_SIZING_PCT },
    risk: { tradingHaltedReason: null },
    engine: { state: getEngineStateSnapshot(), updatedAt: engineStateUpdatedAt, reason: engineStateReason || null },
    entryManagerHeartbeat: {
      running: entryManagerRunning,
      started: entryManagerRunning,
      lastScanAt: lastEntryScanAt,
      currentScanState,
      currentScanStartedAt,
      currentScanLastProgressAt,
      currentScanSymbolsProcessed,
      currentScanUniverseSize,
      currentScanTopSkipReasons: mapToObject(skipReasonCounts),
    },
  };
}

function getEntryDiagnosticsSnapshot() {
  return {
    entryScan: lastEntryScanSummary,
    predictorCandidates: null,
    skipReasonsBySymbol: {},
    topSkipReasonsRolling: computeRollingSkipReasonCounts(),
    entryManager: getTradingManagerStatus().entryManagerHeartbeat,
    gating: {},
    quoteFreshness: {
      maxAgeMs: QUOTE_MAX_AGE_MS,
      staleEntryQuoteSkips: skipReasonCounts.get('stale_quote') || 0,
      prunedStaleQuoteSkips: skipReasonCounts.get('pruned_stale_quotes') || 0,
      prunerEnabled: STALE_QUOTE_PRUNE_ENABLED,
      ...quoteFreshness.snapshot(),
    },
    rejectionWindow: getRejectionWindowStats(),
    quoteAgesBySymbolMs: Object.fromEntries(Array.from(lastQuoteUpdateBySymbol.entries()).map(([sym, ts]) => [sym, Date.now() - ts])),
    ratePressureState: null,
    lastSuccessfulAction,
    lastExecutionFailure,
  };
}

function getUniverseDiagnosticsSnapshot() {
  const tradable = supportedPairsSnapshot.pairs || [];
  const effectiveMode = runtimeConfig.entryUniverseModeEffective === 'configured'
    ? 'configured'
    : 'dynamic';
  let scanSymbols;
  if (effectiveMode === 'configured') {
    const primary = runtimeConfig.configuredPrimarySymbols || [];
    if (tradable.length > 0) {
      const allowed = new Set(tradable);
      scanSymbols = primary.filter((s) => allowed.has(s));
    } else {
      // Mirror scanAndEnter: when /v2/assets has never returned, the
      // configured primary list is the universe.
      scanSymbols = primary.slice();
    }
  } else {
    scanSymbols = tradable.slice();
  }
  return {
    envRequestedUniverseMode: runtimeConfig.entryUniverseModeRaw || effectiveMode,
    effectiveUniverseMode: effectiveMode,
    dynamicUniverseActive: effectiveMode === 'dynamic',
    dynamicTradableSymbolsFound: tradable.length,
    rankedAcceptedSymbolsCount: scanSymbols.length,
    acceptedSymbolsCount: scanSymbols.length,
    dynamicAcceptedSymbolsCount: effectiveMode === 'dynamic' ? scanSymbols.length : 0,
    scanSymbolsCount: scanSymbols.length,
    rankedAcceptedSymbolsSample: scanSymbols.slice(0, 10),
    acceptedSymbolsSample: scanSymbols.slice(0, 10),
    dynamicAcceptedSymbolsSample: effectiveMode === 'dynamic' ? scanSymbols.slice(0, 10) : [],
    scanSymbolsSample: scanSymbols.slice(0, 10),
    universeSymbolCap: null,
    configuredUniverseCap: null,
    configuredUniverseCapSource: null,
    universeCapDiagnostics: null,
    fallbackOccurred: false,
    fallbackReason: null,
  };
}

function getPredictorWarmupSnapshot() {
  return { inProgress: false, symbolsCompleted: 0, totalSymbolsPlanned: 0, chunksCompleted: 0, totalChunks: 0, currentTimeframe: null };
}

function getEntryRegimeStaleThresholdMs() { return QUOTE_MAX_AGE_MS; }

// --- entry engine -------------------------------------------------------

function computeSpreadBps(quote) {
  const bid = Number(quote?.bp);
  const ask = Number(quote?.ap);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 10000;
}

function quoteTimestampMs(quote) {
  const candidates = [quote?.t, quote?.timestamp, quote?.ax, quote?.bx, quote?.as, quote?.bs];
  let best = null;
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    let ms = null;
    if (typeof raw === 'number' || /^[0-9]+$/.test(String(raw))) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        if (n > 1e17) ms = Math.floor(n / 1e6); // ns
        else if (n > 1e14) ms = Math.floor(n / 1e3); // µs
        else if (n > 1e11) ms = Math.floor(n); // ms
        else if (n > 1e9) ms = Math.floor(n * 1000); // s
      }
    } else {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) ms = parsed;
    }
    if (Number.isFinite(ms) && ms > 0) best = best == null ? ms : Math.max(best, ms);
  }
  return Number.isFinite(best) ? best : null;
}

function getDynamicBufferBps(volatilityBps) {
  const vol = Number(volatilityBps);
  if (!Number.isFinite(vol)) return DYNAMIC_BUFFER_MAX_BPS;
  if (vol <= LOW_VOL_BPS) return DYNAMIC_BUFFER_MIN_BPS;
  if (vol >= HIGH_VOL_BPS) return DYNAMIC_BUFFER_MAX_BPS;
  const t = (vol - LOW_VOL_BPS) / (HIGH_VOL_BPS - LOW_VOL_BPS);
  return DYNAMIC_BUFFER_MIN_BPS + ((DYNAMIC_BUFFER_MAX_BPS - DYNAMIC_BUFFER_MIN_BPS) * t);
}

function requiredEdgeBps(spreadBps, volatilityBps) {
  return Math.max(0, spreadBps || 0) + FEE_BPS_ROUND_TRIP + getDynamicBufferBps(volatilityBps);
}

function shouldEnterTrade({ spreadBps, slippageEstimateBps, volatilityBps, ask, bid, closes = [] } = {}) {
  if (!Number.isFinite(spreadBps)) return { ok: false, reason: 'invalid_spread' };
  if (spreadBps > SPREAD_ENTRY_MAX_BPS) return { ok: false, reason: 'spread_above_entry_max' };
  if (spreadBps > SPREAD_SHOCK_MAX_BPS) return { ok: false, reason: 'spread_shock' };
  if (Number.isFinite(slippageEstimateBps) && slippageEstimateBps > MAX_SLIPPAGE_ESTIMATE_BPS) {
    return { ok: false, reason: 'slippage_too_high' };
  }
  if (Number.isFinite(volatilityBps) && volatilityBps > VOLATILITY_MAX_BPS) {
    return { ok: false, reason: 'volatility_spike' };
  }

  const recent = closes.slice(-Math.max(MICRO_MOMENTUM_TICKS, MICRO_EMA_LENGTH));
  const momentumWindow = recent.slice(-MICRO_MOMENTUM_TICKS);
  let upMoves = 0;
  for (let i = 1; i < momentumWindow.length; i += 1) {
    if (momentumWindow[i] > momentumWindow[i - 1]) upMoves += 1;
  }
  const momentumConfirm = momentumWindow.length >= 3 && upMoves >= Math.ceil((momentumWindow.length - 1) * 0.7);

  const emaAlpha = 2 / (MICRO_EMA_LENGTH + 1);
  let ema = recent[0];
  for (let i = 1; i < recent.length; i += 1) ema = (recent[i] * emaAlpha) + (ema * (1 - emaAlpha));
  const last = recent[recent.length - 1];
  const meanReversionDevBps = Number.isFinite(last) && Number.isFinite(ema) && ema > 0
    ? ((ema - last) / ema) * 10000
    : null;
  const meanReversionConfirm = Number.isFinite(meanReversionDevBps) && meanReversionDevBps >= MICRO_MEAN_REVERSION_MIN_DEV_BPS;

  const stableQuoteConfirm = Number.isFinite(spreadBps) &&
    spreadBps <= Math.max(TIGHT_QUOTE_MAX_BPS, SPREAD_ENTRY_MAX_BPS) &&
    Number.isFinite(volatilityBps) &&
    volatilityBps <= STABLE_QUOTE_VOL_MAX_BPS &&
    Number.isFinite(ask) &&
    Number.isFinite(bid) &&
    ask > bid;

  if (!momentumConfirm && !meanReversionConfirm && !stableQuoteConfirm) {
    return { ok: false, reason: 'micro_signal_missing' };
  }
  return { ok: true, momentumConfirm, meanReversionConfirm, stableQuoteConfirm };
}

async function initializeInventoryFromPositions() {
  inventory.clear();
  const positions = await fetchPositions();
  for (const pos of positions) {
    const pair = normalizePair(pos?.symbol);
    if (!pair) continue;
    inventory.set(pair, {
      qty: Number(pos.qty) || 0,
      avg_entry_price: Number(pos.avg_entry_price) || 0,
    });
  }
  return inventory;
}

// Bounded retry for a single transient network call (2026-06-05). The
// positions/orders fetches below feed the entry scan; a single transient
// AggregateError (observed once from Binance.US) previously aborted the WHOLE
// scan cycle for ENTRY_SCAN_INTERVAL_MS, silently skipping any entry that cycle.
// One quick retry absorbs the common transient blip without masking a real
// outage (a persistent failure still throws after the retry, hitting the same
// `positions_or_orders_fetch_failed` handler — behaviour unchanged for real
// failures). Backoff is small + fixed; the caller is already inside a
// try/catch, so a final throw is safe.
async function fetchWithOneRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    const transient = err?.name === 'AggregateError'
      || /AggregateError|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|network/i.test(
        String(err?.errorMessage || err?.message || err));
    if (!transient) throw err;
    console.warn('fetch_transient_retry', { label, error: err?.errorMessage || err?.message || String(err) });
    await new Promise((r) => setTimeout(r, 400));
    return fn();
  }
}

async function buildHeldAndOpenSellsIndex() {
  const positions = await fetchWithOneRetry(() => fetchPositions(), 'fetchPositions');
  const held = new Set();
  const byPair = new Map();
  let totalUnrealizedPl = 0;
  let totalCostBasis = 0;
  for (const p of positions) {
    const pair = normalizePair(p?.symbol);
    if (pair) { held.add(pair); byPair.set(pair, p); }
    const upl = Number(p?.unrealized_pl);
    const cost = Number(p?.cost_basis);
    if (Number.isFinite(upl)) totalUnrealizedPl += upl;
    if (Number.isFinite(cost) && cost > 0) totalCostBasis += cost;
  }
  const aggregateUnrealizedPct = totalCostBasis > 0
    ? (totalUnrealizedPl / totalCostBasis) * 100
    : null;
  const openOrders = await fetchWithOneRetry(
    () => fetchOrders({ status: 'open', nested: true, limit: 500 }), 'fetchOrders');
  const openBuyPairs = new Set();
  const openSellByPair = new Map();
  expandNestedOrders(openOrders).forEach((o) => {
    const pair = normalizePair(o?.symbol);
    if (!pair) return;
    const side = String(o?.side || '').toLowerCase();
    if (!isOpenLikeOrderStatus(String(o?.status || ''))) return;
    if (side === 'buy') openBuyPairs.add(pair);
    if (side === 'sell') openSellByPair.set(pair, o);
  });
  return { held, byPair, openBuyPairs, openSellByPair, aggregateUnrealizedPct };
}

// ============================================================================
// scanAndEnter — the bare 4-step loop.
//
//   1. Determine entry signal  (the active signal's per-symbol evaluator)
//   2. Enter                   (limit buy at mid; the exit manager attaches
//                               the GTC sell at entry × (1 + target))
//   3. Create sell signal      (handled by the exit manager from the
//                               prediction record written here — step 3 is
//                               the GTC sell target, derived from the entry)
//   4. Repeat                  (startEntryManager re-invokes on a timer)
//
// 2026-05-30 simplification: the prior ~1,150-line implementation stacked ~25
// gates/vetoes (signal-selector backtest veto, exploration budget, regime
// veto, cross-venue gate, stale-quote rescue, recent-high, HTF, OLS-era EV /
// alpha / net-edge / projection floors, adaptive sizing, …) between the quote
// fetch and the order. The net live result was a frozen bot (backtest veto +
// exhausted exploration budget) bleeding -50 bps when it did trade. This
// rewrite keeps ONLY:
//   - basic execution sanity (quote freshness, spread cap, sizing/cash clamp,
//     one-position-per-symbol, a concurrent-position cap)
//   - the active signal's own ok/reject decision
//   - ONE safety brake: the realized-expectancy bleed check. If the active
//     signal's recent CLOSED trades average below the floor, pause NEW
//     entries (open positions are still managed/exited normally). This is the
//     single guard that would have stopped the -50 bps bleed.
// Everything else was removed. The prediction-record shape is preserved so the
// exit manager, dashboard meta, forensics, and tests keep working unchanged.
// ============================================================================
async function scanAndEnter() {
  if (!TRADING_ENABLED) return;
  currentScanState = 'scanning';
  currentScanStartedAt = new Date().toISOString();
  currentScanLastProgressAt = currentScanStartedAt;
  currentScanSymbolsProcessed = 0;
  skipReasonCounts.clear();

  // STEP 1 (which signal): resolve the active signal version. Operator override
  // wins (SIGNAL_VERSION env); otherwise default to mean_reversion — the
  // simplest signal to reason about (buy a sharp dip, sell the bounce) and the
  // one whose entry directly defines its sell target.
  const ACTIVE_SIGNAL_VERSION = SIGNAL_VERSION_OPERATOR_OVERRIDE || 'mean_reversion';

  // ONE SAFETY BRAKE: realized-expectancy bleed check. Reuses the same pure
  // evaluator + trade set the dashboard's meta.drift reports, so the gate and
  // the diagnostic never disagree. When the active signal's recent CLOSED
  // trades average below the floor (default -10 bps over ≥10 trades), halt NEW
  // entries. Open positions keep being managed/exited by the exit manager.
  // The bot resumes automatically once recent realized expectancy recovers.
  // Exclude the active signal's blocklisted symbols from the realized-veto
  // window (2026-06-07). A symbol added to MR_SYMBOL_BLOCKLIST_* will never be
  // traded again on that timeframe, so its old closed trades must not keep the
  // breaker halting the bot (and deadlocking the flush). Map the active MR
  // timeframe to its blocklist set; non-MR signals pass null (no change).
  const realizedVetoExcludeSymbols = ACTIVE_SIGNAL_VERSION === 'mean_reversion' ? MR_BLOCKLISTS.mr1m
    : ACTIVE_SIGNAL_VERSION === 'mean_reversion_5m' ? MR_BLOCKLISTS.mr5m
    : ACTIVE_SIGNAL_VERSION === 'mean_reversion_15m' ? MR_BLOCKLISTS.mr15m
    : null;
  const realizedVeto = signalSelector.evaluateRealizedVeto({
    records: closedTradeStats.getRecent(SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES * 20),
    signalVersion: ACTIVE_SIGNAL_VERSION,
    excludeSymbols: realizedVetoExcludeSymbols,
    config: {
      enabled: SIGNAL_SELECTOR_REALIZED_VETO_ENABLED,
      minTrades: SIGNAL_SELECTOR_REALIZED_MIN_TRADES,
      floorBps: SIGNAL_SELECTOR_REALIZED_FLOOR_BPS,
      lookbackTrades: SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES,
      maxAgeMs: SIGNAL_SELECTOR_REALIZED_MAX_AGE_MS,
    },
  });
  lastRealizedVetoState = { ...realizedVeto, evaluatedAt: new Date().toISOString() };
  if (realizedVeto.veto) {
    console.log('entry_scan_skipped_realized_veto', {
      signalVersion: realizedVeto.signalVersion,
      realizedAvgNetBps: realizedVeto.realizedAvgNetBps,
      sampleSize: realizedVeto.sampleSize,
      floorBps: realizedVeto.floorBps,
    });
    bumpSkipReason('realized_expectancy_veto');
    currentScanState = 'idle';
    currentScanStartedAt = null;
    return;
  }

  // SECOND SAFETY BRAKE (2026-06-09): maker-execution guard for btc_lead_lag.
  // The signal backtests +1.94 bps ONLY as a guaranteed maker; as a taker it is
  // -0.38 bps — negative expectancy. The maker guarantee exists only on
  // binance_us with ENTRY_POST_ONLY=true (the buy maps to a LIMIT_MAKER the
  // exchange rejects rather than crosses). ENTRY_POST_ONLY is a locked live
  // default ('true'), but the trade.js readBoolean fallback is false and on
  // Alpaca post_only is a no-op (LIMIT_MAKER is binance-only), so a misconfigured
  // pin would trade the signal at a guaranteed loss. Halt NEW entries instead —
  // same fail-safe shape as the realized veto; open positions still exit
  // normally. Byte-for-byte no-op in the live config (binance_us + post-only),
  // where isBtcLeadLagExecutionSafe() is true and this block is skipped.
  if (ACTIVE_SIGNAL_VERSION === 'btc_lead_lag'
    && !isBtcLeadLagExecutionSafe({ isBinanceExecution: IS_BINANCE_EXECUTION, entryPostOnly: ENTRY_POST_ONLY })) {
    if (!btcLeadLagUnsafeExecutionWarned) {
      console.warn('entry_scan_halted_btc_lead_lag_unsafe_execution', {
        executionVenue: EXECUTION_VENUE,
        entryPostOnly: ENTRY_POST_ONLY,
        detail: 'btc_lead_lag is positive-expectancy only as a guaranteed maker (binance_us + ENTRY_POST_ONLY=true); refusing to trade it as a taker',
      });
      btcLeadLagUnsafeExecutionWarned = true;
    }
    bumpSkipReason('btc_lead_lag_requires_maker_execution');
    currentScanState = 'idle';
    currentScanStartedAt = null;
    return;
  }

  await loadSupportedCryptoPairs();
  // Universe: configured primary list (intersected with the tradable set) or
  // the full dynamic tradable set. Per-symbol checks below still decide.
  const allTradable = supportedPairsSnapshot.pairs || [];
  let universe;
  if (runtimeConfig.entryUniverseModeEffective === 'configured') {
    const primary = runtimeConfig.configuredPrimarySymbols || [];
    if (allTradable.length > 0) {
      const allowed = new Set(allTradable);
      universe = primary.filter((s) => allowed.has(s));
    } else {
      universe = primary.slice();
      bumpSkipReason('supported_pairs_unavailable_used_configured_primary');
    }
  } else {
    universe = allTradable.slice();
  }
  // Hard liquidity allowlist (2026-05-31). Intersected AFTER the configured/
  // dynamic universe is built so it is the final word on what the live scan can
  // reach — a stale Render ENTRY_SYMBOLS_PRIMARY override cannot widen past it.
  // Empty list = disabled (no intersection).
  if (ENTRY_UNIVERSE_HARD_ALLOWLIST_SET.size > 0) {
    const beforeCount = universe.length;
    universe = universe.filter((s) => ENTRY_UNIVERSE_HARD_ALLOWLIST_SET.has(s));
    if (universe.length !== beforeCount) {
      bumpSkipReason('universe_hard_allowlist_filtered');
    }
  }
  currentScanUniverseSize = universe.length;

  let held, openBuyPairs;
  try {
    const idx = await buildHeldAndOpenSellsIndex();
    held = idx.held;
    openBuyPairs = idx.openBuyPairs;
  } catch (err) {
    lastExecutionFailure = { at: new Date().toISOString(), reason: 'positions_or_orders_fetch_failed', message: err?.errorMessage || err?.message || String(err) };
    currentScanState = 'idle';
    return;
  }

  const heldCount = held.size;
  let candidates = universe.filter((pair) => !held.has(pair) && !openBuyPairs.has(pair));
  // BTC lead-lag: BTC is the leader, never a tradable target. Drop it from the
  // candidate list; its snapshot is refreshed separately below.
  if (ACTIVE_SIGNAL_VERSION === 'btc_lead_lag') {
    candidates = candidates.filter((pair) => pair !== BTC_LEAD_LAG_SYMBOL);
  }
  const summary = {
    ts: new Date().toISOString(),
    universeSize: universe.length,
    heldCount,
    slotsAvailable: candidates.length,
    evaluated: 0,
    entered: 0,
    topSkipReasons: {},
    acceptedSymbols: [],
  };

  // STEP 2 sizing: PORTFOLIO_SIZING_PCT of equity, clamped to available cash.
  let availableCash = Infinity;
  let targetNotional = null;
  try {
    const account = await fetchAccount();
    const cashNum = Number(account?.cash ?? account?.buying_power ?? account?.non_marginable_buying_power);
    if (Number.isFinite(cashNum)) availableCash = cashNum;
    const equityNum = Number(account?.equity ?? account?.portfolio_value);
    if (Number.isFinite(equityNum) && equityNum > 0) targetNotional = equityNum * PORTFOLIO_SIZING_PCT;
  } catch (err) {
    // Soft-fail: let submitOrder surface any real error.
  }
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) {
    bumpSkipReason('sizing_unavailable');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }
  const tradeNotional = Math.min(targetNotional, Number.isFinite(availableCash) ? availableCash : targetNotional);
  if (tradeNotional < MIN_TRADE_NOTIONAL_USD) {
    bumpSkipReason('insufficient_cash');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }

  // Batched quote warm-up (one multi-symbol call per chunk instead of N serial
  // single-symbol calls). The loop reads this Map first.
  const prefetchedQuotes = runtimeConfig.entryPrefetchQuotes
    ? await prefetchQuotesForCandidates(candidates, runtimeConfig.entryPrefetchChunkSize)
    : null;

  // BTC lead-lag: refresh the lead snapshot ONCE per scan, before the candidate
  // loop and independent of any per-symbol entry gate, so every alt this cycle
  // scores against a fresh BTC move. (getBtcLeadLagSignalForPair fetches BTC
  // bars and updates btcLeadLagSnapshot when pair===BTC, then returns
  // btc_is_leader, which we discard.) Without this the snapshot would only
  // refresh if BTC happened to pass the entry gates — fragile.
  if (ACTIVE_SIGNAL_VERSION === 'btc_lead_lag') {
    try { await getBtcLeadLagSignalForPair(BTC_LEAD_LAG_SYMBOL); } catch (_) { /* best-effort */ }
  }

  let placed = 0;
  for (const pair of candidates) {
    summary.evaluated += 1;
    currentScanSymbolsProcessed += 1;
    currentScanLastProgressAt = new Date().toISOString();

    // Concurrent-position cap: bound how much cash gets fragmented across
    // simultaneous positions. heldCount is the cross-scan baseline; placed is
    // this scan's in-progress entries.
    if (heldCount + placed >= MAX_CONCURRENT_POSITIONS_SOFT_CAP) {
      rejectTrade(pair, 'concurrent_position_cap', { heldCount, placed, cap: MAX_CONCURRENT_POSITIONS_SOFT_CAP });
      continue;
    }
    try {
      // Fresh re-quote (2026-05-31): when enabled, fetch a current single-symbol
      // quote so the freshness/spread gates and the entry price all act on a
      // live book — the prefetched quote's "age" on Binance.US is only loop
      // latency (bookTicker has no server timestamp). Falls back to the
      // prefetched quote if the fresh fetch fails, so a transient error can't
      // wholesale starve the scan.
      let payload;
      if (ENTRY_FRESH_REQUOTE) {
        try {
          payload = await fetchCryptoQuotes({ symbols: [pair] });
        } catch (_) {
          const prefetched = prefetchedQuotes ? prefetchedQuotes.get(pair) : null;
          payload = prefetched ? { quotes: { [pair]: prefetched } } : null;
        }
      } else {
        const prefetched = prefetchedQuotes ? prefetchedQuotes.get(pair) : null;
        payload = prefetched ? { quotes: { [pair]: prefetched } } : await fetchCryptoQuotes({ symbols: [pair] });
      }
      const quote = payload?.quotes?.[pair] || payload?.quotes?.[toAlpacaSymbol(pair)] || null;
      if (!quote) { rejectTrade(pair, 'no_quote'); continue; }

      // Quote freshness — never act on a stale price.
      const quoteTsMs = quoteTimestampMs(quote) || 0;
      const ageMs = Date.now() - quoteTsMs;
      if (quoteTsMs > 0) lastQuoteUpdateBySymbol.set(pair, quoteTsMs);
      quoteFreshness.record(pair, ageMs);
      if (!Number.isFinite(ageMs) || ageMs > (QUOTE_MAX_AGE_MS + QUOTE_STALE_GRACE_MS)) {
        rejectTrade(pair, 'stale_quote', { ageMs });
        continue;
      }

      // Spread sanity — refuse books too wide to clear the target after costs.
      const spreadBps = computeSpreadBps(quote);
      if (spreadBps == null) { rejectTrade(pair, 'invalid_quote'); continue; }
      const spreadCapBps = resolveSpreadCapBps(pair);
      if (spreadBps > spreadCapBps + SPREAD_TOLERANCE_BPS + SPREAD_COMPARISON_EPSILON_BPS) {
        rejectTrade(pair, 'spread_too_wide', { spreadBps, spreadCapBps });
        continue;
      }

      const ask = Number(quote.ap);
      const bid = Number(quote.bp);
      if (!Number.isFinite(ask) || ask <= 0) { rejectTrade(pair, 'invalid_ask'); continue; }
      if (!Number.isFinite(bid) || bid <= 0) { rejectTrade(pair, 'invalid_bid'); continue; }

      // STEP 1 (per symbol): evaluate the active entry signal.
      let sig;
      if (ACTIVE_SIGNAL_VERSION === 'multi_factor') sig = await getMultiFactorSignalForPair(pair, quote);
      else if (ACTIVE_SIGNAL_VERSION === 'mean_reversion') sig = await getMeanReversionSignalForPair(pair, '1m');
      else if (ACTIVE_SIGNAL_VERSION === 'mean_reversion_5m') sig = await getMeanReversionSignalForPair(pair, '5m');
      else if (ACTIVE_SIGNAL_VERSION === 'mean_reversion_15m') sig = await getMeanReversionSignalForPair(pair, '15m');
      else if (ACTIVE_SIGNAL_VERSION === 'range_mean_reversion') sig = await getRangeMeanReversionSignalForPair(pair);
      else if (ACTIVE_SIGNAL_VERSION === 'barrier') sig = await getBarrierSignalForPair(pair, quote);
      else if (ACTIVE_SIGNAL_VERSION === 'microstructure_5m') sig = await getMicrostructureSignalForPair(pair, quote, 5);
      else if (ACTIVE_SIGNAL_VERSION === 'microstructure_15m') sig = await getMicrostructureSignalForPair(pair, quote, 15);
      else if (ACTIVE_SIGNAL_VERSION === 'microstructure_30m') sig = await getMicrostructureSignalForPair(pair, quote, 30);
      else if (ACTIVE_SIGNAL_VERSION === 'microstructure_45m') sig = await getMicrostructureSignalForPair(pair, quote, 45);
      else if (ACTIVE_SIGNAL_VERSION === 'trend_following') sig = await getTrendFollowingSignalForPair(pair);
      else if (ACTIVE_SIGNAL_VERSION === 'pairs') sig = await getPairsSignalForPair(pair);
      else if (ACTIVE_SIGNAL_VERSION === 'btc_lead_lag') sig = await getBtcLeadLagSignalForPair(pair);
      else sig = await getPredictionSignal(pair);
      if (pair === BTC_LEAD_LAG_SYMBOL) recordBtcLeadLagSnapshot(sig);
      if (!sig.ok) { rejectTrade(pair, sig.reason || 'prediction_rejected'); continue; }

      // STEP 1b (selectivity + conviction sizing). Blend the signal's own
      // confidence with the market regime (BTC-derived) and the active signal's
      // recent LIVE realized edge into a 0..1 conviction. Sit out marginal
      // setups; size A+ setups up within the existing cap. Pure gate — never
      // relaxes any downstream safety. The realized veto already ran this scan
      // (realizedVeto), so its avg/sample feed the "is the edge working now?"
      // term for free.
      let convictionSizeMult = 1.0;
      if (CONVICTION_ENGINE_ENABLED) {
        const convictionResult = convictionEngine.evaluateConviction({
          signal: {
            confidence: sig.confidence,
            projectedBps: sig.projectedBps,
            signalVersion: sig.signalVersion || ACTIVE_SIGNAL_VERSION,
          },
          regime: getMarketRegimeSnapshot(),
          recentRealized: (realizedVeto && Number.isFinite(realizedVeto.realizedAvgNetBps))
            ? { avgNetBps: realizedVeto.realizedAvgNetBps, sampleSize: realizedVeto.sampleSize }
            : null,
          config: CONVICTION_CONFIG_OVERRIDES,
        });
        recordConvictionObservation(convictionResult);
        if (!convictionResult.enter) {
          rejectTrade(pair, convictionResult.reason || 'low_conviction', {
            conviction: Number(convictionResult.conviction.toFixed(3)),
            regime: convictionResult.components?.regimeLabel || null,
          });
          continue;
        }
        if (ADAPTIVE_SIZING_ENABLED && Number.isFinite(convictionResult.sizeMultiplier) && convictionResult.sizeMultiplier > 0) {
          convictionSizeMult = Math.max(1.0, Math.min(MAX_SIZING_FRACTION_OF_TARGET, convictionResult.sizeMultiplier));
        }
      }

      // STEP 2 (enter): limit buy at mid. Mid (not bid+tick) is deliberate —
      // the entryModeAB diagnostic showed the passive bid+tick rest bled
      // ~16 bps/trade to adverse selection on Binance.US's ~0% maker books.
      // Operator can still override via ENTRY_LIMIT_PRICE_MODE.
      const projectedBps = Number.isFinite(sig.projectedBps) ? sig.projectedBps : 0;
      const tickInfo = await getAssetTickInfo(pair);
      let buyPriceRaw;
      if (ENTRY_LIMIT_PRICE_MODE === 'ask') buyPriceRaw = ask;
      else if (ENTRY_LIMIT_PRICE_MODE === 'bid_plus_tick') buyPriceRaw = bid + (Number(tickInfo.priceIncrement) || 0);
      else buyPriceRaw = (ask + bid) / 2;
      if (!Number.isFinite(buyPriceRaw) || buyPriceRaw <= 0) buyPriceRaw = ask;
      const buyLimitStr = formatTickPrice(buyPriceRaw, tickInfo.priceIncrement);
      if (!buyLimitStr) { rejectTrade(pair, 'invalid_ask'); continue; }
      const buyLimitNum = Number(buyLimitStr);
      const buyLimitOffsetBpsFromAsk = Number.isFinite(buyLimitNum) && ask > 0 ? ((ask - buyLimitNum) / ask) * 10000 : 0;
      // Conviction sizing: scale the base notional up for high-conviction setups
      // (1.0x..maxSizeMult), re-clamped to available cash so a sized-up order can
      // never exceed buying power. tradeNotional was already cash-clamped, so the
      // multiplier only ever scales UP from a safe base.
      const sizedNotional = tradeNotional * convictionSizeMult;
      const effectiveNotional = Number.isFinite(availableCash)
        ? Math.min(sizedNotional, availableCash)
        : sizedNotional;

      const buyRes = await submitOrder({
        symbol: pair,
        side: 'buy',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: buyLimitStr,
        notional: effectiveNotional.toFixed(2),
        post_only: ENTRY_POST_ONLY,
      });
      const buyOrder = buyRes?.buy || buyRes;
      if (buyOrder?.id) {
        const submittedAt = Date.now();
        const nowIso = new Date().toISOString();
        // Maker-fill funnel (2026-06-18): the order rested (got an id). Its
        // terminal fate is recorded later as 'filled' (buy_filled) or
        // 'unfilled_cancelled' (entry_fill_timeout). Observational only.
        try {
          makerFillTracker.record({
            outcome: 'submitted',
            postOnly: ENTRY_POST_ONLY,
            symbol: pair,
            signalVersion: sig.signalVersion || ACTIVE_SIGNAL_VERSION,
          });
        } catch (_) { /* never let instrumentation break the scan */ }
        // STEP 3 (the sell signal): derive this trade's GTC sell target FROM
        // the entry signal. The exit manager reads signalDerivedGrossBps off
        // this prediction record and rests the sell at entry × (1 + gross).
        const signalDerivedNetBps = deriveSignalTargetNetBps(projectedBps, sig.signalVersion || ACTIVE_SIGNAL_VERSION);
        const signalDerivedGrossBps = signalDerivedNetBps + FEE_BPS_ROUND_TRIP;
        const volBpsForStop = Number.isFinite(sig.volatilityBps) ? sig.volatilityBps : null;
        const volScaledStopLossBps = deriveStopLossBps(volBpsForStop, spreadBps, sig.signalVersion || ACTIVE_SIGNAL_VERSION, pair);
        const prediction = {
          buyOrderId: buyOrder.id,
          exploration: false,
          buyLimit: buyLimitNum,
          buyLimitPriceMode: ENTRY_LIMIT_PRICE_MODE,
          buyLimitOffsetBpsFromAsk,
          entryFillTimeoutMs: ENTRY_FILL_TIMEOUT_MS,
          askAtSubmit: ask,
          bidAtSubmit: bid,
          tradeNotional: effectiveNotional,
          spreadBps,
          quoteAgeMs: ageMs,
          slopeBpsPerBar: Number.isFinite(sig.slopeBpsPerBar) ? sig.slopeBpsPerBar : null,
          rSquared: Number.isFinite(sig.rSquared) ? sig.rSquared : null,
          slopeTStat: Number.isFinite(sig.slopeTStat) ? sig.slopeTStat : null,
          volatilityBps: Number.isFinite(sig.volatilityBps) ? sig.volatilityBps : null,
          projectedBps,
          expectedMoveBps: Math.min(projectedBps, GROSS_TARGET_BPS),
          feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
          entrySlippageBps: ENTRY_SLIPPAGE_BPS,
          exitSlippageBps: EXIT_SLIPPAGE_BPS,
          grossTargetBps: signalDerivedGrossBps,        // per-trade gross target used by exit
          targetNetProfitBps: signalDerivedNetBps,       // per-trade net target used by exit
          staticGrossTargetBps: GROSS_TARGET_BPS,
          staticTargetNetProfitBps: TARGET_NET_PROFIT_BPS,
          signalDerivedNetBps,
          signalDerivedGrossBps,
          signalSizedExitEnabled: SIGNAL_SIZED_EXIT_ENABLED,
          signalTargetMaxNetBps: SIGNAL_TARGET_MAX_NET_BPS,
          stopLossBpsResolved: volScaledStopLossBps,
          staticStopLossBps: STOP_LOSS_BPS,
          volScaledStopEnabled: VOL_SCALED_STOP_ENABLED,
          stopLossVolK: STOP_LOSS_VOL_K,
          stopLossHorizonBars: STOP_LOSS_HORIZON_BARS,
          stopOverSpreadBps: STOP_OVER_SPREAD_BPS,
          volumeRatio: Number.isFinite(sig.volumeRatio) ? sig.volumeRatio : null,
          btcLeadLag: pair === BTC_LEAD_LAG_SYMBOL ? null : getBtcLeadLagSnapshot(),
          signalVersion: sig.signalVersion || ACTIVE_SIGNAL_VERSION,
          multiFactor: sig.factors
            ? {
                confidence: sig.confidence,
                atrBps: sig.atrBps,
                htfTrend: sig.factors.htfTrend?.ok,
                pullback: sig.factors.pullback?.ok,
                turnConfirm: sig.factors.turnConfirm?.ok,
              }
            : null,
        };
        pendingBuys.set(pair, { orderId: buyOrder.id, submittedAt, limit: ask });
        tradePredictions.set(pair, {
          tradeId: buyOrder.id,
          submittedAt,
          prediction,
          buyFillObserved: false,
          actualEntryPrice: null,
        });
        try {
          tradeForensics.append({
            tradeId: buyOrder.id,
            symbol: pair,
            phase: 'entry_submitted',
            ts: nowIso,
            ...prediction,
          });
        } catch (err) {
          console.warn('forensics_entry_append_failed', { symbol: pair, error: err?.message });
        }
        entryIntentState.set(pair, {
          state: 'pending_fill',
          createdAt: nowIso,
          updatedAt: nowIso,
          rejectionReason: null,
          prediction,
        });
        console.log('entry_submitted', {
          symbol: pair,
          tradeId: buyOrder.id,
          signalVersion: prediction.signalVersion,
          buyLimit: prediction.buyLimit,
          notional: effectiveNotional,
          spreadBps,
          projectedBps,
          signalDerivedNetBps,
          signalDerivedGrossBps,
          stopLossBpsResolved: volScaledStopLossBps,
          volatilityBps: prediction.volatilityBps,
        });
        summary.entered += 1;
        summary.acceptedSymbols.push(pair);
        lastSuccessfulAction = { at: nowIso, symbol: pair, action: 'buy_submitted', orderId: buyOrder.id };
        placed += 1;
      } else {
        rejectTrade(pair, 'buy_rejected');
      }
    } catch (err) {
      // Surface the venue's own error code + message when present (Binance.US
      // signed errors carry binanceErrorCode/binanceErrorMessage).
      const binanceErrorCode = err?.binanceErrorCode ?? null;
      const binanceErrorMessage = err?.binanceErrorMessage ?? null;
      const baseMessage = err?.errorMessage || err?.message || String(err);
      const message = binanceErrorCode != null
        ? `${baseMessage} (binance ${binanceErrorCode}: ${binanceErrorMessage || 'no detail'})`
        : baseMessage;
      lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'buy_failed', message, binanceErrorCode, binanceErrorMessage };
      // Maker-fill funnel (2026-06-18): a post-only (LIMIT_MAKER) entry that
      // would have crossed is rejected by Binance (code -2010, "would
      // immediately match and take"). That is the gate working as intended —
      // we refused to pay taker — so it is tracked distinctly from a generic
      // submit failure. Observational only.
      if (ENTRY_POST_ONLY) {
        const wouldCrossReject = Number(binanceErrorCode) === -2010
          || /immediately match|would.*match|maker/i.test(String(baseMessage));
        if (wouldCrossReject) {
          try {
            makerFillTracker.record({
              outcome: 'rejected_post_only',
              postOnly: true,
              symbol: pair,
              signalVersion: ACTIVE_SIGNAL_VERSION,
            });
          } catch (_) { /* never let instrumentation break the scan */ }
        }
      }
      rejectTrade(pair, 'buy_error', { message, binanceErrorCode, binanceErrorMessage });
    }
  }

  summary.topSkipReasons = mapToObject(skipReasonCounts);
  lastEntryScanSummary = summary;
  lastEntryScanAt = new Date().toISOString();
  currentScanState = 'idle';
  setEngineState('ready', 'scan_completed');
}

function startEntryManager() {
  if (entryManagerRunning) return;
  entryManagerRunning = true;
  setEngineState('scanning', 'entry_manager_started');
  const tick = () => {
    scanAndEnter()
      .catch((err) => console.warn('entry_scan_failed', err?.errorMessage || err?.message || err))
      .finally(() => {
        if (entryManagerRunning) {
          entryManagerIntervalId = setTimeout(tick, ENTRY_SCAN_INTERVAL_MS);
        }
      });
  };
  entryManagerIntervalId = setTimeout(tick, 1000);
}

async function getConcurrencyGuardStatus() {
  let openPositions = [];
  let openOrders = [];
  try { openPositions = await fetchPositions(); } catch (_) { /* ignore */ }
  try { openOrders = await fetchOrders({ status: 'open', limit: 500 }); } catch (_) { /* ignore */ }
  return {
    openPositions,
    openOrders,
    activeSlotsUsed: openPositions.length,
    capMaxEnv: null,
    capMaxEffective: null,
    capEnabled: false,
    lastScanAt: lastEntryScanAt,
  };
}

// --- exit engine --------------------------------------------------------
//
// Once a buy fills (we see a position with qty>0 and no open sell order),
// submit ONE GTC limit sell at avg_entry * (1 + grossBps/10000), where
// `grossBps` is the per-trade signal-sized target stored on the prediction
// (or the global GROSS_TARGET_BPS fallback if no prediction is available,
// e.g. for positions adopted on engine restart).

function targetPriceFor(avgEntry, overrideGrossBps) {
  const candidate = Number(overrideGrossBps);
  const grossBps = Number.isFinite(candidate) && candidate > 0 ? candidate : GROSS_TARGET_BPS;
  return avgEntry * (1 + grossBps / 10000);
}

function resolveExitGrossBps(pair) {
  const pred = tradePredictions.get(pair);
  const candidate = Number(pred?.prediction?.signalDerivedGrossBps);
  if (Number.isFinite(candidate) && candidate > 0) return candidate;
  return GROSS_TARGET_BPS;
}

function resolveExitNetBps(pair) {
  const pred = tradePredictions.get(pair);
  const candidate = Number(pred?.prediction?.signalDerivedNetBps);
  if (Number.isFinite(candidate) && candidate > 0) return candidate;
  return TARGET_NET_PROFIT_BPS;
}

function resolveStopLossBps(pair) {
  const pred = tradePredictions.get(pair);
  const candidate = Number(pred?.prediction?.stopLossBpsResolved);
  if (Number.isFinite(candidate) && candidate > 0) return candidate;
  return STOP_LOSS_BPS;
}

function getStopLossConfig() {
  return {
    enabled: STOP_LOSS_ENABLED,
    staticBps: STOP_LOSS_BPS,
    volScaledEnabled: VOL_SCALED_STOP_ENABLED,
    volK: STOP_LOSS_VOL_K,
    horizonBars: STOP_LOSS_HORIZON_BARS,
    floorBps: STOP_LOSS_BPS_FLOOR,
    overSpreadBps: STOP_OVER_SPREAD_BPS,
  };
}

// Resolved entry prices for Binance.US held positions, keyed by pair. Binance
// has no native avg_entry_price (positions are synthesized from spot
// balances), so reconcileExits resolves one and caches it here to avoid
// re-querying trade history every cycle. Cleared when the position closes or a
// pending buy times out (alongside positionFirstSeenAt / tradePredictions).
const binanceEntryPriceCache = new Map();

// Resolve the entry price of a held Binance.US position so reconcileExits can
// attach the GTC sell. Priority: cached value → the maker buy-limit the bot
// placed (a resting maker order fills at its limit, so this is exact and never
// understates breakeven) → cost basis reconstructed from Binance trade history
// (the only source that survives a restart that cleared the in-memory
// prediction — including this fix's own deploy). Returns NaN when nothing
// resolves, in which case the caller leaves the position untouched this cycle.
async function resolveBinanceEntryPrice(pair) {
  const cached = Number(binanceEntryPriceCache.get(pair));
  if (Number.isFinite(cached) && cached > 0) return cached;
  const pred = tradePredictions.get(pair);
  const cachedFill = Number(pred?.actualEntryPrice);
  if (Number.isFinite(cachedFill) && cachedFill > 0) return cachedFill;
  const buyLimit = Number(pred?.prediction?.buyLimit);
  if (Number.isFinite(buyLimit) && buyLimit > 0) return buyLimit;
  try {
    const fromTrades = await binanceExecution.getEntryPrice(pair);
    if (Number.isFinite(fromTrades) && fromTrades > 0) {
      binanceEntryPriceCache.set(pair, fromTrades);
      return fromTrades;
    }
  } catch (err) {
    console.warn('binance_entry_price_resolve_failed', { symbol: pair, error: err?.message });
  }
  return NaN;
}

async function reconcileExits() {
  const { byPair, openSellByPair } = await buildHeldAndOpenSellsIndex();

  // Fix 1: cancel pending buys that haven't filled within ENTRY_FILL_TIMEOUT_MS.
  // Passive (mid / bid_plus_tick) entries may rest under the market if the
  // ask runs away; we don't want a stale buy to fill seconds-to-minutes later
  // at a no-longer-edge price. A position that already appeared in byPair has
  // partial/full fill and is handled below — only cancel pendings that are
  // still purely unfilled.
  if (ENTRY_FILL_TIMEOUT_MS > 0) {
    const nowMs = Date.now();
    for (const [pair, pending] of Array.from(pendingBuys.entries())) {
      if (byPair.has(pair)) continue;
      const submittedAt = Number(pending?.submittedAt);
      if (!Number.isFinite(submittedAt)) continue;
      const ageMs = nowMs - submittedAt;
      if (ageMs <= ENTRY_FILL_TIMEOUT_MS) continue;
      const orderId = pending?.orderId;
      if (!orderId) { pendingBuys.delete(pair); continue; }
      try {
        await cancelOrder(orderId);
        console.log('entry_fill_timeout_cancel', { symbol: pair, orderId, ageMs });
        try {
          tradeForensics.update(orderId, {
            phase: 'entry_cancelled_timeout',
            cancelledAt: new Date().toISOString(),
            entryFillAgeMs: ageMs,
          });
        } catch (err) {
          console.warn('forensics_entry_timeout_update_failed', { symbol: pair, error: err?.message });
        }
      } catch (err) {
        console.warn('entry_fill_timeout_cancel_failed', {
          symbol: pair,
          orderId,
          error: err?.errorMessage || err?.message,
        });
      }
      // Maker-fill funnel (2026-06-18): the rested entry never filled within
      // ENTRY_FILL_TIMEOUT_MS and was recycled. Terminal state for 'submitted'.
      // (A held position would have hit `byPair.has(pair)` continue above, so
      // this is genuinely an unfilled rest, not a partial fill.)
      try {
        makerFillTracker.record({
          outcome: 'unfilled_cancelled',
          postOnly: ENTRY_POST_ONLY,
          symbol: pair,
          signalVersion: tradePredictions.get(pair)?.prediction?.signalVersion || SIGNAL_VERSION_OPERATOR_OVERRIDE || null,
        });
      } catch (_) { /* never let instrumentation break the reconcile */ }
      pendingBuys.delete(pair);
      tradePredictions.delete(pair);
      entryIntentState.delete(pair);
      binanceEntryPriceCache.delete(pair);
    }
  }

  for (const [pair, pos] of byPair.entries()) {
    const qty = Number(pos?.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    let avg = Number(pos?.avg_entry_price);

    // Binance.US synthesizes positions from spot balances and exposes no
    // native avg_entry_price (binanceExecution.fetchPositions returns null).
    // Without an entry price every branch below short-circuits, so the GTC
    // sell is never attached and the position sits in `pending_fill` forever,
    // permanently holding a concurrency slot — the failure mode that wedged
    // the whole bot (8/8 slots stuck, every scan rejecting on
    // concurrent_position_cap). Recover the entry price from the buy the bot
    // placed, or from Binance trade history after a restart.
    if (IS_BINANCE_EXECUTION && (!Number.isFinite(avg) || avg <= 0)) {
      avg = await resolveBinanceEntryPrice(pair);
    }

    // Stamp first-seen on first observation so age diagnostics start ticking.
    // Also re-stamp if a new buy cycle has clearly started since the previous
    // stamp was recorded — detected by tradePredictions.submittedAt being newer
    // than the stored stamp by more than a small slack. Without this, a
    // close-then-reopen sequence whose close was missed by the close-detection
    // loop (e.g. old TP filled and new buy filled between two reconcile polls)
    // leaves positionFirstSeenAt holding the *previous* position's timestamp.
    // On the next reconcile, ageMs is computed from that stale stamp, exceeds
    // BREAKEVEN_TIMEOUT_MS instantly, and the engine cancels the brand-new
    // +25 bps TP and replaces it with a break-even-after-fees sell that
    // typically fills immediately — converting a real win into a 0 bps trade.
    // The `breakeven_limit` close events with `holdSeconds:0` in the logs are
    // exactly this bug.
    const predForStamp = tradePredictions.get(pair);
    const predSubmittedMs = Number(predForStamp?.submittedAt) || 0;
    const prevStampMs = positionFirstSeenAt.get(pair);
    const stampIsStale = Number.isFinite(prevStampMs)
      && predSubmittedMs > 0
      && predSubmittedMs > prevStampMs + 60000;
    if (!positionFirstSeenAt.has(pair) || stampIsStale) {
      const pending = pendingBuys.get(pair);
      const stamp = Number(pending?.submittedAt)
        || (predSubmittedMs > 0 ? predSubmittedMs : 0)
        || Date.parse(pos?.created_at || '')
        || Date.now();
      positionFirstSeenAt.set(pair, Number.isFinite(stamp) ? stamp : Date.now());
    }

    // Buy-fill observation: the first time we see this position after a
    // submit, stamp the actual entry price onto the prediction record so we
    // can later compare predicted-vs-realised.
    const pred = tradePredictions.get(pair);
    if (pred && !pred.buyFillObserved && Number.isFinite(avg) && avg > 0) {
      pred.buyFillObserved = true;
      pred.actualEntryPrice = avg;
      pred.buyFilledAt = new Date().toISOString();
      // Maker-fill funnel (2026-06-18): the rested entry filled — the maker
      // edge is captured. Terminal state for the 'submitted' event above.
      try {
        makerFillTracker.record({
          outcome: 'filled',
          postOnly: ENTRY_POST_ONLY,
          symbol: pair,
          signalVersion: pred.prediction?.signalVersion || SIGNAL_VERSION_OPERATOR_OVERRIDE || null,
        });
      } catch (_) { /* never let instrumentation break the reconcile */ }
      const entrySlipActualBps = Number.isFinite(pred.prediction?.buyLimit) && pred.prediction.buyLimit > 0
        ? ((avg - pred.prediction.buyLimit) / pred.prediction.buyLimit) * 10000
        : null;
      try {
        tradeForensics.update(pred.tradeId, {
          phase: 'buy_filled',
          actualEntryPrice: avg,
          buyFilledAt: pred.buyFilledAt,
          entrySlippageActualBps: entrySlipActualBps,
        });
      } catch (err) {
        console.warn('forensics_buy_fill_update_failed', { symbol: pair, error: err?.message });
      }
    }

    // Risk cap: optional stop-loss. The stop distance is per-trade — sized
    // at entry from realised volatility (vol-scaled), or static if the
    // prediction record is missing (e.g. position adopted on engine restart).
    // The static STOP_LOSS_BPS acts as the upper cap, never wider than today.
    if (STOP_LOSS_ENABLED && Number.isFinite(avg) && avg > 0) {
      const quote = await getLatestQuote(pair).catch(() => null);
      const bid = Number(quote?.bp);
      const stopBps = resolveStopLossBps(pair);
      const stopPrice = avg * (1 - stopBps / 10000);
      if (Number.isFinite(bid) && bid > 0 && bid <= stopPrice) {
        const existing = openSellByPair.get(pair);
        try {
          if (existing?.id) await cancelOrder(existing.id);
          const sellResult = await submitOrder({
            symbol: pair,
            side: 'sell',
            type: 'market',
            time_in_force: 'ioc',
            qty: String(qty),
          });
          const sellOrder = sellResult?.id ? sellResult : sellResult?.sell || sellResult;
          const triggeredAt = sellOrder?.submitted_at || new Date().toISOString();
          // Capture the most accurate exit-price estimate available. IOC
          // market sells sometimes return filled_avg_price immediately on
          // accept; if not, the live bid at trigger time is a closer estimate
          // than the stop threshold itself (which the bid breached).
          const orderFillPrice = Number(sellOrder?.filled_avg_price);
          const stopLossExitPrice = Number.isFinite(orderFillPrice) && orderFillPrice > 0
            ? orderFillPrice
            : (Number.isFinite(bid) && bid > 0 ? bid : stopPrice);
          exitState.set(pair, {
            ...exitState.get(pair),
            sellOrderId: sellOrder?.id || null,
            targetPrice: stopPrice,
            sellOrderSubmittedAt: triggeredAt,
            reconciliationState: 'stop_loss_triggered',
            lastReconciliationAction: 'stop_loss_market_sell',
            expectedNetProfitBps: -stopBps,
            minNetProfitBps: -stopBps,
            stopLossTriggered: true,
            stopLossTriggeredAt: triggeredAt,
            stopLossExitPrice,
            stopLossThresholdPrice: stopPrice,
            stopLossBpsUsed: stopBps,
          });
          lastSuccessfulAction = { at: new Date().toISOString(), symbol: pair, action: 'stop_loss_market_sell', orderId: sellOrder?.id || null };
          console.log('exit_stop_loss_triggered', {
            symbol: pair,
            bid,
            stopPrice,
            stopLossBps: stopBps,
            staticStopLossBps: STOP_LOSS_BPS,
            volScaled: stopBps !== STOP_LOSS_BPS,
            cancelledOrderId: existing?.id || null,
            newOrderId: sellOrder?.id || null,
          });
          continue;
        } catch (err) {
          lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'stop_loss_failed', message: err?.errorMessage || err?.message || String(err) };
          console.warn('exit_stop_loss_failed', { symbol: pair, error: err?.errorMessage || err?.message });
        }
      }
    }

    // Fix 3: hard max-hold market exit. Staircase walks the sell down to
    // break-even-after-fees and pins there; without this, a position that
    // never trips the stop and never wicks to break-even sits indefinitely.
    // After MAX_HOLD_MS the resting sell is cancelled and a market IOC sell
    // closes the position at whatever the bid is — actually realises the
    // outcome instead of parking capital.
    // Signal-aware max-hold: MF uses MF_MAX_HOLD_MS (default 6 h) so its
    // wider TP target has the σ-time it needs to develop.
    const positionSignalVersion = tradePredictions.get(pair)?.prediction?.signalVersion || 'ols';
    const positionMaxHoldMs = getMaxHoldMsForSignal(positionSignalVersion);
    if (positionMaxHoldMs > 0 && Number.isFinite(avg) && avg > 0) {
      const existing = openSellByPair.get(pair);
      const ageMs = resolveStaircaseAgeMs(pair, existing);
      if (ageMs >= positionMaxHoldMs) {
        try {
          if (existing?.id) await cancelOrder(existing.id);
          const sellResult = await submitOrder({
            symbol: pair,
            side: 'sell',
            type: 'market',
            time_in_force: 'ioc',
            qty: String(qty),
          });
          const sellOrder = sellResult?.id ? sellResult : sellResult?.sell || sellResult;
          const triggeredAt = sellOrder?.submitted_at || new Date().toISOString();
          const orderFillPrice = Number(sellOrder?.filled_avg_price);
          const quote = await getLatestQuote(pair).catch(() => null);
          const bidNow = Number(quote?.bp);
          const exitPrice = Number.isFinite(orderFillPrice) && orderFillPrice > 0
            ? orderFillPrice
            : (Number.isFinite(bidNow) && bidNow > 0 ? bidNow : avg);
          const realizedGrossBps = avg > 0 ? ((exitPrice - avg) / avg) * 10000 : 0;
          exitState.set(pair, {
            ...exitState.get(pair),
            sellOrderId: sellOrder?.id || null,
            targetPrice: exitPrice,
            sellOrderSubmittedAt: triggeredAt,
            reconciliationState: 'max_hold_market_exit',
            lastReconciliationAction: 'max_hold_market_sell',
            expectedNetProfitBps: realizedGrossBps - FEE_BPS_ROUND_TRIP,
            minNetProfitBps: realizedGrossBps - FEE_BPS_ROUND_TRIP,
            maxHoldExitTriggered: true,
            maxHoldExitAt: triggeredAt,
            maxHoldExitPrice: exitPrice,
            maxHoldAgeMs: ageMs,
          });
          lastSuccessfulAction = { at: new Date().toISOString(), symbol: pair, action: 'max_hold_market_sell', orderId: sellOrder?.id || null };
          console.log('exit_max_hold_triggered', {
            symbol: pair,
            ageMs,
            maxHoldMs: positionMaxHoldMs,
            signalVersion: positionSignalVersion,
            exitPrice,
            realizedGrossBps: Number(realizedGrossBps.toFixed(2)),
            cancelledOrderId: existing?.id || null,
            newOrderId: sellOrder?.id || null,
          });
          continue;
        } catch (err) {
          lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'max_hold_exit_failed', message: err?.errorMessage || err?.message || String(err) };
          console.warn('exit_max_hold_failed', { symbol: pair, error: err?.errorMessage || err?.message });
        }
      }
    }

    if (openSellByPair.has(pair)) {
      const existing = openSellByPair.get(pair);
      const limit = Number(existing?.limit_price);
      const priorState = exitState.get(pair) || {};
      const breakevenAttachedPrior = priorState.breakevenAttached === true;
      const observedExitGrossBps = resolveExitGrossBps(pair);
      const observedExitNetBps = resolveExitNetBps(pair);
      exitState.set(pair, {
        sellOrderId: existing.id || null,
        sellOrderLimit: Number.isFinite(limit) ? limit : null,
        targetPrice: Number.isFinite(limit) ? limit : null,
        sellOrderSubmittedAt: existing.submitted_at || null,
        expectedOpenSell: true,
        brokerOpenSellFound: true,
        brokerOpenSellQty: Number(existing.qty) || qty,
        reconciliationState: breakevenAttachedPrior ? 'breakeven_attached' : 'open_sell_found',
        lastReconciliationAction: breakevenAttachedPrior ? 'breakeven_sell_seen' : 'existing_sell_seen',
        targetPriceSource: 'open_orders',
        entryPriceUsed: Number.isFinite(avg) ? avg : null,
        expectedNetProfitBps: breakevenAttachedPrior ? 0 : observedExitNetBps,
        minNetProfitBps: breakevenAttachedPrior ? 0 : observedExitNetBps,
        desiredNetExitBps: breakevenAttachedPrior ? FEE_BPS_ROUND_TRIP : observedExitGrossBps,
        feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
        requiredExitBpsGross: breakevenAttachedPrior ? FEE_BPS_ROUND_TRIP : observedExitGrossBps,
        requiredExitBps: breakevenAttachedPrior ? FEE_BPS_ROUND_TRIP : observedExitGrossBps,
        trueBreakevenPrice: Number.isFinite(avg) ? avg * (1 + FEE_BPS_ROUND_TRIP / 10000) : null,
        breakevenPrice: Number.isFinite(avg) ? avg * (1 + FEE_BPS_ROUND_TRIP / 10000) : null,
        profitabilityFloorPrice: Number.isFinite(avg) ? avg * (1 + (FEE_BPS_ROUND_TRIP + PROFIT_BUFFER_BPS) / 10000) : null,
        lastSeenOpenSellAt: new Date().toISOString(),
        breakevenAttached: breakevenAttachedPrior,
        breakevenAttachedAt: priorState.breakevenAttachedAt || null,
      });
      entryIntentState.set(pair, { state: 'managing', createdAt: entryIntentState.get(pair)?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), rejectionReason: null });
      pendingBuys.delete(pair);

      // Staircase exit: walk the GTC sell limit DOWN linearly from the
      // initial signal-derived TP to break-even-after-fees over
      // BREAKEVEN_TIMEOUT_MS. Floor: entry × (1 + fees/10000) = $0 net.
      // Reposts only when the desired price drops by ≥ tolerance below
      // the resting limit, so we don't churn cancel/repost on tiny age
      // increments. When STAIRCASE_EXIT_ENABLED=false, falls back to the
      // legacy one-shot break-even-replace at T = BREAKEVEN_TIMEOUT_MS.
      if (STAIRCASE_EXIT_ENABLED && Number.isFinite(avg) && avg > 0 && existing?.id) {
        const ageMs = resolveStaircaseAgeMs(pair, existing);
        const initialGrossBps = resolveExitGrossBps(pair);
        // Signal-aware decay timeout: MF positions need the wider TP more time
        // to fill before being walked toward break-even.
        const positionBreakevenTimeoutMs = getBreakevenTimeoutMsForSignal(positionSignalVersion);
        const desiredGrossBps = computeStaircaseExitGrossBps(initialGrossBps, ageMs, positionBreakevenTimeoutMs);
        const desiredPrice = avg * (1 + desiredGrossBps / 10000);
        const currentLimit = Number(existing?.limit_price);
        const currentGrossBps = Number.isFinite(currentLimit) && currentLimit > 0
          ? ((currentLimit - avg) / avg) * 10000
          : initialGrossBps;
        const dropBps = currentGrossBps - desiredGrossBps;
        const isBreakeven = desiredGrossBps <= FEE_BPS_ROUND_TRIP + 0.01;
        // Repost only if desired is meaningfully below current AND we
        // haven't already pinned at break-even (no need to repost the
        // same price every cycle).
        if (dropBps >= STAIRCASE_REPOST_TOLERANCE_BPS && !(breakevenAttachedPrior && isBreakeven)) {
          try {
            await cancelOrder(existing.id);
            const tickInfo = await getAssetTickInfo(pair);
            const limitStr = formatTickPrice(desiredPrice, tickInfo.priceIncrement);
            if (limitStr) {
              const sellResult = await submitOrder({
                symbol: pair,
                side: 'sell',
                type: 'limit',
                time_in_force: 'gtc',
                qty: String(qty),
                limit_price: limitStr,
              });
              const sellOrder = sellResult?.id ? sellResult : sellResult?.sell || sellResult;
              const submittedAt = sellOrder?.submitted_at || new Date().toISOString();
              const expectedNetBps = Math.max(0, desiredGrossBps - FEE_BPS_ROUND_TRIP);
              exitState.set(pair, {
                ...exitState.get(pair),
                sellOrderId: sellOrder?.id || null,
                sellOrderLimit: desiredPrice,
                targetPrice: desiredPrice,
                sellOrderSubmittedAt: submittedAt,
                reconciliationState: isBreakeven ? 'breakeven_attached' : 'staircase_step',
                lastReconciliationAction: isBreakeven ? 'breakeven_replace' : 'staircase_repost',
                targetPriceSource: isBreakeven ? 'breakeven_replace' : 'staircase_step',
                expectedNetProfitBps: expectedNetBps,
                minNetProfitBps: expectedNetBps,
                desiredNetExitBps: desiredGrossBps,
                requiredExitBpsGross: desiredGrossBps,
                requiredExitBps: desiredGrossBps,
                breakevenAttached: isBreakeven,
                breakevenAttachedAt: isBreakeven ? submittedAt : null,
                lastSeenOpenSellAt: submittedAt,
              });
              lastSuccessfulAction = {
                at: new Date().toISOString(),
                symbol: pair,
                action: isBreakeven ? 'breakeven_replace' : 'staircase_repost',
                orderId: sellOrder?.id || null,
              };
              console.log('exit_staircase_step', {
                symbol: pair,
                ageSeconds: Math.round(ageMs / 1000),
                initialGrossBps: Number(initialGrossBps.toFixed(2)),
                previousGrossBps: Number(currentGrossBps.toFixed(2)),
                desiredGrossBps: Number(desiredGrossBps.toFixed(2)),
                desiredNetBps: Number((desiredGrossBps - FEE_BPS_ROUND_TRIP).toFixed(2)),
                newLimitPrice: desiredPrice,
                isBreakeven,
                cancelledOrderId: existing.id,
                newOrderId: sellOrder?.id || null,
              });
            }
          } catch (err) {
            lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'staircase_repost_failed', message: err?.errorMessage || err?.message || String(err) };
            console.warn('exit_staircase_failed', { symbol: pair, error: err?.errorMessage || err?.message });
          }
        }
      } else if (!breakevenAttachedPrior && Number.isFinite(avg) && avg > 0 && existing?.id) {
        // Legacy one-shot break-even reset (when staircase is disabled).
        // Kept verbatim for env-flag rollback safety. Uses the same
        // restart-resilient age anchor as the staircase path.
        const ageMs = resolveStaircaseAgeMs(pair, existing);
        if (ageMs >= getBreakevenTimeoutMsForSignal(positionSignalVersion)) {
          try {
            await cancelOrder(existing.id);
            const breakevenPrice = avg * (1 + FEE_BPS_ROUND_TRIP / 10000);
            const tickInfo = await getAssetTickInfo(pair);
            const limitStr = formatTickPrice(breakevenPrice, tickInfo.priceIncrement);
            if (limitStr) {
              const sellResult = await submitOrder({
                symbol: pair,
                side: 'sell',
                type: 'limit',
                time_in_force: 'gtc',
                qty: String(qty),
                limit_price: limitStr,
              });
              const sellOrder = sellResult?.id ? sellResult : sellResult?.sell || sellResult;
              const submittedAt = sellOrder?.submitted_at || new Date().toISOString();
              exitState.set(pair, {
                ...exitState.get(pair),
                sellOrderId: sellOrder?.id || null,
                sellOrderLimit: breakevenPrice,
                targetPrice: breakevenPrice,
                sellOrderSubmittedAt: submittedAt,
                reconciliationState: 'breakeven_attached',
                lastReconciliationAction: 'breakeven_replace',
                targetPriceSource: 'breakeven_replace',
                expectedNetProfitBps: 0,
                minNetProfitBps: 0,
                desiredNetExitBps: FEE_BPS_ROUND_TRIP,
                requiredExitBpsGross: FEE_BPS_ROUND_TRIP,
                requiredExitBps: FEE_BPS_ROUND_TRIP,
                breakevenAttached: true,
                breakevenAttachedAt: submittedAt,
                lastSeenOpenSellAt: submittedAt,
              });
              lastSuccessfulAction = { at: new Date().toISOString(), symbol: pair, action: 'breakeven_replace', orderId: sellOrder?.id || null };
              console.log('exit_breakeven_replace', {
                symbol: pair,
                breakevenPrice,
                ageSeconds: Math.round(ageMs / 1000),
                cancelledOrderId: existing.id,
                newOrderId: sellOrder?.id || null,
              });
            }
          } catch (err) {
            lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'breakeven_replace_failed', message: err?.errorMessage || err?.message || String(err) };
            console.warn('exit_breakeven_failed', { symbol: pair, error: err?.errorMessage || err?.message });
          }
        }
      }
      continue;
    }

    if (!Number.isFinite(avg) || avg <= 0) continue;
    const exitGrossBps = resolveExitGrossBps(pair);
    const exitNetBps = resolveExitNetBps(pair);
    const target = targetPriceFor(avg, exitGrossBps);
    const tickInfo = await getAssetTickInfo(pair);
    const limitStr = formatTickPrice(target, tickInfo.priceIncrement);
    if (!limitStr) {
      lastExecutionFailure = {
        at: new Date().toISOString(),
        symbol: pair,
        reason: 'invalid_target_price',
        message: `target=${target} tick=${tickInfo.priceIncrement}`,
      };
      continue;
    }
    const qtyStr = String(pos.qty);
    try {
      const sellResult = await submitOrder({
        symbol: pair,
        side: 'sell',
        type: 'limit',
        time_in_force: 'gtc',
        qty: qtyStr,
        limit_price: limitStr,
      });
      const sellOrder = sellResult?.id ? sellResult : sellResult?.sell || sellResult?.buy || sellResult;
      exitState.set(pair, {
        sellOrderId: sellOrder?.id || null,
        sellOrderLimit: target,
        targetPrice: target,
        sellOrderSubmittedAt: sellOrder?.submitted_at || new Date().toISOString(),
        expectedOpenSell: true,
        brokerOpenSellFound: true,
        brokerOpenSellQty: Number(qtyStr) || 0,
        reconciliationState: 'sell_submitted',
        lastReconciliationAction: 'sell_submitted',
        targetPriceSource: 'computed',
        entryPriceUsed: avg,
        expectedNetProfitBps: exitNetBps,
        minNetProfitBps: exitNetBps,
        desiredNetExitBps: exitGrossBps,
        feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
        requiredExitBpsGross: exitGrossBps,
        requiredExitBps: exitGrossBps,
        trueBreakevenPrice: avg * (1 + FEE_BPS_ROUND_TRIP / 10000),
        breakevenPrice: avg * (1 + FEE_BPS_ROUND_TRIP / 10000),
        profitabilityFloorPrice: avg * (1 + (FEE_BPS_ROUND_TRIP + PROFIT_BUFFER_BPS) / 10000),
        lastSeenOpenSellAt: new Date().toISOString(),
      });
      entryIntentState.set(pair, { state: 'managing', createdAt: entryIntentState.get(pair)?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), rejectionReason: null });
      pendingBuys.delete(pair);
      lastSuccessfulAction = { at: new Date().toISOString(), symbol: pair, action: 'sell_submitted', orderId: sellOrder?.id || null };
      console.log('exit_sell_attached', {
        symbol: pair,
        target,
        targetGrossBps: exitGrossBps,
        targetNetBps: exitNetBps,
        signalSized: exitGrossBps !== GROSS_TARGET_BPS,
        orderId: sellOrder?.id || null,
      });
    } catch (err) {
      lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'sell_submit_failed', message: err?.errorMessage || err?.message || String(err) };
      console.warn('exit_sell_failed', { symbol: pair, error: err?.errorMessage || err?.message });
    }
  }

  // Close detection: any pair we had exitState for but that's no longer a
  // held position means the limit sell filled. Emit a closed_trade record so
  // realised edge can be compared against the entry-time prediction.
  for (const [pair, state] of Array.from(exitState.entries())) {
    if (byPair.has(pair)) continue;
    const pred = tradePredictions.get(pair);
    const entry = Number(state?.entryPriceUsed);
    // For stop-loss / max-hold exits, prefer the recorded actual exit price
    // (live bid at trigger time, or filled_avg_price if Alpaca returned it on
    // the IOC market sell). Falls back to targetPrice for TP and break-even
    // closes where targetPrice IS the fill price by construction (GTC limit
    // fills).
    const stopLossClose = state?.stopLossTriggered === true;
    const maxHoldClose = state?.maxHoldExitTriggered === true;
    const stopLossExitPrice = Number(state?.stopLossExitPrice);
    const maxHoldExitPrice = Number(state?.maxHoldExitPrice);
    let exit;
    if (stopLossClose && Number.isFinite(stopLossExitPrice) && stopLossExitPrice > 0) exit = stopLossExitPrice;
    else if (maxHoldClose && Number.isFinite(maxHoldExitPrice) && maxHoldExitPrice > 0) exit = maxHoldExitPrice;
    else exit = Number(state?.targetPrice);
    const closedAt = new Date().toISOString();
    if (pred && Number.isFinite(entry) && entry > 0 && Number.isFinite(exit) && exit > 0) {
      const grossBps = ((exit - entry) / entry) * 10000;
      const netBps = grossBps - FEE_BPS_ROUND_TRIP;
      const notional = Number(pred.prediction?.tradeNotional) || 0;
      const grossPnlUsd = (grossBps * notional) / 10000;
      const netPnlUsd = (netBps * notional) / 10000;
      const holdSeconds = Math.max(0, (Date.now() - Number(pred.submittedAt || 0)) / 1000);
      // Close-classification precedence: stop_loss → max_hold → breakeven_limit
      // → tp_limit. Prior bug: stop-loss exits were silently labeled 'tp_limit'
      // because the close path only checked breakevenAttached, which inflated
      // tpFillRate and made the scorecard inconsistent (winRate=0,
      // tpFillRate=1 simultaneously when a single stop-out fired).
      let exitReason;
      if (stopLossClose) exitReason = 'stop_loss';
      else if (maxHoldClose) exitReason = 'max_hold';
      else if (state?.breakevenAttached) exitReason = 'breakeven_limit';
      else exitReason = 'tp_limit';
      try {
        closedTradeStats.append({
          tradeId: pred.tradeId,
          symbol: pair,
          // signalVersion tag (2026-05-19) lets the per-symbol expectancy
          // auditor and drift alerter break out realised P&L by signal,
          // not just aggregate. Without this tag both diagnostics collapse
          // every signal's results into one bucket and outliers hide.
          signalVersion: pred.prediction?.signalVersion ?? null,
          netPnlUsd,
          grossPnlUsd,
          holdSeconds,
          entrySpreadBps: pred.prediction?.spreadBps ?? null,
          entryQuoteAgeMs: pred.prediction?.quoteAgeMs ?? null,
          exitReason,
          // Predicted vs realised — the whole point of #6:
          predictedNetEdgeBps: pred.prediction?.netEdgeBps ?? null,
          predictedExpectedMoveBps: pred.prediction?.expectedMoveBps ?? null,
          predictedProjectedBps: pred.prediction?.projectedBps ?? null,
          predictedFillProbability: pred.prediction?.fillProbability ?? null,
          predictedSlopeTStat: pred.prediction?.slopeTStat ?? null,
          predictedSlopeBpsPerBar: pred.prediction?.slopeBpsPerBar ?? null,
          realizedGrossBps: grossBps,
          realizedNetBps: netBps,
        });
      } catch (err) {
        console.warn('closed_trade_stats_append_failed', { symbol: pair, error: err?.message });
      }
      try {
        tradeForensics.update(pred.tradeId, {
          phase: 'closed',
          closedAt,
          exitReason,
          realizedGrossBps: grossBps,
          realizedNetBps: netBps,
          realizedGrossPnlUsd: grossPnlUsd,
          realizedNetPnlUsd: netPnlUsd,
          holdSeconds,
        });
      } catch (err) {
        console.warn('forensics_close_update_failed', { symbol: pair, error: err?.message });
      }
      console.log('trade_closed', {
        symbol: pair,
        tradeId: pred.tradeId,
        grossBps: grossBps.toFixed(2),
        netBps: netBps.toFixed(2),
        exitReason,
        predictedNetEdgeBps: pred.prediction?.netEdgeBps,
        holdSeconds: holdSeconds.toFixed(0),
      });
    } else if (positionFirstSeenAt.has(pair)) {
      // Position we observed (e.g. on restart) but never had a prediction for.
      // Still emit a minimal closed-trade record so the scorecard counts it.
      try {
        closedTradeStats.append({
          symbol: pair,
          netPnlUsd: null,
          grossPnlUsd: null,
          holdSeconds: null,
          exitReason: 'tp_limit_untracked',
        });
      } catch (err) {
        console.warn('closed_trade_stats_append_failed', { symbol: pair, error: err?.message });
      }
    }
    exitState.delete(pair);
    tradePredictions.delete(pair);
    positionFirstSeenAt.delete(pair);
    entryIntentState.delete(pair);
    binanceEntryPriceCache.delete(pair);
  }
}

function startExitManager() {
  if (exitManagerRunning) return;
  exitManagerRunning = true;
  const tick = () => {
    reconcileExits()
      .catch((err) => console.warn('exit_reconcile_failed', err?.errorMessage || err?.message || err))
      .finally(() => {
        if (exitManagerRunning) {
          exitManagerIntervalId = setTimeout(tick, EXIT_SCAN_INTERVAL_MS);
        }
      });
  };
  exitManagerIntervalId = setTimeout(tick, 2000);
}

// Legacy /trade endpoint: trigger one buy for the given symbol.
async function placeMakerLimitBuyThenSell(symbol) {
  const pair = normalizePair(symbol);
  if (!pair) throw new Error('invalid_symbol');
  const quote = await getLatestQuote(pair);
  const ask = Number(quote?.ap);
  if (!Number.isFinite(ask) || ask <= 0) {
    return { ok: false, skipped: true, reason: 'no_ask_available' };
  }
  const account = await fetchAccount().catch(() => null);
  const equityRaw = account?.equity ?? account?.portfolio_value;
  const equityNum = Number(equityRaw);
  if (!Number.isFinite(equityNum) || equityNum <= 0) {
    return { ok: false, skipped: true, reason: 'sizing_unavailable' };
  }
  const cashRaw = account?.cash ?? account?.buying_power ?? account?.non_marginable_buying_power;
  const cashNum = Number(cashRaw);
  const availableCash = Number.isFinite(cashNum) ? cashNum : Infinity;
  const tradeNotional = Math.min(equityNum * PORTFOLIO_SIZING_PCT, availableCash);
  if (tradeNotional < MIN_TRADE_NOTIONAL_USD) {
    return { ok: false, skipped: true, reason: 'insufficient_cash' };
  }
  const buyRes = await submitOrder({
    symbol: pair, side: 'buy', type: 'limit', time_in_force: 'gtc',
    limit_price: ask, notional: tradeNotional.toFixed(2),
  });
  return { ok: true, buy: buyRes?.buy || buyRes, sell: null };
}

async function scanOrphanPositions() {
  const positions = await fetchPositions();
  const orders = await fetchOrders({ status: 'open', nested: true, limit: 500 });
  const openSellByPair = new Map();
  expandNestedOrders(orders).forEach((o) => {
    const pair = normalizePair(o?.symbol);
    if (!pair) return;
    if (String(o?.side || '').toLowerCase() === 'sell' && isOpenLikeOrderStatus(String(o?.status || ''))) {
      openSellByPair.set(pair, o);
    }
  });
  const orphans = [];
  for (const pos of positions) {
    const pair = normalizePair(pos?.symbol);
    const qty = Number(pos?.qty);
    if (!pair || !Number.isFinite(qty) || qty <= 0) continue;
    if (!openSellByPair.has(pair)) {
      orphans.push({ symbol: pair, qty, avg_entry_price: Number(pos.avg_entry_price) || null });
    }
  }
  return { orphans, positionsCount: positions.length, openOrdersCount: orders.length };
}

async function runDustCleanup() {
  return { ran: true, cleaned: 0 };
}

// --- Binance execution boot --------------------------------------------
// At boot, when EXECUTION_VENUE=binance_us, hydrate the symbol map from
// Binance.US's /api/v3/exchangeInfo so the adapter knows tickSize, stepSize,
// and MIN_NOTIONAL for each pair before any order is submitted. This is
// fire-and-forget — failures log but don't crash the boot (the operator can
// see the error in meta.binanceSymbolMap and react). When EXECUTION_VENUE
// is anything other than 'binance_us', the hydrate is skipped entirely.
function getBinanceExecutionStatus() {
  return {
    venue: EXECUTION_VENUE,
    isBinance: IS_BINANCE_EXECUTION,
    symbolHydration: binanceSymbols.getHydrationStatus(),
    resolvedSymbols: IS_BINANCE_EXECUTION ? binanceSymbols.getCanonicalResolution() : {},
  };
}

if (IS_BINANCE_EXECUTION) {
  binanceSymbols.hydrate({
    universe: binanceSymbols.TIER1_CANONICAL.concat(binanceSymbols.TIER2_CANONICAL),
  }).then((result) => {
    if (result.ok) {
      console.log('binance_symbol_hydrate_ok', {
        resolved: Object.keys(result.resolved).length,
        unresolved: result.unresolved,
      });
    } else {
      console.warn('binance_symbol_hydrate_failed', { error: result.error });
    }
  }).catch((err) => {
    console.warn('binance_symbol_hydrate_threw', { error: err?.message || String(err) });
  });
}

module.exports = {
  getActiveSignalVersion,
  getSignalSelectorDecision,
  getRealizedVetoState,
  getExplorationBudgetState,
  getSpreadSuppressionState,
  getMakerFillState,
  getBinanceExecutionStatus,
  getMicroFlowShadowTrackerSnapshot,
  getStaleQuoteRetryTrackerSnapshot,
  getRollingSkipSnapshot,
  getRegimeVetoState,
  resolveAlpacaAuth,
  getAlpacaAuthStatus,
  getAlpacaBaseStatus,
  getLastHttpError,
  getLastQuoteSnapshot,
  logMarketDataUrlSelfCheck,
  getAlpacaConnectivityStatus,
  fetchAccount,
  fetchPortfolioHistory,
  fetchActivities,
  fetchClock,
  fetchPositions,
  fetchPosition,
  fetchAsset,
  fetchOrders,
  fetchOrderById,
  replaceOrder,
  cancelOrder,
  submitOrder,
  isOpenLikeOrderStatus,
  expandNestedOrders,
  normalizeSymbolsParam,
  fetchCryptoQuotes,
  fetchCryptoTrades,
  fetchCryptoOrderbooks,
  computeOrderbookImbalance,
  recordBtcLeadLagSnapshot,
  getBtcLeadLagSnapshot,
  getMarketRegimeSnapshot,
  getConvictionState,
  fetchCryptoBars,
  getMicrostructureShadowSample,
  fetchBarsArray,
  fetchStockQuotes,
  fetchStockTrades,
  fetchStockBars,
  getLatestQuote,
  getLatestPrice,
  loadSupportedCryptoPairs,
  getSupportedCryptoPairsSnapshot,
  filterSupportedCryptoSymbols,
  // engine
  placeMakerLimitBuyThenSell,
  initializeInventoryFromPositions,
  startEntryManager,
  startExitManager,
  scanOrphanPositions,
  runDustCleanup,
  getConcurrencyGuardStatus,
  getExitStateSnapshot,
  getLifecycleSnapshot,
  getSessionGovernorSummary,
  getTradingManagerStatus,
  getEntryDiagnosticsSnapshot,
  getUniverseDiagnosticsSnapshot,
  getPredictorWarmupSnapshot,
  getEngineStateSnapshot,
  getEntryRegimeStaleThresholdMs,
  // exposed for regression tests of the bar-fetch / prediction pipeline
  getPredictionSignal,
  getHigherTimeframeSignal,
  scanAndEnter,
  getStopLossConfig,
  // exposed so the sizing logic can be unit-tested in isolation against
  // both signal-version branches (see trade.signalAwareSizing.test.js).
  deriveSignalTargetNetBps,
  deriveStopLossBps,
};
