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
const { evaluateRangeMeanReversionSignal } = require('./modules/rangeMeanReversionSignal');
const { evaluateBarrierSignal } = require('./modules/barrierSignal');
const { evaluateMicrostructureSignal } = require('./modules/microstructureSignal');
const { evaluateRecentHighGate } = require('./modules/recentHighGate');
const tradeForensics = require('./modules/tradeForensics');
const { buildFeatureSnapshot } = require('./modules/featureLibrary');
const closedTradeStats = require('./modules/closedTradeStats');
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
// Cancel-the-buy-if-not-filled timeout (Fix 1). The mid/bid_plus_tick modes
// require active management — if the market runs away, we don't want a stale
// passive buy filling minutes later at a no-longer-edge price. Default 30 s.
// Set to 0 to disable (passive buy rests until the staircase exit logic
// detects it on a held position — not recommended outside backtest parity).
const ENTRY_FILL_TIMEOUT_MS = Math.max(0, readNumber('ENTRY_FILL_TIMEOUT_MS', 30000));
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
// Round-trip Alpaca crypto fees, in basis points. Default lowered from 40 →
// 30 to match the maker-maker fill path that the live engine actually uses:
// ENTRY_LIMIT_PRICE_MODE='mid' rests our buy as a maker bid; the GTC sell
// limit rests as a maker ask. Maker fees on Alpaca crypto are ~10-15 bps per
// side at the lowest tier (~$84 account → lowest tier), so round-trip ≈ 20-30.
// 30 is the conservative end of that range. The May 2026 mean-reversion
// backtest's gross expectancy was +15.83 bps (loose) and +54.91 bps (strict)
// — both blocked from net positive at 40 fee bps, both clear with 30. The
// 40-bps assumption assumed taker entry (BUY crosses to ask), which hasn't
// matched live execution since the May-14 mid-mode flip. This is a model
// correctness fix; doesn't change the win path math, just removes a 10-bps
// over-charge that was suppressing valid trades.
const FEE_BPS_ROUND_TRIP = Math.max(0, readNumber('FEE_BPS_ROUND_TRIP', 30));
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

// Feature library (2026-05-18) — observational-only logging into the entry
// forensics record. None of these flags gate entries; they only control
// whether the corresponding family of features is computed and written.
const FEATURE_LIBRARY_LOGGING_ENABLED = readBoolean('FEATURE_LIBRARY_LOGGING_ENABLED', true);
const FEATURE_INDICATORS_EXTENDED_ENABLED = readBoolean('FEATURE_INDICATORS_EXTENDED_ENABLED', true);
const FEATURE_STATS_ENABLED = readBoolean('FEATURE_STATS_ENABLED', true);
const FEATURE_STRUCTURE_ENABLED = readBoolean('FEATURE_STRUCTURE_ENABLED', true);

// Per-timeframe MR symbol blocklists (2026-05-18). Filtered live; the
// auto-backtest in index.js passes the same blocklists so the selector
// expectancy reflects what the live engine actually trades. Defaults set
// by the live-defaults bootstrap; rationale in liveDefaults.js.
const symbolBlocklist = require('./modules/symbolBlocklist');
const MR_BLOCKLISTS = symbolBlocklist.readMrBlocklistsFromEnv(process.env);

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
// Default raised to 60 bps so the hard guardrail no longer blocks otherwise
// valid candidates in normal-but-noisy live books; the tighter economics and
// microstructure gates still run afterwards (entry-max, EV, alpha, etc.).
const SPREAD_MAX_BPS = Math.max(1, readNumber('SPREAD_MAX_BPS', 60));
// Tier-aware spread caps: BTC/ETH stay tight, mid-caps a bit looser, long-tail
// alts get the room their thinner books need. Each is clamped to the global
// SPREAD_MAX_BPS at resolution so the flat cap remains an authoritative ceiling.
const SPREAD_MAX_BPS_TIER1 = Math.max(1, readNumber('SPREAD_MAX_BPS_TIER1', 30));
const SPREAD_MAX_BPS_TIER2 = Math.max(1, readNumber('SPREAD_MAX_BPS_TIER2', 45));
const SPREAD_MAX_BPS_TIER3 = Math.max(1, readNumber('SPREAD_MAX_BPS_TIER3', 90));
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
  'ols', 'multi_factor', 'mean_reversion', 'barrier',
  'microstructure_5m', 'microstructure_15m', 'microstructure_30m', 'microstructure_45m',
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
  const decision = signalSelector.getCurrentDecision();
  return decision.signalVersion || SIGNAL_VERSION_OPERATOR_OVERRIDE || 'ols';
}
function getSignalSelectorDecision() {
  return signalSelector.getCurrentDecision();
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

async function fetchAccount() {
  return alpacaRequest({ base: 'trade', path: '/v2/account', label: 'account' });
}

async function fetchPortfolioHistory(query = {}) {
  return alpacaRequest({ base: 'trade', path: '/v2/account/portfolio/history', query, label: 'portfolio_history' });
}

async function fetchActivities(query = {}) {
  const items = await alpacaRequest({ base: 'trade', path: '/v2/account/activities', query, label: 'activities' });
  return { items: Array.isArray(items) ? items : [], nextPageToken: null };
}

async function fetchClock() {
  return alpacaRequest({ base: 'trade', path: '/v2/clock', label: 'clock' });
}

// --- positions / assets --------------------------------------------------

async function fetchPositions() {
  const list = await alpacaRequest({ base: 'trade', path: '/v2/positions', label: 'positions' });
  return Array.isArray(list) ? list : [];
}

async function fetchPosition(symbol) {
  const apiSym = toAlpacaSymbol(symbol) || symbol;
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/positions/${encodeURIComponent(apiSym)}`, label: 'position' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function fetchAsset(symbol) {
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
  const q = { ...query };
  if (q.nested === true) q.nested = 'true';
  if (q.nested === false) delete q.nested;
  const list = await alpacaRequest({ base: 'trade', path: '/v2/orders', query: q, label: 'orders' });
  return Array.isArray(list) ? list : [];
}

async function fetchOrderById(id) {
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, label: 'order_by_id' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function replaceOrder(id, body) {
  return alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, method: 'PATCH', body: body || {}, label: 'replace_order' });
}

async function cancelOrder(id) {
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
    const btcLeadLag = pair === BTC_LEAD_LAG_SYMBOL ? null : getBtcLeadLagSnapshot();
    const sig = evaluateMeanReversionSignal({ pair, bars1m, btcLeadLag, timeframe, config: MR_SIGNAL_CONFIG_OVERRIDES });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'mean_reversion_signal_failed', error: err?.message };
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
    const sig = evaluateBarrierSignal({
      pair,
      bars1m,
      orderbook,
      quote: quote ? { bid: Number(quote.bp), ask: Number(quote.ap) } : null,
    });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m, orderbook };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'barrier_signal_failed', error: err?.message };
  }
}

// Microstructure signal wrapper. The signal needs 60 1m bars (RSI(14) +
// 60-bar spread/sigma windows) plus the live quote (for spread + microprice)
// and (optionally) the orderbook for the bookImbalance term. Pattern matches
// the barrier wrapper — orderbook fetch is non-fatal, signal degrades to
// neutral when missing. recentTrades stays null until Phase 2 wires a
// /v1beta3/crypto/us/latest/trades consumer; the signal's tradesEnabled
// config flag is gated by MICRO_TRADES_ENABLED env and silently returns
// flowImbalance=0 in Phase 1 so the contribution is zero.
async function getMicrostructureSignalForPair(pair, quote, horizonMinutes) {
  try {
    const [bars1mPayload, obPayload] = await Promise.all([
      fetchCryptoBars({ symbols: [pair], limit: 80, timeframe: '1Min' }),
      fetchCryptoOrderbooks({ symbols: [pair] }).catch((err) => {
        console.warn('orderbook_fetch_failed', { symbol: pair, error: err?.message });
        return { orderbooks: {} };
      }),
    ]);
    const bars1m = bars1mPayload?.bars?.[pair] || bars1mPayload?.bars?.[toAlpacaSymbol(pair)] || [];
    const orderbook = obPayload?.orderbooks?.[pair] || obPayload?.orderbooks?.[toAlpacaSymbol(pair)] || null;
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
      recentTrades: null,
      horizonMinutes,
      config: {
        spreadZMax: MICRO_SPREAD_Z_MAX,
        minProb: MICRO_MIN_PROB,
        evMinBps: MICRO_EV_MIN_BPS,
        feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
        tradesEnabled: MICRO_TRADES_ENABLED,
      },
    });
    if (sig && typeof sig === 'object') sig.featureBars = { bars1m, orderbook };
    return sig;
  } catch (err) {
    return { ok: false, reason: 'microstructure_signal_failed', error: err?.message };
  }
}

// --- engine state -------------------------------------------------------

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

function rejectTrade(pair, reason, details = {}) {
  bumpSkipReason(reason);
  rollingSkipByReasonAndSymbol.push({ ts: Date.now(), symbol: pair || 'unknown', reason: reason || 'unknown' });
  while (rollingSkipByReasonAndSymbol.length > 0 && (Date.now() - rollingSkipByReasonAndSymbol[0].ts) > REJECTION_WINDOW_MS) {
    rollingSkipByReasonAndSymbol.shift();
  }
  console.log('entry_rejected', { symbol: pair, reason, ...details });
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

async function buildHeldAndOpenSellsIndex() {
  const positions = await fetchPositions();
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
  const openOrders = await fetchOrders({ status: 'open', nested: true, limit: 500 });
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

async function scanAndEnter() {
  if (!TRADING_ENABLED) return;
  currentScanState = 'scanning';
  currentScanStartedAt = new Date().toISOString();
  currentScanLastProgressAt = currentScanStartedAt;
  currentScanSymbolsProcessed = 0;
  skipReasonCounts.clear();

  // Signal selector veto: if no signal has cleared the backtest activation
  // threshold (default +3 bps avgNetBpsPerEntry over the last 30-day auto-
  // backtest), refuse the scan entirely. This is the safety net that stops
  // the bot from bleeding when the strategy doesn't have edge — exactly the
  // failure mode the live -65 bps OLS backtest exposed. Operator can opt
  // out via SIGNAL_SELECTOR_VETO_ENABLED=false (legacy "trade anyway").
  const selectorDecision = getSignalSelectorDecision();
  if (selectorDecision.tradingVeto) {
    console.log('entry_scan_skipped_backtest_veto', {
      reason: selectorDecision.reason,
      operatorOverride: selectorDecision.operatorOverride,
      olsNetBps: selectorDecision.olsNetBps,
      mfNetBps: selectorDecision.mfNetBps,
      decisionAt: selectorDecision.decisionAt,
      backtestRanAt: selectorDecision.backtestRanAt,
      minBpsToActivate: selectorDecision.config?.minBpsToActivate,
    });
    bumpSkipReason('backtest_veto_active');
    currentScanState = 'idle';
    currentScanStartedAt = null;
    return;
  }
  // Pin the active signal version for this scan so every per-symbol gate +
  // forensic field reads the same value (avoids race with a backtest that
  // completes mid-scan and flips the selector).
  const ACTIVE_SIGNAL_VERSION = selectorDecision.signalVersion || getActiveSignalVersion();

  await loadSupportedCryptoPairs();
  // Universe selection:
  //   - dynamic  → every active Alpaca crypto pair (USD-quoted, ex-stablecoins)
  //               returned by /v2/assets.
  //   - configured → only ENTRY_SYMBOLS_PRIMARY (intersected with the tradable
  //                  set, so dead symbols can't sneak in).
  // Per-symbol gates inside the loop (spread, quote freshness, predicted edge,
  // etc.) still decide whether to actually trade.
  const allTradable = supportedPairsSnapshot.pairs || [];
  let universe;
  if (runtimeConfig.entryUniverseModeEffective === 'configured') {
    const primary = runtimeConfig.configuredPrimarySymbols || [];
    if (allTradable.length > 0) {
      const allowed = new Set(allTradable);
      universe = primary.filter((s) => allowed.has(s));
    } else {
      // /v2/assets has never returned successfully (cold-boot Alpaca outage).
      // The configured primary list is hardcoded and known-good, so trust it
      // rather than starving every scan with an empty universe.
      universe = primary.slice();
      bumpSkipReason('supported_pairs_unavailable_used_configured_primary');
    }
  } else {
    universe = allTradable.slice();
  }
  currentScanUniverseSize = universe.length;

  let held, openBuyPairs, aggregateUnrealizedPct;
  try {
    const idx = await buildHeldAndOpenSellsIndex();
    held = idx.held;
    openBuyPairs = idx.openBuyPairs;
    aggregateUnrealizedPct = idx.aggregateUnrealizedPct;
  } catch (err) {
    lastExecutionFailure = { at: new Date().toISOString(), reason: 'positions_or_orders_fetch_failed', message: err?.errorMessage || err?.message || String(err) };
    currentScanState = 'idle';
    return;
  }

  // One concurrent position per symbol. Phase 1 adds a soft cap on total
  // concurrent positions: prevents fragmenting cash across more positions
  // than the sizing math can comfortably fund. When the cap is hit, the
  // scan still runs (so dashboard stats stay accurate), but candidates
  // beyond the remaining-slot budget are skipped with reason
  // 'concurrent_position_cap'. Disabled when CONCURRENT_POSITIONS_SOFT_CAP_ENABLED=false
  // or PHASE1_ENABLED=false; reverts to legacy "cash-only bounded" behavior.
  const heldCount = held.size;
  const remainingSlots = CONCURRENT_POSITIONS_SOFT_CAP_ENABLED
    ? Math.max(0, MAX_CONCURRENT_POSITIONS_SOFT_CAP - heldCount)
    : Infinity;
  const candidates = universe.filter((pair) => !held.has(pair) && !openBuyPairs.has(pair));
  const summary = {
    ts: new Date().toISOString(),
    universeSize: universe.length,
    heldCount: held.size,
    slotsAvailable: candidates.length,
    evaluated: 0,
    entered: 0,
    topSkipReasons: {},
    acceptedSymbols: [],
  };

  // Portfolio-drawdown entry gate. The per-symbol gates have no portfolio
  // context — they can each individually pass during a broad market top.
  // When the live book's aggregate unrealized P&L % is below threshold,
  // pause new entries until existing positions recover. Negative threshold
  // only; 0 disables. Defensive: when there are no held positions, the
  // aggregate is null and the gate is skipped.
  if (
    MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER < 0 &&
    Number.isFinite(aggregateUnrealizedPct) &&
    aggregateUnrealizedPct < MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER
  ) {
    bumpSkipReason('portfolio_drawdown_below_min');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }

  // Size this scan's trades as PORTFOLIO_SIZING_PCT of current equity, then
  // clamp to available cash so the last slot can still fill when cash has
  // drifted just under the 10% target (e.g. held positions appreciated).
  let availableCash = Infinity;
  let targetNotional = null;
  try {
    const account = await fetchAccount();
    const cashRaw = account?.cash ?? account?.buying_power ?? account?.non_marginable_buying_power;
    const cashNum = Number(cashRaw);
    if (Number.isFinite(cashNum)) availableCash = cashNum;
    const equityRaw = account?.equity ?? account?.portfolio_value;
    const equityNum = Number(equityRaw);
    if (Number.isFinite(equityNum) && equityNum > 0) {
      targetNotional = equityNum * PORTFOLIO_SIZING_PCT;
    }
  } catch (err) {
    // Soft-fail: if the account fetch fails, fall through and let submitOrder surface any real error.
  }
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) {
    bumpSkipReason('sizing_unavailable');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }
  const tradeNotional = Math.min(
    targetNotional,
    Number.isFinite(availableCash) ? availableCash : targetNotional,
  );
  if (tradeNotional < MIN_TRADE_NOTIONAL_USD) {
    bumpSkipReason('insufficient_cash');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }
  // Sizing-floor gate: if the cash clamp shrunk us below MIN_SIZING_FRACTION_OF_TARGET
  // of intended size, abort the scan rather than deploy a fragmented entry.
  // Live data showed an AVAX entry at $1.78 (19% of a $9.23 target) producing the
  // book's worst per-position drawdown; better to wait for cash to free up
  // properly than to take an undersized signal that just locks the slot.
  if (
    MIN_SIZING_FRACTION_OF_TARGET > 0 &&
    tradeNotional < targetNotional * MIN_SIZING_FRACTION_OF_TARGET
  ) {
    bumpSkipReason('sizing_below_floor');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }

  // Batched quote warm-up. Replaces 33 serial single-symbol /latest/quotes
  // calls with one multi-symbol call per chunk of ENTRY_PREFETCH_CHUNK_SIZE
  // (default 8). The per-symbol loop below reads from this Map first and
  // only falls back to a single-symbol fetch when the prefetch is disabled
  // or the chunk that owned this pair failed. Set ENTRY_PREFETCH_QUOTES=false
  // to revert to legacy per-symbol fetches.
  const prefetchedQuotes = runtimeConfig.entryPrefetchQuotes
    ? await prefetchQuotesForCandidates(candidates, runtimeConfig.entryPrefetchChunkSize)
    : null;

  let placed = 0;
  for (const pair of candidates) {
    summary.evaluated += 1;
    currentScanSymbolsProcessed += 1;
    currentScanLastProgressAt = new Date().toISOString();
    // Phase 1: concurrent-position soft cap. Once we've placed enough buys
    // this scan to reach the soft cap, skip remaining candidates with a
    // diagnostic skip reason so the dashboard can show the cap is biting.
    // The held-position count is the cross-scan baseline; placed counts the
    // in-progress entries from this scan.
    if (CONCURRENT_POSITIONS_SOFT_CAP_ENABLED && (heldCount + placed) >= MAX_CONCURRENT_POSITIONS_SOFT_CAP) {
      rejectTrade(pair, 'concurrent_position_cap', { heldCount, placed, cap: MAX_CONCURRENT_POSITIONS_SOFT_CAP });
      continue;
    }
    try {
      let payload;
      const prefetched = prefetchedQuotes ? prefetchedQuotes.get(pair) : null;
      if (prefetched) {
        payload = { quotes: { [pair]: prefetched } };
      } else {
        payload = await fetchCryptoQuotes({ symbols: [pair] });
      }
      const quote = payload?.quotes?.[pair] || payload?.quotes?.[toAlpacaSymbol(pair)] || null;
      if (!quote) { rejectTrade(pair, 'no_quote'); continue; }
      const quoteTsMs = quoteTimestampMs(quote) || 0;
      if (quoteTsMs > 0) lastQuoteUpdateBySymbol.set(pair, quoteTsMs);
      const nowMs = Date.now();
      const ageMs = nowMs - quoteTsMs;
      quoteFreshness.record(pair, ageMs);
      const quoteFingerprint = `${Number(quote.bp)}:${Number(quote.ap)}:${quoteTsMs}`;
      const previousFingerprint = lastQuoteFingerprintBySymbol.get(pair) || null;
      const quoteLooksNew = previousFingerprint !== quoteFingerprint;
      lastQuoteFingerprintBySymbol.set(pair, quoteFingerprint);
      if (ageMs > QUOTE_MAX_AGE_MS && quoteLooksNew) {
        // Some venues occasionally publish delayed quote timestamps despite
        // updating bid/ask. If the quote moved since the previous scan, avoid
        // classifying it as stale solely due to provider timestamp lag.
      } else if (!Number.isFinite(ageMs) || ageMs > (QUOTE_MAX_AGE_MS + QUOTE_STALE_GRACE_MS)) { rejectTrade(pair, 'stale_quote', { ageMs }); continue; }
      if (STALE_QUOTE_PRUNE_ENABLED && quoteFreshness.isPruned(pair)) { rejectTrade(pair, 'pruned_stale_quotes', { ageMs }); continue; }

      const spreadBps = computeSpreadBps(quote);
      if (spreadBps == null) { rejectTrade(pair, 'invalid_quote'); continue; }
      const spreadCapBps = resolveSpreadCapBps(pair) + (SPREAD_CANARY_SYMBOLS.has(pair) ? SPREAD_CANARY_EXTRA_BPS : 0);
      const spreadToleranceBps = SPREAD_TOLERANCE_BPS + SPREAD_COMPARISON_EPSILON_BPS;
      if (spreadBps > (spreadCapBps + spreadToleranceBps)) { rejectTrade(pair, 'spread_too_wide', { spreadBps, spreadCapBps, spreadToleranceBps }); continue; }

      const ask = Number(quote.ap);
      const bid = Number(quote.bp);
      if (!Number.isFinite(ask) || ask <= 0) { rejectTrade(pair, 'invalid_ask'); continue; }
      if (!Number.isFinite(bid) || bid <= 0) { rejectTrade(pair, 'invalid_bid'); continue; }
      const spreadCostBps = ((ask - bid) / ((ask + bid) / 2)) * 10000;

      let sig;
      if (ACTIVE_SIGNAL_VERSION === 'multi_factor') {
        sig = await getMultiFactorSignalForPair(pair, quote);
      } else if (ACTIVE_SIGNAL_VERSION === 'mean_reversion') {
        sig = await getMeanReversionSignalForPair(pair, '1m');
      } else if (ACTIVE_SIGNAL_VERSION === 'mean_reversion_5m') {
        sig = await getMeanReversionSignalForPair(pair, '5m');
      } else if (ACTIVE_SIGNAL_VERSION === 'mean_reversion_15m') {
        sig = await getMeanReversionSignalForPair(pair, '15m');
      } else if (ACTIVE_SIGNAL_VERSION === 'range_mean_reversion') {
        sig = await getRangeMeanReversionSignalForPair(pair);
      } else if (ACTIVE_SIGNAL_VERSION === 'barrier') {
        sig = await getBarrierSignalForPair(pair, quote);
      } else if (ACTIVE_SIGNAL_VERSION === 'microstructure_5m') {
        sig = await getMicrostructureSignalForPair(pair, quote, 5);
      } else if (ACTIVE_SIGNAL_VERSION === 'microstructure_15m') {
        sig = await getMicrostructureSignalForPair(pair, quote, 15);
      } else if (ACTIVE_SIGNAL_VERSION === 'microstructure_30m') {
        sig = await getMicrostructureSignalForPair(pair, quote, 30);
      } else if (ACTIVE_SIGNAL_VERSION === 'microstructure_45m') {
        sig = await getMicrostructureSignalForPair(pair, quote, 45);
      } else {
        sig = await getPredictionSignal(pair);
      }
      if (pair === BTC_LEAD_LAG_SYMBOL) recordBtcLeadLagSnapshot(sig);
      if (!sig.ok) {
        rejectTrade(pair, sig.reason || 'prediction_rejected');
        continue;
      }

      // Recent-high proximity gate. Reject when the bid is within
      // REJECT_NEAR_HIGH_BPS of the highest close in the last
      // REJECT_NEAR_HIGH_LOOKBACK_BARS minutes. Buying at local tops is the
      // dominant source of stuck positions; this gate uses already-fetched
      // closes (no extra Alpaca call).
      // near_recent_high: refuse entries within REJECT_NEAR_HIGH_BPS of the
      // highest close in the last REJECT_NEAR_HIGH_LOOKBACK_BARS bars.
      //
      // 2026-05-18 narrowed to non-continuation signals: this gate was
      // designed for OLS ("don't buy the very top"). It is appropriate for
      // OLS, multi_factor, and the MR family (where it's effectively dormant
      // because mr_no_drop fires first). It is INAPPROPRIATE for the barrier
      // and microstructure signals — those signals can legitimately want to
      // buy near-recent-high setups (barrier-touch continuations,
      // microprice-driven breakouts). The gate is bypassed for
      // signalVersion ∈ {barrier, microstructure_5m/15m/30m/45m}.
      //
      // Live impact today: zero — barrier and microstructure are both
      // backtest-negative and the selector hasn't admitted either. The bypass
      // matters the moment one of them validates and the selector starts
      // routing live entries to it.
      const recentHighSignalApplies = ![
        'barrier',
        'microstructure_5m', 'microstructure_15m',
        'microstructure_30m', 'microstructure_45m',
      ].includes(ACTIVE_SIGNAL_VERSION);
      const recentHighGateResult = recentHighSignalApplies
        ? evaluateRecentHighGate({
            closes: sig.closes,
            bid,
            lookbackBars: REJECT_NEAR_HIGH_LOOKBACK_BARS,
            rejectBps: REJECT_NEAR_HIGH_BPS,
            enabled: REJECT_NEAR_HIGH_ENABLED,
          })
        : { ok: true, recentHigh: null, recentHighBps: null, signalBypass: true };
      if (!recentHighGateResult.ok && recentHighGateResult.reason === 'near_recent_high') {
        rejectTrade(pair, 'near_recent_high', {
          recentHigh: recentHighGateResult.recentHigh,
          recentHighBps: recentHighGateResult.recentHighBps,
          lookbackBars: REJECT_NEAR_HIGH_LOOKBACK_BARS,
          rejectBps: REJECT_NEAR_HIGH_BPS,
        });
        continue;
      }

      // Optional orderbook imbalance fetch. Only fires when the env flag is
      // on so the default deployment makes zero extra API calls. Stored as
      // a separate variable rather than mutating `sig` so the predictor
      // stays a pure function.
      let bookImbalance = null;
      if (ORDERBOOK_IMBALANCE_FEATURE_ENABLED) {
        try {
          const obPayload = await fetchCryptoOrderbooks({ symbols: [pair] });
          const book = obPayload?.orderbooks?.[pair] || obPayload?.orderbooks?.[toAlpacaSymbol(pair)] || null;
          bookImbalance = computeOrderbookImbalance(book, ORDERBOOK_IMBALANCE_LEVELS);
        } catch (err) {
          // Non-fatal — feature is observational. Log but don't reject.
          console.warn('orderbook_fetch_failed', { symbol: pair, error: err?.message });
        }
      }
      const needed = requiredEdgeBps(spreadBps, sig.volatilityBps);

      const entryGate = shouldEnterTrade({
        spreadBps,
        slippageEstimateBps: ENTRY_SLIPPAGE_BPS,
        volatilityBps: sig.volatilityBps,
        ask,
        bid,
        closes: sig.closes || [],
      });
      if (!entryGate.ok) {
        rejectTrade(pair, entryGate.reason, { spreadBps, volatilityBps: sig.volatilityBps });
        continue;
      }

      // Higher-timeframe confirmation: don't buy a 1m bounce inside a 5m
      // downtrend.
      //
      // 2026-05-18 note: HTF is structurally contradictory with the MR family
      // (mean_reversion, mean_reversion_5m/15m, range_mean_reversion). MR's
      // thesis is "buy a capitulation drop" — which by definition implies the
      // higher-timeframe is below its EMA. If the HTF gate ever ran for MR
      // candidates, it would refuse ~100% of valid setups.
      //
      // Why this isn't a live bug today: MR's signal-internal mr_no_drop
      // gate (in meanReversionSignal.js) rejects ~99% of bars BEFORE the
      // signal evaluator returns ok. The rare candidate that survives mr_no_drop
      // also tends to have a high enough HTF slope to clear this check. So
      // HTF only fires on the tail of MR candidates where ordering happens
      // to save us.
      //
      // DO NOT re-order this block to run BEFORE the signal evaluator. DO NOT
      // loosen mr_no_drop without first making HTF signal-aware. The two
      // gates compose only by accident; the accident is what keeps MR alive.
      const htf = await getHigherTimeframeSignal(pair);
      if (!htf.ok) {
        rejectTrade(pair, htf.reason || 'htf_rejected');
        continue;
      }

      // Probability-weighted expected net edge.
      //
      // Two probability proxies live side-by-side here so the change is
      // reversible: the legacy `slopeProbabilityLegacy` is the logistic CDF
      // of the OLS slope t-statistic — a measure of how significant the past
      // slope was, not the forward chance the TP fills. The corrected
      // `fillProbability` uses the closed-form GBM barrier-hitting formula
      // (see entryEconomics.js) with the recent slope as drift and the
      // recent realised vol as σ over BARRIER_HORIZON_BARS. That value
      // actually answers the question the EV gate is trying to ask.
      //
      // CORRECTED_FILL_PROB_ENABLED selects which one feeds the gate.
      // Default: corrected. Both are logged for parity tracking.
      const projectedBps = Number.isFinite(sig.projectedBps) ? sig.projectedBps : 0;
      const expectedMoveBps = Math.min(projectedBps, GROSS_TARGET_BPS);
      const driftBpsPerBar = Number.isFinite(sig.slopeBpsPerBar) ? sig.slopeBpsPerBar : 0;
      const volBpsPerBar = Number.isFinite(sig.volatilityBps) ? sig.volatilityBps : null;
      const slopeProbabilityLegacy = slopeProbability(sig.slopeTStat);
      // Barrier the bid must hit for the TP to fill, expressed as bps from
      // mid_t0: half-spread + entry slippage budget + gross-target + half
      // spread on the way out (the SELL needs the bid to reach the limit).
      const tpBarrierBpsFromMid = (spreadCostBps / 2) + ENTRY_SLIPPAGE_BPS + GROSS_TARGET_BPS + (spreadCostBps / 2);
      const barrierFillProbability = barrierHitProbability({
        barrierBps: tpBarrierBpsFromMid,
        driftBpsPerBar,
        volBpsPerBar,
        horizonBars: BARRIER_HORIZON_BARS,
      });
      const fillProbability = CORRECTED_FILL_PROB_ENABLED ? barrierFillProbability : slopeProbabilityLegacy;
      const realizedWinBps = Math.max(0, TARGET_NET_PROFIT_BPS - ENTRY_SLIPPAGE_BPS);
      const netEdgeBps = realizedWinBps * fillProbability;
      const modeledSlippageBps = ENTRY_SLIPPAGE_BPS;

      // Cost-floor gate: refuse trades whose static GTC target cannot
      // economically beat the round-trip friction. This is a deterministic
      // accounting check — no probabilistic assumption — and answers the
      // user-mandated "the system rejects trades that cannot beat costs".
      const minGrossFloor = computeMinimumGrossTargetBps({
        spreadBps: spreadCostBps,
        entrySlippageBps: ENTRY_SLIPPAGE_BPS,
        exitSlippageBps: EXIT_SLIPPAGE_BPS,
        feeRoundTripBps: FEE_BPS_ROUND_TRIP,
        minNetEdgeBps: MIN_NET_EDGE_BPS,
      });
      if (ENFORCE_GROSS_TARGET_FLOOR && GROSS_TARGET_BPS < minGrossFloor.minGrossTargetBps) {
        rejectTrade(pair, 'gross_target_below_friction_floor', { minGrossTargetBps: minGrossFloor.minGrossTargetBps });
        continue;
      }

      // Legacy alpha-cost gate was frequently the dominant blocker in live
      // scans even when directional/EV gates were already passing. Keep a
      // hard block for non-positive projection, but otherwise let the
      // probability-weighted net-edge gate decide viability.
      if (!Number.isFinite(projectedBps) || projectedBps <= 0) {
        rejectTrade(pair, 'alpha_below_execution_cost', {
          projectedBps,
          requiredBps: spreadCostBps + modeledSlippageBps,
          spreadCostBps,
          modeledSlippageBps,
        });
        continue;
      }

      // Directional sanity check. With the legacy proxy a small-magnitude
      // negative t-stat produced fillProbability ≈ 0.45 and the EV product
      // still cleared MIN_NET_EDGE_BPS — i.e. the gate would submit a long
      // even when the OLS fit predicted a downward move. Block long entries
      // when the 1m model predicts down (or flat). Skipped for multi_factor
      // signal: directional intent is already validated by the htfTrend +
      // turnConfirm factors, and the multi_factor signal returns
      // slopeTStat = 0 by design.
      if (ACTIVE_SIGNAL_VERSION === 'ols' && (!Number.isFinite(sig.slopeTStat) || sig.slopeTStat <= 0)) {
        rejectTrade(pair, 'slope_not_positive');
        continue;
      }

      // Projection-magnitude floor (OLS-only, 2026-05-18 narrowing). After
      // lowering TARGET_NET_PROFIT_BPS to 8 in PR #362, the EV gate
      // (MIN_NET_EDGE_BPS=2) lets through entries with sub-3 bps projected
      // moves — essentially noise. Live: BCH was accepted with
      // projectedBps=2.6 and honestEvBps=-54. The 15-bps floor (~3× modelled
      // slippage, roughly half a fee round-trip) blocks those.
      //
      // 2026-05-18 narrowed to OLS-only: `projectedBps` is OLS-flavoured
      // (linear-regression forward projection over PREDICT_BARS). For
      // multi_factor, barrier, and microstructure_*, projectedBps is repurposed
      // to mean the signal's own per-trade TP target (ATR-derived,
      // barrier-touch-derived, or horizon-fixed). Comparing those against a
      // 15-bps "forward move" floor would refuse setups where the signal
      // wants a 100+ bps net TP (barrier) or a horizon-bounded TP (micro).
      // Other OLS-only gates (slope_not_positive, projected_below_gross_target,
      // net_edge_below_min, honest_ev_below_min) already use the same
      // signal-version dispatch — this brings projected_below_min in line.
      if (ACTIVE_SIGNAL_VERSION === 'ols' && projectedBps < MIN_PROJECTED_BPS_TO_ENTER) {
        rejectTrade(pair, 'projected_below_min', {
          projectedBps,
          minProjectedBps: MIN_PROJECTED_BPS_TO_ENTER,
        });
        continue;
      }

      // Fix 2: refuse trades whose own projection can't cover the gross move
      // needed to fill the TP. Live forensics showed projectedBps≈38 with a
      // GROSS_TARGET_BPS=48 + entry/exit slippage required: we were asking
      // for ~54 bps of move when the model itself only predicted ~38.
      // Skipped for multi_factor: that signal's projectedBps is a per-trade
      // ATR-derived TP target, not a forward-move prediction. Comparing it
      // against the global GROSS_TARGET_BPS double-counts the cost floor.
      // ENFORCE_GROSS_TARGET_FLOOR above already enforces the global cost
      // floor as a deterministic accounting check that applies to both signals.
      if (ACTIVE_SIGNAL_VERSION === 'ols' && ENFORCE_PROJECTED_COVERS_GROSS) {
        const requiredGrossBps = GROSS_TARGET_BPS + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS;
        if (projectedBps < requiredGrossBps) {
          rejectTrade(pair, 'projected_below_gross_target', {
            projectedBps,
            requiredGrossBps,
            grossTargetBps: GROSS_TARGET_BPS,
            entrySlippageBps: ENTRY_SLIPPAGE_BPS,
            exitSlippageBps: EXIT_SLIPPAGE_BPS,
          });
          continue;
        }
      }

      // Volume confirmation gate (top-detection candidate). Tops typically
      // print on declining volume — `volumeRatio < 1` means recent-window
      // volume is fading vs the OLS lookback. When this gate is enabled,
      // refuse entries that pass slope/projection but lack volume backing.
      // Default OFF (threshold = 0). See README for math.
      if (MIN_VOLUME_RATIO_TO_ENTER > 0) {
        const ratio = Number(sig.volumeRatio);
        if (Number.isFinite(ratio) && ratio < MIN_VOLUME_RATIO_TO_ENTER) {
          rejectTrade(pair, 'volume_below_min', {
            volumeRatio: ratio,
            minVolumeRatio: MIN_VOLUME_RATIO_TO_ENTER,
          });
          continue;
        }
      }

      // BTC lead-lag gate (top-detection candidate). Alts lag BTC by 30–90s
      // in crypto, so a fresh BTC drop is a leading indicator that alt
      // momentum is about to reverse. When this gate is enabled, refuse
      // non-BTC entries if BTC's last-5-bar return is more negative than
      // the threshold. Default OFF (threshold = 0 means any positive value
      // disables the gate; only negative thresholds enable it).
      if (MAX_BTC_LEAD_LAG_DROP_BPS < 0 && pair !== BTC_LEAD_LAG_SYMBOL) {
        const snap = getBtcLeadLagSnapshot();
        const recent = Number(snap?.recentReturnBps);
        if (Number.isFinite(recent) && recent < MAX_BTC_LEAD_LAG_DROP_BPS) {
          rejectTrade(pair, 'btc_leading_drop', {
            btcRecentReturnBps: recent,
            btcLeadLagAgeMs: snap?.ageMs ?? null,
            maxBtcLeadLagDropBps: MAX_BTC_LEAD_LAG_DROP_BPS,
          });
          continue;
        }
      }

      // Net-edge gate uses fillProbability × realizedWinBps, which is meaningful
      // for the OLS signal (logistic CDF of a fitted slope) but not for the
      // multi_factor signal (probability is replaced by a discrete factor vote).
      // Skipped for multi_factor; the factor vote IS the net-edge proxy.
      if (ACTIVE_SIGNAL_VERSION === 'ols' && NET_EDGE_GATE_ENABLED) {
        if (!Number.isFinite(netEdgeBps) || netEdgeBps < MIN_NET_EDGE_BPS) {
          rejectTrade(pair, 'net_edge_below_min', { netEdgeBps, minNetEdgeBps: MIN_NET_EDGE_BPS });
          continue;
        }
      }

      // Honest EV gate: charges the no-fill branch a non-zero MTM loss so
      // the asymmetric "no stop-loss + GTC TP only" structure is priced
      // honestly. Off by default — the assumption is regime-dependent —
      // but available so operators can flip it on with a stuck-loss they
      // believe in. See backend/scripts/simulate_strategy.js for guidance.
      const honestEvBps = estimateExpectedNetBps({
        hitProbability: fillProbability,
        targetNetBps: TARGET_NET_PROFIT_BPS,
        assumedStuckLossBps: STUCK_LOSS_ASSUMED_BPS,
      });
      // Same reasoning as the net-edge gate: hitProbability comes from the GBM
      // barrier model parameterised by the OLS-fit drift, so it doesn't apply
      // when the active signal is multi_factor. The factor vote already handled
      // expectancy filtering.
      if (ACTIVE_SIGNAL_VERSION === 'ols' && HONEST_EV_GATE_ENABLED && honestEvBps < MIN_NET_EDGE_BPS) {
        rejectTrade(pair, 'honest_ev_below_min', { honestEvBps, minNetEdgeBps: MIN_NET_EDGE_BPS });
        continue;
      }

      // Notional sizing: PORTFOLIO_SIZING_PCT of equity, clamped to available
      // cash. Phase 1 adds adaptive sizing: a high-confidence trigger
      // (sig.confidence > 1) scales notional UP toward MAX_SIZING_FRACTION_OF_TARGET
      // × base; a low-confidence trigger scales DOWN toward
      // MIN_SIZING_FRACTION_OF_TARGET × base. The base is still the
      // cash-clamped tradeNotional. When ADAPTIVE_SIZING_ENABLED=false
      // (or PHASE1_ENABLED=false), all trades use the static base.
      let sizingMultiplier = 1.0;
      if (ADAPTIVE_SIZING_ENABLED) {
        const conf = Number(sig?.confidence);
        if (Number.isFinite(conf) && conf > 0) {
          // Confidence is reported by the signal as a multiplier hint
          // around 1.0 (range mean reversion uses [0.5, 1.5], MR returns
          // exactly 1, others may not return it). Clamp to the operator-
          // configured bounds.
          sizingMultiplier = Math.max(
            MIN_SIZING_FRACTION_OF_TARGET,
            Math.min(MAX_SIZING_FRACTION_OF_TARGET, conf),
          );
        }
      }
      // Don't let adaptive sizing exceed available cash; the cash clamp wins.
      const adaptiveTarget = tradeNotional * sizingMultiplier;
      const effectiveNotional = Math.min(
        adaptiveTarget,
        Number.isFinite(availableCash) ? availableCash : adaptiveTarget,
      );

      // Round buy limit to the asset's price_increment so Alpaca accepts it.
      // Fix 1: rest the buy below the ask. 'mid' = (ask+bid)/2 (saves ~half
      // the spread on entry); 'bid_plus_tick' = bid + one tick (most passive,
      // pays no spread but fills less often); 'ask' = lift the offer (legacy).
      const tickInfo = await getAssetTickInfo(pair);
      let buyPriceRaw;
      if (ENTRY_LIMIT_PRICE_MODE === 'ask') buyPriceRaw = ask;
      else if (ENTRY_LIMIT_PRICE_MODE === 'bid_plus_tick') buyPriceRaw = bid + (Number(tickInfo.priceIncrement) || 0);
      else buyPriceRaw = (ask + bid) / 2;
      if (!Number.isFinite(buyPriceRaw) || buyPriceRaw <= 0) buyPriceRaw = ask;
      const buyLimitStr = formatTickPrice(buyPriceRaw, tickInfo.priceIncrement);
      if (!buyLimitStr) { rejectTrade(pair, 'invalid_ask'); continue; }
      const buyLimitNum = Number(buyLimitStr);
      // Bps saved vs. lifting the ask. Logged on the prediction record so the
      // expectancy diff can be measured per trade after the fact.
      const buyLimitOffsetBpsFromAsk = Number.isFinite(buyLimitNum) && ask > 0
        ? ((ask - buyLimitNum) / ask) * 10000
        : 0;

      const buyRes = await submitOrder({
        symbol: pair,
        side: 'buy',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: buyLimitStr,
        notional: effectiveNotional.toFixed(2),
      });
      const buyOrder = buyRes?.buy || buyRes;
      if (buyOrder?.id) {
        const submittedAt = Date.now();
        const nowIso = new Date().toISOString();
        // Per-trade exit target: when SIGNAL_SIZED_EXIT_ENABLED, this trade's
        // GTC sell sits at entry × (1 + signalDerivedGrossBps/10000) instead
        // of the global GROSS_TARGET_BPS. Floor = static target (so weak
        // signals behave exactly like today), cap = SIGNAL_TARGET_MAX_NET_BPS.
        const signalDerivedNetBps = deriveSignalTargetNetBps(projectedBps, sig.signalVersion || ACTIVE_SIGNAL_VERSION);
        const signalDerivedGrossBps = signalDerivedNetBps + FEE_BPS_ROUND_TRIP;
        const volBpsForStop = Number.isFinite(sig.volatilityBps) ? sig.volatilityBps : null;
        const volScaledStopLossBps = deriveStopLossBps(volBpsForStop, spreadBps, sig.signalVersion || ACTIVE_SIGNAL_VERSION, pair);
        const prediction = {
          buyOrderId: buyOrder.id,
          buyLimit: Number(buyLimitStr),
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
          projectedBps,            // uncapped projection (#5)
          expectedMoveBps,         // capped at GROSS_TARGET_BPS (what the edge gate used)
          fillProbability,
          fillProbabilityLegacy: slopeProbabilityLegacy,
          fillProbabilitySource: CORRECTED_FILL_PROB_ENABLED ? 'barrier_hit' : 'slope_logistic_cdf',
          barrierHorizonBars: BARRIER_HORIZON_BARS,
          tpBarrierBpsFromMid,
          netEdgeBps,
          honestEvBps,
          stuckLossAssumedBps: STUCK_LOSS_ASSUMED_BPS,
          minGrossTargetFloorBps: minGrossFloor.minGrossTargetBps,
          feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
          entrySlippageBps: ENTRY_SLIPPAGE_BPS,
          exitSlippageBps: EXIT_SLIPPAGE_BPS,
          grossTargetBps: signalDerivedGrossBps,        // per-trade gross target used by exit
          targetNetProfitBps: signalDerivedNetBps,       // per-trade net target used by exit
          staticGrossTargetBps: GROSS_TARGET_BPS,        // global default, for parity tracking
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
          htfSlopeBpsPerBar: Number.isFinite(htf?.slopeBpsPerBar) ? htf.slopeBpsPerBar : null,
          volumeRatio: Number.isFinite(sig.volumeRatio) ? sig.volumeRatio : null,
          volumeWeightedSlopeBps: Number.isFinite(sig.volumeWeightedSlopeBps) ? sig.volumeWeightedSlopeBps : null,
          recentVolumeMean: Number.isFinite(sig.recentVolumeMean) ? sig.recentVolumeMean : null,
          btcLeadLag: pair === BTC_LEAD_LAG_SYMBOL ? null : getBtcLeadLagSnapshot(),
          recentHigh: recentHighGateResult.recentHigh,
          recentHighBps: recentHighGateResult.recentHighBps,
          recentHighLookbackBars: REJECT_NEAR_HIGH_LOOKBACK_BARS,
          recentHighRejectBps: REJECT_NEAR_HIGH_BPS,
          bookImbalance,
          bookImbalanceFeatureEnabled: ORDERBOOK_IMBALANCE_FEATURE_ENABLED,
          signalVersion: sig.signalVersion || ACTIVE_SIGNAL_VERSION,
          multiFactor: sig.factors
            ? {
                confidence: sig.confidence,
                atrBps: sig.atrBps,
                htfTrend: sig.factors.htfTrend?.ok,
                pullback: sig.factors.pullback?.ok,
                turnConfirm: sig.factors.turnConfirm?.ok,
                bookImbalanceOk: sig.factors.bookImbalance?.ok,
                volumeOk: sig.factors.volume?.ok,
                btcLagOk: sig.factors.btcLag?.ok,
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
        // Feature library snapshot (2026-05-18). Observational-only — runs
        // ONLY at the entry-accepted boundary (already inside try) so live
        // entry latency is unaffected. Do not move this call earlier into
        // scanAndEnter; per-candidate computation would bloat labeled.jsonl
        // 30:1 and gain nothing until rejected-candidate calibration is in
        // scope (separate, future PR).
        let featureSnapshot = null;
        if (FEATURE_LIBRARY_LOGGING_ENABLED) {
          try {
            featureSnapshot = buildFeatureSnapshot({
              bars1m: sig?.featureBars?.bars1m || null,
              closes: Array.isArray(sig?.closes) ? sig.closes : null,
              quote: { bid, ask },
              orderbook: sig?.featureBars?.orderbook || null,
              candidatePrice: ask,
              enable: {
                indicators: FEATURE_INDICATORS_EXTENDED_ENABLED,
                stats: FEATURE_STATS_ENABLED,
                structure: FEATURE_STRUCTURE_ENABLED,
              },
            });
          } catch (err) {
            console.warn('feature_snapshot_failed', { symbol: pair, error: err?.message });
          }
        }
        try {
          tradeForensics.append({
            tradeId: buyOrder.id,
            symbol: pair,
            phase: 'entry_submitted',
            ts: nowIso,
            ...prediction,
            featureSnapshot,
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
          multiFactor: prediction.multiFactor,
          buyLimit: prediction.buyLimit,
          notional: effectiveNotional,
          spreadBps,
          slopeTStat: prediction.slopeTStat,
          fillProbability,
          fillProbabilityLegacy: slopeProbabilityLegacy,
          fillProbabilitySource: prediction.fillProbabilitySource,
          tpBarrierBpsFromMid,
          barrierHorizonBars: BARRIER_HORIZON_BARS,
          projectedBps,
          expectedMoveBps,
          netEdgeBps,
          honestEvBps,
          minGrossTargetFloorBps: minGrossFloor.minGrossTargetBps,
          signalDerivedNetBps,
          signalDerivedGrossBps,
          signalSizedExitEnabled: SIGNAL_SIZED_EXIT_ENABLED,
          stopLossBpsResolved: volScaledStopLossBps,
          volScaledStopEnabled: VOL_SCALED_STOP_ENABLED,
          volatilityBps: prediction.volatilityBps,
          htfSlopeBpsPerBar: prediction.htfSlopeBpsPerBar,
          volumeRatio: prediction.volumeRatio,
          volumeWeightedSlopeBps: prediction.volumeWeightedSlopeBps,
          btcRecentReturnBps: prediction.btcLeadLag?.recentReturnBps ?? null,
          btcLeadLagAgeMs: prediction.btcLeadLag?.ageMs ?? null,
          bookImbalance: prediction.bookImbalance,
        });
        summary.entered += 1;
        summary.acceptedSymbols.push(pair);
        lastSuccessfulAction = { at: nowIso, symbol: pair, action: 'buy_submitted', orderId: buyOrder.id };
        placed += 1;
      } else {
        rejectTrade(pair, 'buy_rejected');
      }
    } catch (err) {
      lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'buy_failed', message: err?.errorMessage || err?.message || String(err) };
      rejectTrade(pair, 'buy_error', { message: err?.message || String(err) });
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
      pendingBuys.delete(pair);
      tradePredictions.delete(pair);
      entryIntentState.delete(pair);
    }
  }

  for (const [pair, pos] of byPair.entries()) {
    const qty = Number(pos?.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const avg = Number(pos?.avg_entry_price);

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

module.exports = {
  getActiveSignalVersion,
  getSignalSelectorDecision,
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
  fetchCryptoBars,
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
