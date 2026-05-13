"""Generate diagrams used in docs/SPEC.pdf.

Outputs are written to docs/spec_images/ as PNGs. Re-run after editing
this script; the PDF generator picks the images up directly from disk.
"""

from __future__ import annotations

import math
import os

import matplotlib.patches as mpatches
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spec_images")
os.makedirs(OUT_DIR, exist_ok=True)


def save(fig, name: str) -> str:
    path = os.path.join(OUT_DIR, name)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# 1. System architecture
# ---------------------------------------------------------------------------
def architecture_diagram() -> None:
    fig, ax = plt.subplots(figsize=(11, 6.5))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 60)
    ax.axis("off")

    def box(x, y, w, h, label, color):
        b = FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle="round,pad=0.4,rounding_size=1.0",
            linewidth=1.2,
            edgecolor="#222",
            facecolor=color,
        )
        ax.add_patch(b)
        ax.text(
            x + w / 2,
            y + h / 2,
            label,
            ha="center",
            va="center",
            fontsize=10,
            wrap=True,
        )

    def arrow(x1, y1, x2, y2, label=None, color="#444"):
        a = FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle="-|>",
            mutation_scale=14,
            color=color,
            linewidth=1.4,
        )
        ax.add_patch(a)
        if label:
            ax.text(
                (x1 + x2) / 2,
                (y1 + y2) / 2 + 1.2,
                label,
                ha="center",
                va="center",
                fontsize=8,
                color=color,
            )

    # External
    box(2, 46, 22, 8, "Alpaca Live API\napi.alpaca.markets", "#fde2e2")
    box(2, 32, 22, 8, "Alpaca Market Data\ndata.alpaca.markets", "#fde2e2")

    # Backend
    box(34, 46, 32, 8, "Express server (backend/index.js)\n/dashboard /health /debug/*", "#e2efff")
    box(34, 32, 32, 8, "Trading loop (backend/trade.js)\nentry scan + exit reconcile", "#e2efff")
    box(34, 18, 32, 8, "Modules: entryProbability,\nentryEconomics, tradeGuards, indicators", "#e2efff")
    box(34, 4, 32, 8, "Config + validation\n(liveDefaults.js, validateEnv.js)", "#e2efff")

    # Clients
    box(76, 46, 22, 8, "Frontend (Expo)\nread-only dashboard", "#e6f7e6")
    box(76, 32, 22, 8, "Render single instance\nNode 22", "#fef6d8")
    box(76, 18, 22, 8, "Scripts\nreconcile, backtest, smoke", "#fef6d8")

    # arrows
    arrow(24, 50, 34, 50, "REST")
    arrow(24, 36, 34, 36, "bars + quotes")
    arrow(66, 50, 76, 50, "GET /dashboard")
    arrow(50, 46, 50, 40, "")
    arrow(50, 32, 50, 26, "")
    arrow(50, 18, 50, 12, "")
    arrow(66, 36, 76, 36, "hosted on")

    ax.set_title("Magic — System Architecture", fontsize=14, pad=14)
    save(fig, "01_architecture.png")


# ---------------------------------------------------------------------------
# 2. Strategy loop sequence
# ---------------------------------------------------------------------------
def strategy_loop_diagram() -> None:
    fig, ax = plt.subplots(figsize=(11, 7))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 80)
    ax.axis("off")

    steps = [
        (
            "1. Scan",
            "Every ENTRY_SCAN_INTERVAL_MS (12s) walk\n"
            "the entry universe (dynamic = every active\n"
            "Alpaca crypto USD pair).",
            "#e2efff",
        ),
        (
            "2. Predict",
            "Fit OLS on last PREDICT_BARS (20) 1m closes.\n"
            "slope t-stat -> logistic CDF -> pUp.\n"
            "Compute projectedBps, volatility, volumeRatio,\n"
            "BTC lead-lag.",
            "#fef6d8",
        ),
        (
            "3. Gate",
            "Pass through spread / HTF / volume / BTC\n"
            "lead-lag / portfolio-drawdown / cost-floor /\n"
            "net-edge / honest-EV gates.",
            "#fde2e2",
        ),
        (
            "4. Buy",
            "Place GTC limit BUY at current ask.\n"
            "Notional = PORTFOLIO_SIZING_PCT * equity.",
            "#e6f7e6",
        ),
        (
            "5. Take-profit",
            "On fill, place a single GTC limit SELL at\n"
            "entry * (1 + (signalNet + fees) / 10000).",
            "#e6f7e6",
        ),
        (
            "6. Staircase exit",
            "Each EXIT_SCAN_INTERVAL_MS decay the GTC\n"
            "sell from signal TP toward break-even-after-\n"
            "fees over BREAKEVEN_TIMEOUT_MS (4h). Never\n"
            "post below break-even => worst-case +$0 net.",
            "#dcdcff",
        ),
    ]

    y = 70
    for i, (title, body, color) in enumerate(steps):
        box = FancyBboxPatch(
            (6, y - 9),
            88,
            9,
            boxstyle="round,pad=0.4,rounding_size=1.2",
            linewidth=1.2,
            edgecolor="#222",
            facecolor=color,
        )
        ax.add_patch(box)
        ax.text(10, y - 2.2, title, fontsize=11, fontweight="bold")
        ax.text(28, y - 5.0, body, fontsize=9, va="center")
        if i < len(steps) - 1:
            a = FancyArrowPatch(
                (50, y - 9),
                (50, y - 11),
                arrowstyle="-|>",
                mutation_scale=12,
                color="#444",
                linewidth=1.2,
            )
            ax.add_patch(a)
        y -= 11.5

    ax.set_title("Strategy loop — the whole bot in 6 steps", fontsize=14, pad=14)
    save(fig, "02_strategy_loop.png")


# ---------------------------------------------------------------------------
# 3. Staircase exit decay
# ---------------------------------------------------------------------------
def staircase_exit_diagram() -> None:
    fig, ax = plt.subplots(figsize=(10, 5.5))

    timeout_ms = 4 * 60 * 60 * 1000
    timeout_min = timeout_ms / 60_000
    entry = 100.0
    fee_bps = 40
    signal_net_bps = 22  # representative
    target = entry * (1 + (signal_net_bps + fee_bps) / 10_000)
    breakeven = entry * (1 + fee_bps / 10_000)

    t = np.linspace(0, timeout_min, 400)
    desired = target - (target - breakeven) * (t / timeout_min)
    desired = np.maximum(desired, breakeven)

    # Show stepped repost behaviour at ~3 bps tolerance.
    tol_bps = 3.0
    step = np.empty_like(desired)
    current = target
    for i, v in enumerate(desired):
        if (current - v) / current * 10_000 >= tol_bps:
            current = v
        step[i] = current

    ax.plot(t, desired, "--", color="#888", label="Desired (continuous)")
    ax.plot(t, step, color="#2b5cff", linewidth=2.0, label="Resting GTC sell limit")
    ax.axhline(breakeven, color="#c00", linestyle=":", label="Break-even-after-fees (floor)")
    ax.axhline(entry, color="#444", linestyle="-.", linewidth=0.8, label="Entry price")
    ax.axhline(target, color="#2a9d2a", linestyle=":", label="Signal-derived TP at fill")

    ax.set_xlabel("Minutes since fill")
    ax.set_ylabel("Sell limit price (entry indexed to $100)")
    ax.set_title(
        "Staircase exit — GTC sell decays toward break-even, never below",
        fontsize=13,
    )
    ax.set_xlim(0, timeout_min * 1.02)
    ax.set_ylim(entry - 0.05, target + 0.08)
    ax.grid(True, alpha=0.3)
    ax.legend(loc="upper right", fontsize=9)
    save(fig, "03_staircase_exit.png")


# ---------------------------------------------------------------------------
# 4. Entry gate funnel
# ---------------------------------------------------------------------------
def entry_gates_funnel() -> None:
    fig, ax = plt.subplots(figsize=(10, 7.5))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")

    gates = [
        ("Universe (dynamic ~30+ active pairs)", "#e2efff"),
        ("Quote freshness (<= 60s) + spread (<= 30 bps)", "#e2efff"),
        ("HTF slope >= 1 bps/bar (5m x 12)", "#fef6d8"),
        ("OLS projectedBps >= 15", "#fef6d8"),
        ("Cost floor (gross >= spread + slip + fees + edge)", "#fde2e2"),
        ("Net-edge EV gate (>= 2 bps)", "#fde2e2"),
        ("Honest-EV gate (stuck loss = 250 bps)", "#fde2e2"),
        ("Volume ratio >= 1.0", "#dcdcff"),
        ("BTC lead-lag >= -10 bps (5 bars)", "#dcdcff"),
        ("Portfolio drawdown >= -2.0%", "#dcdcff"),
        ("Sizing >= 0.6 x target notional", "#dcdcff"),
        ("=> Place GTC limit BUY at ask", "#e6f7e6"),
    ]
    # Uniform-width bars stepped in slightly each row to suggest a funnel without
    # forcing labels into shrinking widths.
    full_width = 80
    n = len(gates)
    y = 95
    for i, (label, color) in enumerate(gates):
        shrink = i * 1.6  # 0..~17 across rows
        width = full_width - shrink
        left = 50 - width / 2
        box = FancyBboxPatch(
            (left, y - 4),
            width,
            4.8,
            boxstyle="round,pad=0.2,rounding_size=0.6",
            linewidth=1.0,
            edgecolor="#333",
            facecolor=color,
        )
        ax.add_patch(box)
        ax.text(50, y - 1.7, label, ha="center", va="center", fontsize=9)
        if i < n - 1:
            a = FancyArrowPatch(
                (50, y - 4),
                (50, y - 6.4),
                arrowstyle="-|>",
                mutation_scale=8,
                color="#666",
                linewidth=0.8,
            )
            ax.add_patch(a)
        y -= 7.5

    ax.set_title("Entry gate funnel (default config)", fontsize=14, pad=14)
    save(fig, "04_entry_gates_funnel.png")


# ---------------------------------------------------------------------------
# 5. Expectancy regimes table (as bar chart)
# ---------------------------------------------------------------------------
def expectancy_chart() -> None:
    regimes = ["benign\n(+0.5 drift)", "flat\n(0)", "adverse\n(-0.5 drift)", "quiet\n(sigma=6)", "wild\n(sigma=25)"]
    expectancy = [1.0, -49, -1382, -51, -55]
    tp_fill = [5.5, 4.2, 3.4, 0.0, 28.5]
    stuck = [0.0, 3.7, 33.7, 7.1, 2.4]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))

    colors = ["#2a9d2a" if v >= 0 else "#c0392b" for v in expectancy]
    # Symlog to keep all bars readable.
    ax1.bar(regimes, expectancy, color=colors, edgecolor="#222")
    ax1.set_yscale("symlog", linthresh=10)
    ax1.set_ylabel("Expectancy (bps/trade, symlog)")
    ax1.set_title("Simulator expectancy across regimes")
    ax1.axhline(0, color="#444", linewidth=0.8)
    ax1.grid(True, axis="y", alpha=0.3)
    for i, v in enumerate(expectancy):
        ax1.text(i, v, f"{v:+.0f}", ha="center", va="bottom" if v >= 0 else "top", fontsize=9)

    x = np.arange(len(regimes))
    w = 0.38
    ax2.bar(x - w / 2, tp_fill, w, label="TP fill rate %", color="#2b5cff")
    ax2.bar(x + w / 2, stuck, w, label="Stuck rate %", color="#c0392b")
    ax2.set_xticks(x, regimes)
    ax2.set_ylabel("Percent of trials")
    ax2.set_title("Fill vs stuck rate per regime")
    ax2.legend()
    ax2.grid(True, axis="y", alpha=0.3)

    fig.suptitle(
        "Monte Carlo expectancy (backend/scripts/simulate_strategy.js, 20k trials/regime)",
        fontsize=12,
    )
    fig.tight_layout()
    save(fig, "05_expectancy.png")


# ---------------------------------------------------------------------------
# 6. Math illustration: OLS slope + barrier-hitting probability
# ---------------------------------------------------------------------------
def math_diagram() -> None:
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))

    rng = np.random.default_rng(7)
    bars = 20
    x = np.arange(bars)
    drift = 0.0008
    noise = rng.normal(0, 0.0015, bars)
    log_returns = drift + noise
    price = 100 * np.exp(np.cumsum(log_returns))

    coeffs = np.polyfit(x, np.log(price), 1)
    fit_line = np.exp(np.polyval(coeffs, x))

    ax1.plot(x, price, "o-", color="#2b5cff", label="1m close")
    ax1.plot(x, fit_line, color="#c0392b", label="OLS slope -> projected drift")
    ax1.set_title("Entry signal: OLS on log-closes\nslope t-stat -> logistic CDF -> pUp")
    ax1.set_xlabel("Bar (1m)")
    ax1.set_ylabel("Price")
    ax1.legend()
    ax1.grid(True, alpha=0.3)

    horizon = 240
    t = np.linspace(1, horizon, 200)
    sigma_per_min_bps = 12.0
    mu_per_min_bps_set = [-0.5, 0.0, 0.5, 1.5]
    target_bps = 22  # signal-derived net target (illustrative)
    for mu in mu_per_min_bps_set:
        mu_per_min = mu / 10_000.0
        sigma_per_min = sigma_per_min_bps / 10_000.0
        b = math.log(1 + target_bps / 10_000.0)
        # First-passage prob for arithmetic Brownian with positive barrier b > 0.
        prob = []
        for tt in t:
            sd = sigma_per_min * math.sqrt(tt)
            if sd <= 0:
                prob.append(0.0)
                continue
            # Closed-form barrier-hitting probability (Bachelier-style upper barrier).
            from math import erfc
            term1 = 0.5 * erfc((b - mu_per_min * tt) / (sd * math.sqrt(2)))
            term2 = math.exp(2 * mu_per_min * b / (sigma_per_min ** 2)) * 0.5 * erfc(
                (b + mu_per_min * tt) / (sd * math.sqrt(2))
            )
            prob.append(min(1.0, max(0.0, term1 + term2)))
        ax2.plot(t, prob, label=f"mu = {mu:+.1f} bps/min")

    ax2.set_xlabel("Horizon (minutes)")
    ax2.set_ylabel("P[hit TP barrier]")
    ax2.set_title(
        f"Forward fill probability (GBM barrier)\nbarrier = +{target_bps} bps, sigma = {sigma_per_min_bps:.0f} bps/min"
    )
    ax2.legend()
    ax2.grid(True, alpha=0.3)

    fig.tight_layout()
    save(fig, "06_math.png")


# ---------------------------------------------------------------------------
# 7. Repo layout
# ---------------------------------------------------------------------------
def repo_layout() -> None:
    fig, ax = plt.subplots(figsize=(10, 6.5))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")

    rows = [
        ("backend/", "Node 22 Express engine — REST + trading loop", "#e2efff"),
        ("backend/trade.js", "Main scan/predict/gate/buy/exit loop (~2.7k LOC)", "#e2efff"),
        ("backend/index.js", "Express server, routes, dashboard meta", "#e2efff"),
        ("backend/modules/", "Math + helpers (entryProbability, tradeGuards, ...)", "#e2efff"),
        ("backend/config/", "Live defaults, runtime config, env validation", "#e2efff"),
        ("backend/scripts/", "reconcile, backtest, runtime-env check, smoke", "#fef6d8"),
        ("Frontend/", "Expo read-only dashboard polling /dashboard", "#e6f7e6"),
        ("shared/", "symbol normalization + quote utils shared by both", "#fde2e2"),
        ("scripts/", "Repo tooling (git-hook installer)", "#fde2e2"),
        (".git-hooks/", "Pre-commit secret scanner", "#dcdcff"),
        (".github/workflows/", "CI: lint + tests + env check, frontend smoke", "#dcdcff"),
        ("docs/", "This spec doc + generator + images", "#dcdcff"),
    ]
    y = 95
    for path, desc, color in rows:
        box = FancyBboxPatch(
            (6, y - 6),
            88,
            6.5,
            boxstyle="round,pad=0.2,rounding_size=0.6",
            linewidth=1.0,
            edgecolor="#333",
            facecolor=color,
        )
        ax.add_patch(box)
        ax.text(10, y - 2.6, path, fontsize=10, fontweight="bold", va="center")
        ax.text(40, y - 2.6, desc, fontsize=9, va="center")
        y -= 7.7

    ax.set_title("Repo layout", fontsize=14, pad=14)
    save(fig, "07_repo_layout.png")


def main() -> None:
    architecture_diagram()
    strategy_loop_diagram()
    staircase_exit_diagram()
    entry_gates_funnel()
    expectancy_chart()
    math_diagram()
    repo_layout()
    print(f"Wrote 7 images to {OUT_DIR}")


if __name__ == "__main__":
    main()
