# Profitability Analysis — June 2026

Scope: all 274 closed trades (217 with per-symbol attribution) + 60 days of real
Binance.US 1m klines (8 liquid symbols, 86,400 bars each) run through a sandbox.
Goal posed by owner: get the scalper to ~1%/day avg over a week. This document is
the evidence, the diagnosis, and an honest verdict.

## 1. The live numbers (ground truth)

| metric | value |
|---|---|
| closed trades | 274 |
| win rate | 35.0% |
| avg win | +$0.082 |
| avg loss | −$0.153 |
| win/loss size ratio | **0.54** (a win is half a loss) |
| expectancy | **−$0.039/trade** |
| profit factor | 0.43 |
| avg entry spread | **17.6 bps** |
| avg quote age at entry | **5,680 ms** |
| pooled net | **−28.1 bps/trade** |

Breakeven math: at a 0.54 win/loss ratio you need a **65% win rate** to break even.
The bot wins 35%. It is −EV by construction.

Per-symbol: loss magnitude tracks illiquidity. Tight-spread majors (BTC −14, ETH −28,
SOL −11, LINK +8) cluster near zero; wide-spread alts bleed (ONDO −113, SKY −105,
RENDER −92, SUSHI −82, CRV −67, DOT −75). **Even BTC at ~0 bps spread loses −14 bps/trade**
— so spread alone does not explain it; the entry has no edge.

## 2. Three stacked diseases (sandbox-confirmed)

### Disease A — the core signal is the wrong sign
"Buy the dip" mean-reversion at the 1-minute scale loses **−4.7 to −5.5 bps/trade across
every parameterization** (W∈{15,30}, Z∈{1.5,2}, H∈{15,30}), 32–40% win — and it loses
*before* costs. Forward-return predictability of an alt's own price history is ~0
(corr 0.002–0.033). At the 1m scale crypto weakly **continues**, it does not revert.
The bot is betting against the market's actual autocorrelation.

Mean-reversion *does* work — but at the **hourly** scale (buy 12–24h dip z<−2, hold 2h:
+10.5 bps, t=3.1). The bot applies the right idea at the wrong timescale.

### Disease B — execution costs exceed the available edge
The single strongest predictor found is **BTC lead-lag**: BTC's last-3-min return predicts
alt forward returns at **corr 0.13–0.15** (10× the own-price signal). Trading it —
BTC ret3m>30bps ⇒ long alt, hold 5m — yields **+10.5 bps net (fee only), pooled t=15.0,
robust in both 30-day halves for all 7 alts** (per-symbol t 3.9–8.4). Real signal.

But the edge lives in the first 60 seconds and the bot can't reach it:

| entry timing (taker, realistic spread) | net/trade |
|---|---|
| instant fill (delay 0) | +3.0 bps |
| 1 minute late | **−1.7 bps** |
| 2 minutes late | −4.1 bps |

A +10 bps edge minus a 17.6 bps spread-cross = negative. One minute of latency kills
what remains. **A 12s-poll, 5.7s-stale-quote, spread-crossing taker on Render is
structurally too slow and too expensive to scalp.**

### Disease C — the exit asymmetry is backwards
Live avg win ($0.082) < avg loss ($0.153). Sandbox confirms direction matters: momentum
entry with TP=60/SL=20 (let winners run, cut losers) = +3.7 bps; with TP=20/SL=60 it
bleeds. The bot's exits cap winners and let losers run — the opposite of what works.

## 3. The one architecturally-viable path — maker capture

Stop crossing the spread. Post a **limit (maker) at the touch** when the BTC-lead signal
fires; fill only if price revisits (~80% do, within 2 min); hold 5 min; exit maker.

- **+7.6 bps net/trade, t=9.6**, after excluding the 20% of runaway winners you miss.
- Daily sim (single-position pool, compounding, tight-spread alts only):
  **mean 0.59%/day, median 0.28%/day, 72% positive days, +36.7% over 60d.**

Maker entry preserves the edge that taker entry destroys, because the ~0 spread cost is
the difference between +7.6 and −1.7.

## 4. Honest verdict on 1%/day

**1%/day sustained over a week is not reliably achievable** with spot, no leverage, on
this venue. The best viable strategy (maker-captured BTC lead-lag, tight-spread alts)
backtests to ~0.3–0.6%/day mean with high variance — and that already assumes idealized
maker fills with no queue/partial-fill/exit-slippage haircut. Real-world will be lower.

1%/day would require one of: (a) maker-only execution on the 2–3 tightest symbols capturing
lead-lag at sub-minute latency — hard but the only spot path toward it; (b) leverage (not
available on Binance.US spot); or (c) a different, lower-frequency strategy where per-trade
edge >> spread.

## 5. Recommended rebuild (in priority order)

1. **Flip the signal sign / replace MR with BTC lead-lag.** Stop buying 1m dips. Trade
   "BTC just moved, alt hasn't yet." This is the only robust edge in the data.
2. **Become a maker, not a taker.** Post limits at/inside the touch; never cross a 17.6 bps
   spread for a 10 bps edge. This is the single highest-leverage change.
3. **Hard tight-spread universe gate.** Only ETH/SOL/XRP/DOGE/LINK/ADA/AVAX-class names
   (live spread < ~10 bps). Drop CRV/RENDER/ONDO/SUSHI/DOT/etc — they cannot be scalped.
4. **Invert the exit: let winners run, cut losers** (TP > SL), targeting win/loss ratio > 1.5.
5. **React in < 60 seconds.** The lead-lag alpha decays inside a minute; a slow poll wastes it.
6. **Set the bar at ~0.3–0.5%/day**, not 1%. Verify in shadow/paper-shadow before real size.

All of the above are proposals; none have been applied to live config. Live breaker,
realized veto, and entry/exit loops are untouched.

---
Method notes: sandbox at /tmp/sbx (fetch.js, edge.js, beyond.js, robust.js, latency.js,
maker.js, final.js). Costs: 1.9 bps round-trip taker, per-symbol live spreads, 0.2 bps
maker. Robustness via 30/30-day split + per-symbol t-stats. No live orders placed.
