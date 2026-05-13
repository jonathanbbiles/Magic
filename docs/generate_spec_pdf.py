"""Build docs/SPEC.pdf from docs/spec_images/ and inline narrative.

Re-run after editing the script:
    python3 docs/generate_spec_pdf.py

Source of truth for trading behaviour is README.md at the repo root; this
script paraphrases and reorganises that content into a printable spec.
"""

from __future__ import annotations

import os
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(HERE, "spec_images")
OUT_PATH = os.path.join(HERE, "SPEC.pdf")


def img(name: str, width: float = 6.6 * inch):
    path = os.path.join(IMG_DIR, name)
    image = Image(path)
    iw, ih = image.imageWidth, image.imageHeight
    scale = width / iw
    image.drawWidth = width
    image.drawHeight = ih * scale
    image.hAlign = "CENTER"
    return image


def build_styles():
    base = getSampleStyleSheet()
    styles = {
        "Title": ParagraphStyle(
            "TitleX",
            parent=base["Title"],
            fontSize=28,
            leading=34,
            spaceAfter=10,
            alignment=TA_CENTER,
        ),
        "Subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Heading2"],
            fontSize=14,
            leading=18,
            textColor=colors.HexColor("#555"),
            alignment=TA_CENTER,
            spaceAfter=18,
        ),
        "H1": ParagraphStyle(
            "H1x",
            parent=base["Heading1"],
            fontSize=18,
            leading=22,
            spaceBefore=12,
            spaceAfter=8,
            textColor=colors.HexColor("#1a1a1a"),
        ),
        "H2": ParagraphStyle(
            "H2x",
            parent=base["Heading2"],
            fontSize=13,
            leading=17,
            spaceBefore=10,
            spaceAfter=6,
            textColor=colors.HexColor("#1a1a1a"),
        ),
        "H3": ParagraphStyle(
            "H3x",
            parent=base["Heading3"],
            fontSize=11,
            leading=14,
            spaceBefore=6,
            spaceAfter=4,
            textColor=colors.HexColor("#333"),
        ),
        "Body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontSize=9.5,
            leading=13,
            spaceAfter=6,
            alignment=TA_LEFT,
        ),
        "Bullet": ParagraphStyle(
            "Bullet",
            parent=base["BodyText"],
            fontSize=9.5,
            leading=13,
            leftIndent=14,
            bulletIndent=4,
            spaceAfter=2,
        ),
        "Mono": ParagraphStyle(
            "Mono",
            parent=base["Code"],
            fontSize=8.5,
            leading=11,
            backColor=colors.HexColor("#f4f4f4"),
            borderPadding=4,
            spaceAfter=8,
        ),
        "Caption": ParagraphStyle(
            "Caption",
            parent=base["BodyText"],
            fontSize=8.5,
            leading=10,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#555"),
            spaceAfter=12,
        ),
        "Warning": ParagraphStyle(
            "Warning",
            parent=base["BodyText"],
            fontSize=10,
            leading=13,
            backColor=colors.HexColor("#fff4e0"),
            borderColor=colors.HexColor("#d4a017"),
            borderWidth=1,
            borderPadding=6,
            spaceAfter=10,
        ),
    }
    return styles


def bullet(text: str, styles) -> Paragraph:
    return Paragraph(f"&bull;&nbsp;&nbsp;{text}", styles["Bullet"])


def section_table(rows, col_widths, header=True):
    style = TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a1a") if header else colors.white),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white if header else colors.black),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold" if header else "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("LEADING", (0, 0), (-1, -1), 11),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#888")),
            ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#bbb")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f7f7")]),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]
    )
    t = Table(rows, colWidths=col_widths, repeatRows=1 if header else 0)
    t.setStyle(style)
    return t


def page_decorator(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#888"))
    canvas.drawString(0.75 * inch, 0.5 * inch, "Magic - Alpaca Crypto Trading Bot - Specification")
    canvas.drawRightString(LETTER[0] - 0.75 * inch, 0.5 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build_doc():
    styles = build_styles()

    doc = SimpleDocTemplate(
        OUT_PATH,
        pagesize=LETTER,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title="Magic - Trading Bot Specification",
        author="Magic repo",
    )

    flow = []

    # Cover
    flow += [
        Spacer(1, 1.6 * inch),
        Paragraph("Magic", styles["Title"]),
        Paragraph("Alpaca Crypto Trading Bot &mdash; Technical Specification", styles["Subtitle"]),
        Spacer(1, 0.2 * inch),
        img("01_architecture.png", width=6.5 * inch),
        Spacer(1, 0.4 * inch),
        Paragraph(
            f"Generated {date.today().isoformat()} - source of truth: README.md at repo root",
            styles["Caption"],
        ),
        Paragraph(
            "<b>WARNING: This is a live trading system. Real money is at risk every time it runs.</b> "
            "Treat this document as a specification of intended behaviour; the canonical reference is "
            "<font face=\"Courier\">README.md</font> in the repository root.",
            styles["Warning"],
        ),
        PageBreak(),
    ]

    # 1. Overview
    flow += [
        Paragraph("1. Overview", styles["H1"]),
        Paragraph(
            "Magic is an automated cryptocurrency trading bot built on Alpaca's "
            "<b>live</b> trading API. Every few seconds it scans a configured set of "
            "USD-quoted crypto pairs, opens a small long position when recent price "
            "action looks favourable, and immediately parks a take-profit limit on fill. "
            "It runs unattended on a single Render instance.",
            styles["Body"],
        ),
        Paragraph("1.1 Goals", styles["H2"]),
        bullet("Detect tiny upward drifts in liquid crypto pairs (sub-minute OLS regression).", styles),
        bullet(
            "Capture a small <b>net</b> profit per trade after fees (default <b>8 bps</b> floor, "
            "per-trade target sized from the signal's projected move, clamped to [8, 50] bps).",
            styles,
        ),
        bullet(
            "<b>Never realise a loss by default</b>. The GTC sell limit is walked down toward "
            "break-even-after-fees over <font face=\"Courier\">BREAKEVEN_TIMEOUT_MS</font> (4h) "
            "and pinned there - worst-case realised P&amp;L per trade is $0 net.",
            styles,
        ),
        bullet(
            "Concurrency is bounded by available cash, not a fixed slot count "
            "(<font face=\"Courier\">PORTFOLIO_SIZING_PCT</font> of equity per trade).",
            styles,
        ),
        bullet("Single Render instance; per-process in-memory rate limiting; 24/7 operation.", styles),
        Paragraph("1.2 Non-goals (intentional)", styles["H2"]),
        bullet("No leverage, no averaging down, no pyramiding.", styles),
        bullet(
            "No trailing stop. Even when <font face=\"Courier\">STOP_LOSS_ENABLED=true</font>, "
            "the stop is static at fill time.",
            styles,
        ),
        bullet(
            "No realised loss while <font face=\"Courier\">STOP_LOSS_ENABLED=false</font> "
            "(the default). The staircase exit floors realised P&amp;L at $0 net.",
            styles,
        ),
        bullet("No Kelly sizing, kill-switch file watcher, TWAP execution, or cross-symbol correlation guard.", styles),
        bullet(
            "Older doc fragments mention these features; treat any env var not listed in this "
            "spec or in README.md as not wired until confirmed by <font face=\"Courier\">grep</font>.",
            styles,
        ),
    ]

    # 2. System architecture
    flow += [
        PageBreak(),
        Paragraph("2. System architecture", styles["H1"]),
        img("01_architecture.png"),
        Paragraph(
            "Figure 1. Backend talks to Alpaca's live REST API for orders and to the market-data API for "
            "bars and quotes. The Expo frontend polls the backend's read-only dashboard endpoint. "
            "Operational scripts live alongside the backend.",
            styles["Caption"],
        ),
        Paragraph("2.1 Repo layout", styles["H2"]),
        img("07_repo_layout.png"),
        Paragraph("Figure 2. Top-level directories and their roles.", styles["Caption"]),
    ]

    # 3. Strategy
    flow += [
        PageBreak(),
        Paragraph("3. Strategy", styles["H1"]),
        Paragraph(
            "The full strategy is six steps. Everything else in the codebase is plumbing, "
            "telemetry, and safety rails around these.",
            styles["Body"],
        ),
        img("02_strategy_loop.png"),
        Paragraph("Figure 3. End-to-end strategy loop.", styles["Caption"]),
        Paragraph("3.1 Entry math", styles["H2"]),
        Paragraph(
            "Entry signal lives in <font face=\"Courier\">backend/modules/entryProbability.js</font>: "
            "fit OLS on the last <font face=\"Courier\">PREDICT_BARS</font> (20) one-minute closes, "
            "convert the slope's t-statistic to an upward probability via the logistic CDF.",
            styles["Body"],
        ),
        Paragraph(
            "Forward fill probability lives in <font face=\"Courier\">backend/modules/entryEconomics.js</font>: "
            "closed-form GBM barrier-hitting probability that the bid reaches the take-profit price within "
            "<font face=\"Courier\">BARRIER_HORIZON_BARS</font> (defaults to "
            "<font face=\"Courier\">BREAKEVEN_TIMEOUT_MS</font> in minutes). Drift mu comes from the OLS slope, "
            "sigma from recent realised 1m volatility. This replaced the older "
            "<font face=\"Courier\">logistic_cdf(slopeTStat)</font> proxy in 2026; set "
            "<font face=\"Courier\">CORRECTED_FILL_PROB_ENABLED=false</font> to roll back.",
            styles["Body"],
        ),
        img("06_math.png"),
        Paragraph(
            "Figure 4. Left: per-symbol OLS regression on recent 1m closes. Right: forward "
            "barrier-hitting probability as a function of horizon and drift, at "
            "sigma = 12 bps/min, barrier = +22 bps.",
            styles["Caption"],
        ),
    ]

    # 4. Entry gates
    flow += [
        PageBreak(),
        Paragraph("4. Entry gates", styles["H1"]),
        Paragraph(
            "A candidate must clear every gate in this funnel before a GTC limit BUY is placed. "
            "Most are wired in <font face=\"Courier\">backend/modules/tradeGuards.js</font>; the "
            "macro portfolio-drawdown gate lives in <font face=\"Courier\">backend/trade.js</font> "
            "alongside the scan loop.",
            styles["Body"],
        ),
        img("04_entry_gates_funnel.png"),
        Paragraph(
            "Figure 5. Entry gate funnel under default configuration. Width is illustrative "
            "(not measured) - it conveys progressively tighter filtering, not surviving fractions.",
            styles["Caption"],
        ),
        Paragraph("4.1 Gate reference", styles["H2"]),
        section_table(
            [
                ["Gate", "Default", "Skip reason"],
                ["Quote freshness", "<= 60 s", "quote_stale"],
                ["Spread", "<= 30 bps", "spread_too_wide"],
                ["HTF slope (5m x 12)", ">= 1 bps/bar", "htf_slope_too_low"],
                ["Projected forward move", ">= 15 bps", "projected_below_min"],
                ["Cost floor", "gross >= friction sum", "gross_target_below_friction_floor"],
                ["Net-edge EV", ">= 2 bps", "net_edge_below_min"],
                ["Honest-EV (stuck=250 bps)", ">= MIN_NET_EDGE_BPS", "honest_ev_below_min"],
                ["Volume ratio", ">= 1.0", "volume_below_min"],
                ["BTC lead-lag (5 bars)", ">= -10 bps", "btc_leading_drop"],
                ["Portfolio drawdown %", ">= -2.0%", "portfolio_drawdown_below_min"],
                ["Sizing fraction", ">= 0.6 of target", "sizing_below_floor"],
                ["Volatility", "<= 100 bps", "volatility_too_high"],
            ],
            col_widths=[2.6 * inch, 1.7 * inch, 2.4 * inch],
        ),
    ]

    # 5. Exit
    flow += [
        PageBreak(),
        Paragraph("5. Exit behaviour", styles["H1"]),
        Paragraph(
            "On buy fill the engine places <b>one</b> GTC limit SELL at "
            "<font face=\"Courier\">entry x (1 + (signalNet + fees) / 10000)</font>, where "
            "<font face=\"Courier\">signalNet = clamp(SIGNAL_TARGET_FRACTION x projectedBps - fees, "
            "TARGET_NET_PROFIT_BPS, SIGNAL_TARGET_MAX_NET_BPS)</font>. Confident signals get bigger "
            "targets; marginal signals fall back to the 8 bps floor.",
            styles["Body"],
        ),
        Paragraph("5.1 Staircase exit (no realised losses)", styles["H2"]),
        Paragraph(
            "Each <font face=\"Courier\">EXIT_SCAN_INTERVAL_MS</font> reconcile cycle, the engine "
            "computes a desired GTC sell limit that decays linearly from the signal-derived TP at fill "
            "time toward break-even-after-fees (<font face=\"Courier\">entry x (1 + "
            "FEE_BPS_ROUND_TRIP/10000)</font>) over <font face=\"Courier\">BREAKEVEN_TIMEOUT_MS</font> "
            "(4h by default). When the desired price drops at least "
            "<font face=\"Courier\">STAIRCASE_REPOST_TOLERANCE_BPS</font> (3) below the resting limit, "
            "the engine cancels and reposts at the lower price. The floor is the break-even-after-fees "
            "price - the bot <b>never</b> reposts below it, so every fill yields >= $0 net.",
            styles["Body"],
        ),
        img("03_staircase_exit.png"),
        Paragraph(
            "Figure 6. The resting GTC sell limit decays toward break-even-after-fees over 4 hours. "
            "Steps reflect the ~3-bps repost tolerance that prevents cancel/repost churn on tiny "
            "age increments. The break-even floor is hard.",
            styles["Caption"],
        ),
        Paragraph("5.2 Stop-loss (opt-in)", styles["H2"]),
        Paragraph(
            "<font face=\"Courier\">STOP_LOSS_ENABLED=false</font> is the default. When flipped on, "
            "the exit manager monitors the live bid and force-exits with a market IOC sell if the "
            "stop is breached - i.e. the bot will realise a loss. With "
            "<font face=\"Courier\">VOL_SCALED_STOP_ENABLED=true</font>, per-trade stop distance is "
            "sized from entry-time volatility: <font face=\"Courier\">stopBps ~ STOP_LOSS_VOL_K * "
            "sigma * sqrt(STOP_LOSS_HORIZON_BARS)</font>, clamped to "
            "<font face=\"Courier\">[STOP_LOSS_BPS_FLOOR, STOP_LOSS_BPS]</font>.",
            styles["Body"],
        ),
        Paragraph(
            "Restart resilience: the staircase age anchor uses the older of (broker GTC sell "
            "<font face=\"Courier\">created_at</font>, in-memory "
            "<font face=\"Courier\">positionFirstSeenAt</font>) - positions opened well before a "
            "deploy resume their decay instead of resetting to t=0.",
            styles["Body"],
        ),
    ]

    # 6. Top-detection features
    flow += [
        PageBreak(),
        Paragraph("6. Top-detection features", styles["H1"]),
        Paragraph(
            "Four features are computed every scan and dropped into the "
            "<font face=\"Courier\">entry_submitted</font> log and dashboard "
            "<font face=\"Courier\">forensics</font> payload.",
            styles["Body"],
        ),
        section_table(
            [
                ["Field", "Wired as gate?", "Meaning"],
                [
                    Paragraph("volumeRatio", styles["Body"]),
                    Paragraph("Yes &mdash; MIN_VOLUME_RATIO_TO_ENTER", styles["Body"]),
                    Paragraph(
                        "mean(last-25%-window 1m volume) / mean(all PREDICT_BARS 1m volume). "
                        "&gt;1 = volume rising in the recent window; &lt;1 = fading. Tops typically "
                        "print on declining volume.",
                        styles["Body"],
                    ),
                ],
                [
                    Paragraph("volumeWeightedSlopeBps", styles["Body"]),
                    Paragraph("No &mdash; forensics only", styles["Body"]),
                    Paragraph(
                        "Same OLS slope but each bar weighted by its volume. Disagreement with the "
                        "unweighted slope means the trend is being pushed by low-volume noise.",
                        styles["Body"],
                    ),
                ],
                [
                    Paragraph(
                        "btcLeadLag.{recentReturnBps, slopeBpsPerBar, ageMs}",
                        styles["Body"],
                    ),
                    Paragraph("Yes &mdash; MAX_BTC_LEAD_LAG_DROP_BPS", styles["Body"]),
                    Paragraph(
                        "BTC's last-5-bar return attached to every non-BTC entry. Alts lag BTC by "
                        "30&ndash;90s; a fresh BTC drop is a leading indicator that alt momentum is "
                        "about to reverse.",
                        styles["Body"],
                    ),
                ],
                [
                    Paragraph("bookImbalance", styles["Body"]),
                    Paragraph(
                        "No &mdash; forensics only when ORDERBOOK_IMBALANCE_FEATURE_ENABLED",
                        styles["Body"],
                    ),
                    Paragraph(
                        "Top-N orderbook notional imbalance in [-1, +1]. Disabled by default because "
                        "it costs an extra /latest/orderbooks fetch per symbol against the 200/min "
                        "budget.",
                        styles["Body"],
                    ),
                ],
            ],
            col_widths=[1.5 * inch, 1.8 * inch, 3.4 * inch],
        ),
        Paragraph("6.1 Automatic backtests", styles["H2"]),
        Paragraph(
            "The bot runs the backtester automatically ~60 s after every server start, against the last "
            "<font face=\"Courier\">BACKTEST_AUTORUN_DAYS</font> (30) of bars for the configured universe. "
            "The result is parked in memory and surfaced under <font face=\"Courier\">meta.backtest</font> "
            "on <font face=\"Courier\">/dashboard</font>.",
            styles["Body"],
        ),
        Paragraph(
            "After the primary run completes, two alt runs fire, each isolating one top-detection gate "
            "so per-gate expectancy impact is attributable: <b>alt</b> = looser BTC lead-lag gate ON, "
            "volume gate OFF; <b>alt2</b> = tighter volume gate ON, BTC gate OFF. Compare "
            "<font face=\"Courier\">overall.avgNetBpsPerEntry</font> between primary, alt, and alt2 to "
            "see which gate (if any) improves expectancy on real history before flipping it on live.",
            styles["Body"],
        ),
        Paragraph("On-demand parameter sweeps via the same path:", styles["Body"]),
        Paragraph(
            "GET /debug/backtest                                          -> cached result if any<br/>"
            "GET /debug/backtest?refresh=true                             -> re-run with default params<br/>"
            "GET /debug/backtest?days=60&amp;signalTargetFraction=1.0         -> re-run with overrides (waits)<br/>"
            "GET /debug/backtest?wait=false&amp;minProjectedBps=25            -> kick off in background",
            styles["Mono"],
        ),
    ]

    # 7. Expectancy
    flow += [
        PageBreak(),
        Paragraph("7. Expectancy", styles["H1"]),
        Paragraph(
            "Two analysis scripts answer \"is this strategy actually profitable?\": "
            "<font face=\"Courier\">npm run reconcile</font> compares predicted vs realised on live "
            "forensics data, and <font face=\"Courier\">node scripts/simulate_strategy.js</font> runs "
            "a closed-form Monte Carlo across drift/vol regimes.",
            styles["Body"],
        ),
        img("05_expectancy.png"),
        Paragraph(
            "Figure 7. Simulator output (20 000 trials/regime, default fees/spread, 10-min "
            "break-even timeout). Expectancy is <b>strongly negative under flat or adverse drift</b> "
            "because stuck positions accumulate negative MTM that the engine never crystallises.",
            styles["Caption"],
        ),
        section_table(
            [
                ["Regime", "Drift (bps/min)", "TP fill rate", "Stuck rate", "Expectancy (bps/trade)"],
                ["benign", "+0.5", "5.5%", "0.0%", "+1.00"],
                ["flat", "0", "4.2%", "3.7%", "-49"],
                ["adverse", "-0.5", "3.4%", "33.7%", "-1382"],
                ["quiet", "0 (sigma=6)", "0.0%", "7.1%", "-51"],
                ["wild", "0 (sigma=25)", "28.5%", "2.4%", "-55"],
            ],
            col_widths=[1.0 * inch, 1.4 * inch, 1.2 * inch, 1.2 * inch, 1.9 * inch],
        ),
        Paragraph("7.1 Three responses if production expectancy stays negative", styles["H2"]),
        bullet(
            "Widen <font face=\"Courier\">TARGET_NET_PROFIT_BPS</font> materially (50-80 bps) so winners "
            "pay for the stuck tail. The simulator shows this alone is insufficient - fill rates collapse "
            "roughly proportionally.",
            styles,
        ),
        bullet(
            "Keep <font face=\"Courier\">HONEST_EV_GATE_ENABLED=true</font> and tune "
            "<font face=\"Courier\">STUCK_LOSS_ASSUMED_BPS</font> to match observed adverse-regime MTM, "
            "accepting that this starves entries in any regime that isn't trending up.",
            styles,
        ),
        bullet(
            "Tighten <font face=\"Courier\">STOP_LOSS_BPS</font> and/or shorten "
            "<font face=\"Courier\">BREAKEVEN_TIMEOUT_MS</font> for faster loss realization and capital "
            "recycling in adverse regimes.",
            styles,
        ),
    ]

    # 8. Configuration
    flow += [
        PageBreak(),
        Paragraph("8. Configuration reference", styles["H1"]),
        Paragraph(
            "Defaults below match <font face=\"Courier\">README.md</font> (which is the source of truth) "
            "and <font face=\"Courier\">backend/config/liveDefaults.js</font>. If you see env vars referenced in older "
            "doc fragments that aren't listed here, treat them as <b>not wired</b> until confirmed by "
            "<font face=\"Courier\">grep</font> in <font face=\"Courier\">backend/</font>.",
            styles["Body"],
        ),
        Paragraph("8.1 Required for live trading", styles["H2"]),
        section_table(
            [
                ["Variable", "Purpose"],
                ["APCA_API_KEY_ID", "Alpaca key (aliases: ALPACA_KEY_ID, ALPACA_API_KEY_ID, ALPACA_API_KEY)."],
                ["APCA_API_SECRET_KEY", "Alpaca secret (aliases: ALPACA_SECRET_KEY, ALPACA_API_SECRET_KEY)."],
                ["TRADE_BASE", "Must be https://api.alpaca.markets. Paper endpoints rejected."],
                ["DATA_BASE", "https://data.alpaca.markets"],
                ["API_TOKEN", "Required in production. Protects every mutating endpoint and most debug endpoints."],
            ],
            col_widths=[2.0 * inch, 4.7 * inch],
        ),
        Paragraph("8.2 Strategy economics", styles["H2"]),
        section_table(
            [
                ["Variable", "Default", "What it does"],
                ["TARGET_NET_PROFIT_BPS", "8", "Floor for the per-trade exit target after fees. Clamped to [5, 50]."],
                ["SIGNAL_TARGET_FRACTION", "1.0", "Fraction of OLS projection captured. 30-day backtest A/B: 1.0 = +5.73 bps/entry vs 0.5 = +3.97."],
                ["SIGNAL_SIZED_EXIT_ENABLED", "true", "Per-trade TP from projection. OFF = fixed TARGET_NET_PROFIT_BPS for every trade."],
                ["SIGNAL_TARGET_MAX_NET_BPS", "50", "Cap on the per-trade signal-sized net target."],
                ["FEE_BPS_ROUND_TRIP", "40", "~25 bps taker entry + ~15 bps maker exit."],
                ["PROFIT_BUFFER_BPS", "5", "Cushion in entry edge gate."],
                ["MIN_NET_EDGE_BPS", "2", "Minimum expected net edge before buying."],
                ["MIN_PROJECTED_BPS_TO_ENTER", "15", "Hard floor on OLS projection. ~3x slippage budget."],
                ["MIN_VOLUME_RATIO_TO_ENTER", "1.0", "Recent-window volume must >= lookback mean."],
                ["MAX_BTC_LEAD_LAG_DROP_BPS", "-10", "Refuse alts when BTC last-5-bar return <= threshold."],
                ["MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER", "-2.0", "Pause all entries when book aggregate < -2.0% unrealized."],
                ["PORTFOLIO_SIZING_PCT", "0.10", "Fraction of equity per trade."],
                ["MIN_TRADE_NOTIONAL_USD", "1", "Dust floor."],
                ["MIN_SIZING_FRACTION_OF_TARGET", "0.6", "Skip when cash-clamped notional is < fraction of target."],
                ["BREAKEVEN_TIMEOUT_MS", "14 400 000", "Staircase decay window (4h)."],
                ["STAIRCASE_EXIT_ENABLED", "true", "Linear TP -> break-even decay. OFF = one-shot break-even-replace at T."],
                ["STAIRCASE_REPOST_TOLERANCE_BPS", "3", "Min drop before cancel/repost."],
                ["STOP_LOSS_ENABLED", "false", "OFF = no realised losses by default."],
                ["STOP_LOSS_BPS", "100", "Cap on vol-scaled stop."],
                ["VOL_SCALED_STOP_ENABLED", "true", "Size stop from entry-time sigma."],
                ["STOP_LOSS_VOL_K", "1.0", "Number of sigma in the formula."],
                ["STOP_LOSS_HORIZON_BARS", "60", "sigma integration horizon (1m bars)."],
                ["STOP_LOSS_BPS_FLOOR", "20", "Floor for vol-scaled stop."],
                ["ENTRY_SLIPPAGE_BPS", "3", "Slippage budget on entry."],
                ["EXIT_SLIPPAGE_BPS", "3", "Slippage budget on exit."],
                ["CORRECTED_FILL_PROB_ENABLED", "true", "Use GBM barrier-hitting probability. OFF = legacy logistic_cdf proxy."],
                ["ENFORCE_GROSS_TARGET_FLOOR", "true", "Refuse trades that can't pay their own friction."],
                ["HONEST_EV_GATE_ENABLED", "true", "Charge non-fill branch a stuck-loss penalty."],
                ["STUCK_LOSS_ASSUMED_BPS", "250", "MTM loss assumed for non-recovering positions."],
                ["BARRIER_HORIZON_BARS", "BREAKEVEN_TIMEOUT_MS/60000", "Horizon for barrier-hitting probability."],
            ],
            col_widths=[2.4 * inch, 0.9 * inch, 3.4 * inch],
        ),
    ]

    flow += [
        PageBreak(),
        Paragraph("8.3 Scanner and data", styles["H2"]),
        section_table(
            [
                ["Variable", "Default", "What it does"],
                ["ENTRY_SCAN_INTERVAL_MS", "12 000", "How often the entry loop runs."],
                ["EXIT_SCAN_INTERVAL_MS", "15 000", "How often exit/state poll runs."],
                ["ENTRY_QUOTE_MAX_AGE_MS", "60 000", "Reject quotes staler than this."],
                ["SPREAD_MAX_BPS", "30", "Skip symbols whose spread exceeds this."],
                ["PREDICT_BARS", "20", "Bars used in entry OLS."],
                ["VOLATILITY_MAX_BPS", "100", "Skip if realised vol exceeds this."],
                ["HTF_FILTER_ENABLED", "true", "Gate on higher-timeframe slope."],
                ["HTF_BARS", "12", "HTF lookback."],
                ["HTF_MIN_SLOPE_BPS_PER_BAR", "1", "HTF slope floor (bps/bar)."],
                ["HTTP_TIMEOUT_MS", "10 000", "Per-request HTTP timeout."],
            ],
            col_widths=[2.4 * inch, 0.9 * inch, 3.4 * inch],
        ),
        Paragraph("8.4 Universe", styles["H2"]),
        section_table(
            [
                ["Variable", "What it does"],
                [
                    "ENTRY_UNIVERSE_MODE",
                    "Default <i>dynamic</i> in README posture - scanner walks every active Alpaca crypto pair "
                    "(USD-quoted, ex-stablecoins). Per-symbol gates filter the long tail. Set <i>configured</i> "
                    "to restrict to ENTRY_SYMBOLS_PRIMARY.",
                ],
                [
                    "ENTRY_SYMBOLS_PRIMARY",
                    "Default 12 deep-liquidity pairs: BTC, ETH, SOL, AVAX, LINK, UNI, DOT, ADA, XRP, DOGE, LTC, BCH (all /USD).",
                ],
                [
                    "ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION",
                    "Default true so production can opt into dynamic without an extra flag.",
                ],
            ],
            col_widths=[2.4 * inch, 4.3 * inch],
        ),
        Paragraph("8.5 Toggles", styles["H2"]),
        section_table(
            [
                ["Variable", "Default", "What it does"],
                ["TRADING_ENABLED", "true", "Kill-switch for the buy path."],
                ["NET_EDGE_GATE_ENABLED", "true", "Disable to let all entries skip the edge gate."],
            ],
            col_widths=[2.4 * inch, 0.9 * inch, 3.4 * inch],
        ),
        Paragraph(
            "Validated env-var list lives in <font face=\"Courier\">backend/config/validateEnv.js</font>. "
            "Non-secret production defaults live in <font face=\"Courier\">backend/config/liveDefaults.js</font>.",
            styles["Body"],
        ),
    ]

    # 9. Operations
    flow += [
        PageBreak(),
        Paragraph("9. Operations", styles["H1"]),
        Paragraph("9.1 Setup", styles["H2"]),
        Paragraph(
            "Requires Node 22 (<font face=\"Courier\">nvm use</font> in <font face=\"Courier\">backend/</font>).",
            styles["Body"],
        ),
        Paragraph(
            "cd backend<br/>"
            "npm install            # postinstall wires up .git-hooks<br/>"
            "cp .env.example .env   # fill in live Alpaca keys (never commit secrets)<br/>"
            "npm test<br/>"
            "npm run smoke<br/>"
            "npm start",
            styles["Mono"],
        ),
        Paragraph("9.2 Tests and scripts", styles["H2"]),
        Paragraph(
            "npm test                  # check:no-secrets + grouped suites<br/>"
            "npm run smoke             # local smoke test<br/>"
            "npm run preflight         # runtime-env check + smoke<br/>"
            "npm run check:complexity  # enforces line budget on trade.js<br/>"
            "npm run reconcile         # offline analysis: predicted vs realised<br/>"
            "npm run backtest          # replay strategy on real Alpaca bars",
            styles["Mono"],
        ),
        Paragraph(
            "CI runs on every push/PR to <font face=\"Courier\">main</font>: backend "
            "<font face=\"Courier\">npm ci -&gt; lint -&gt; test -&gt; runtime env sanity check</font>, "
            "frontend <font face=\"Courier\">npm ci</font> install-only smoke. See "
            "<font face=\"Courier\">.github/workflows/ci.yml</font>.",
            styles["Body"],
        ),
        Paragraph("9.3 Production deployment (Render)", styles["H2"]),
        bullet(
            "Set every secret (<font face=\"Courier\">APCA_API_KEY_ID</font>, "
            "<font face=\"Courier\">APCA_API_SECRET_KEY</font>, <font face=\"Courier\">API_TOKEN</font>) "
            "directly in the Render env. Never in git - the pre-commit hook in "
            "<font face=\"Courier\">.git-hooks/pre-commit</font> blocks obvious cases.",
            styles,
        ),
        bullet(
            "Run <font face=\"Courier\">npm run check:runtime-env</font> to validate config.",
            styles,
        ),
        bullet(
            "Leave <font face=\"Courier\">ENTRY_UNIVERSE_MODE</font> unset (default <i>dynamic</i>) so the "
            "scanner walks every active Alpaca USD-quoted crypto pair minus stablecoins. Tier-1-tight "
            "spread/freshness gates filter the long tail.",
            styles,
        ),
        bullet(
            "After deploy, <font face=\"Courier\">GET /debug/runtime-config</font> (token-protected) is the "
            "source of truth for what the live process actually sees. Verify "
            "<font face=\"Courier\">effectiveUniverseMode=dynamic</font> and "
            "<font face=\"Courier\">scanSymbolsCount</font> on the order of 30+ in the "
            "<font face=\"Courier\">startup_truth_summary</font> log line.",
            styles,
        ),
        Paragraph("9.4 Docker", styles["H2"]),
        Paragraph(
            "cd backend<br/>"
            "docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) -t magic-backend .<br/>"
            "docker run --rm -p 3000:3000 --env-file .env magic-backend",
            styles["Mono"],
        ),
        Paragraph(
            "Render currently builds without the Dockerfile.",
            styles["Body"],
        ),
    ]

    # 10. Constraints and known limitations
    flow += [
        PageBreak(),
        Paragraph("10. Known constraints and structural limitations", styles["H1"]),
        bullet(
            "Rate limiting (<font face=\"Courier\">backend/rateLimit.js</font>) is in-memory and "
            "per-process. Single-instance only.",
            styles,
        ),
        bullet("The Frontend is read-only diagnostic. It cannot place or modify orders.", styles),
        bullet(
            "<font face=\"Courier\">backend/trade.js</font> is large; "
            "<font face=\"Courier\">npm run check:complexity</font> enforces a soft line cap.",
            styles,
        ),
        bullet("Crypto markets are 24/7 - there is no \"market closed\" safe window.", styles),
        bullet(
            "No cross-symbol correlation guard. When the scanner walks 30+ pairs the engine can become "
            "long the same beta on multiple symbols simultaneously. The portfolio-drawdown gate is a "
            "coarse proxy that pauses <i>new</i> entries once correlated open positions have started "
            "bleeding - it doesn't prevent the first N entries from clustering.",
            styles,
        ),
        Paragraph("10.1 Structural limitation of \"small TP + long-hold tail\"", styles["H2"]),
        Paragraph(
            "Honest expectancy under realistic 1m crypto volatility (sigma ~ 12 bps/min) is <b>negative "
            "in flat or adverse drift regimes</b>, even though the engine <i>appears</i> loss-free "
            "because no realised loss is ever booked. Stuck positions accumulate negative MTM that "
            "the engine never crystallises. The cost-floor gate and corrected fill probability raise "
            "the bar entries must clear; they do not change the structural payoff. See section 7 "
            "for the simulator output.",
            styles["Body"],
        ),
        Paragraph("11. Hard project rules", styles["H1"]),
        bullet(
            "<b>Keep README.md current.</b> Any PR that touches trading behaviour, default values for "
            "documented env vars, the \"What the bot does NOT do\" list, or top-level repo layout must "
            "update <font face=\"Courier\">README.md</font> in the same commit.",
            styles,
        ),
        bullet(
            "<b>Never commit Alpaca credentials or <font face=\"Courier\">API_TOKEN</font> values.</b> "
            "Pre-commit hook blocks obvious cases; never bypass with <font face=\"Courier\">--no-verify</font>.",
            styles,
        ),
        bullet(
            "<b>Live trading only.</b> <font face=\"Courier\">TRADE_BASE</font> must point at "
            "<font face=\"Courier\">https://api.alpaca.markets</font> in production. Paper endpoints "
            "are explicitly rejected. Don't add fallbacks that re-allow paper.",
            styles,
        ),
        bullet(
            "<b>Don't re-introduce dead knobs as if they're real.</b> If you document a feature, the "
            "feature must actually be wired. The current backend has substantial doc-vs-code drift; "
            "do not make it worse.",
            styles,
        ),
        bullet(
            "<b>Don't add stop-loss, max-hold, or force-exit logic without explicit user instruction.</b> "
            "The \"walk away after placing the GTC sell\" behaviour is intentional design, not a missing "
            "feature.",
            styles,
        ),
        Paragraph(
            "<b>End of specification.</b> Canonical reference: <font face=\"Courier\">README.md</font> "
            "at the repository root. Diagrams in this PDF are produced by "
            "<font face=\"Courier\">docs/generate_spec_images.py</font>; re-run that script and "
            "<font face=\"Courier\">docs/generate_spec_pdf.py</font> to regenerate.",
            styles["Body"],
        ),
    ]

    doc.build(flow, onFirstPage=page_decorator, onLaterPages=page_decorator)
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    build_doc()
