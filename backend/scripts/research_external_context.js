// PART 4 — External-context feature screen (2026-08-09 research sprint).
//
// SCOPE DISCIPLINE — what this deliberately is NOT. Jonathan asked about a "bot
// within a bot" that crawls news. We are NOT building that, and this script is
// the argument for why: a news-reaction trader is structurally a retail loser.
// Headlines are priced in milliseconds by co-located systems; our loop polls on
// a multi-second cadence from a Render box. The repo has already measured what
// latency does to an edge that decays in under a minute (btc_lead_lag: +3.0 bps
// at instant fill -> -1.7 bps one minute late). Racing the news is that same
// losing race with worse infrastructure and far more moving parts.
//
// The defensible question is narrower and much cheaper to answer: do SLOW
// external CONTEXT features carry measurable predictive value at all — either
// for forward returns, or (more usefully) as a better trend-vs-chop REGIME
// detector than price alone? If none of them beat price, no crawler, no feed
// subscription, and no "bot within a bot" is worth building, and we stop here
// having spent an afternoon instead of a month.
//
// HONEST STATS. Every test collapses the 30-symbol universe to ONE equal-weight
// basket observation per day before computing a t-stat. Pooling across symbols
// would inflate t by ~sqrt(30) because these tokens are ~0.8 correlated — the
// same pseudo-replication trap the seasonality scan documents.
//
// Read-only.

const lib = require('./research/lib');

const ER_WINDOW = 30;
const ER_THRESHOLD = 0.30;

function basketDailyCloses(daily) {
  // Equal-weight basket index: average of each symbol's normalised close.
  const dates = new Set();
  for (const s of Object.keys(daily)) for (const b of daily[s]) dates.add(String(b.t).slice(0, 10));
  const sorted = Array.from(dates).sort();
  const bySym = {};
  for (const s of Object.keys(daily)) bySym[s] = new Map(daily[s].map((b) => [String(b.t).slice(0, 10), Number(b.c)]));
  const first = {};
  const out = [];
  for (const d of sorted) {
    let sum = 0; let n = 0;
    for (const s of Object.keys(daily)) {
      const px = bySym[s].get(d);
      if (!(px > 0)) continue;
      if (first[s] == null) first[s] = px;
      sum += px / first[s]; n += 1;
    }
    if (n > 0) out.push({ date: d, index: sum / n, n });
  }
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return { r: 0, t: 0, n };
  const ma = lib.mean(a); const mb = lib.mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma; const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const r = (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
  const t = Math.abs(r) < 1 ? r * Math.sqrt((n - 2) / (1 - r * r)) : 0;
  return { r, t, n };
}

// Split-half stability: a real relationship keeps its sign in both halves.
function halves(xs, ys) {
  const h = Math.floor(xs.length / 2);
  return { h1: pearson(xs.slice(0, h), ys.slice(0, h)), h2: pearson(xs.slice(h), ys.slice(h)) };
}

function screen(label, xs, ys, unit) {
  const p = pearson(xs, ys);
  const { h1, h2 } = halves(xs, ys);
  const stable = Math.sign(h1.r) === Math.sign(h2.r);
  const real = Math.abs(p.t) >= 3 && stable;
  console.log(
    `  ${label.padEnd(38)} r=${lib.fmt(p.r, 3).padStart(7)}  t=${lib.fmt(p.t, 2).padStart(7)}  n=${String(p.n).padStart(5)}`
    + `  halves ${lib.fmt(h1.r, 2).padStart(5)}/${lib.fmt(h2.r, 2).padStart(5)}  ${real ? 'REAL' : (Math.abs(p.t) >= 3 ? 'unstable (sign flips)' : 'noise')}${unit ? `  [${unit}]` : ''}`,
  );
  return { label, ...p, stable, real };
}

function main() {
  const daily = lib.loadKlines('1d');
  const btc = daily['BTC/USD'];
  const btcCloses = btc.map((b) => Number(b.c));
  const btcDates = btc.map((b) => String(b.t).slice(0, 10));
  const basket = basketDailyCloses(daily);

  console.log('=== PART 4: external-context feature screen ===');
  console.log('bar: |t| >= 3 AND same sign in both halves. One observation per day');
  console.log('(equal-weight basket), never pooled across correlated symbols.\n');

  // ---- Data availability, stated plainly ----------------------------------
  const fng = lib.loadJson('research_fear_greed.json');
  const funding = lib.loadJson('research_funding_okx.json');
  console.log('--- Data availability ---');
  console.log(`  Fear & Greed (alternative.me) : ${fng ? `${fng.rows.length} daily rows, ${fng.rows[0].date} -> ${fng.rows[fng.rows.length - 1].date}` : 'UNAVAILABLE'}  [free, no key]`);
  console.log(`  Funding rates (OKX perp)      : ${funding ? `${funding.rows.length} settlements (~${Math.round(funding.rows.length / 3)} days)` : 'UNAVAILABLE'}  [Binance futures = HTTP 451 geo-blocked; Bybit = 403]`);
  console.log('  BTC dominance (history)       : UNAVAILABLE free — CoinGecko serves only a current');
  console.log('                                  snapshot on the free tier; historical global market-cap');
  console.log('                                  share is a paid endpoint. PROXY used below: BTC price');
  console.log('                                  vs the equal-weight alt basket (relative strength).');
  console.log('  On-chain / order-flow / news  : NOT FETCHED. Any of these needs a paid feed and/or');
  console.log('                                  standing infrastructure; the point of this screen is to');
  console.log('                                  find out whether that spend could ever pay for itself.\n');

  // ---- Build aligned daily series -----------------------------------------
  const idx = new Map(btcDates.map((d, i) => [d, i]));
  const basketIdx = new Map(basket.map((r, i) => [r.date, i]));
  const fngByDate = new Map((fng ? fng.rows : []).map((r) => [r.date, r.value]));

  // Trailing (causal) features and forward (target) returns, per date.
  const rows = [];
  for (let i = ER_WINDOW + 1; i < btc.length - 30; i += 1) {
    const d = btcDates[i];
    const bi = basketIdx.get(d);
    if (bi == null || bi + 30 >= basket.length) continue;
    const erNow = lib.efficiencyRatioAt(btcCloses, i, ER_WINDOW);
    const erFwd = lib.efficiencyRatioAt(btcCloses, i + 30, ER_WINDOW); // next 30d regime
    if (erNow == null || erFwd == null) continue;

    // trailing 30d realized vol of BTC daily returns (bps)
    const rets = [];
    for (let k = i - 29; k <= i; k += 1) rets.push((btcCloses[k] / btcCloses[k - 1] - 1));
    const vol = lib.stdev(rets) * 1e4;

    // BTC-vs-alt relative strength over 30d — the dominance PROXY.
    const btcRet30 = btcCloses[i] / btcCloses[i - 30] - 1;
    const bskRet30 = basket[bi].index / basket[bi - 30].index - 1;

    rows.push({
      date: d,
      fng: fngByDate.has(d) ? fngByDate.get(d) : null,
      erNow,
      erFwd,
      vol,
      dominanceProxy: (btcRet30 - bskRet30) * 1e4,
      fwd1: (basket[bi + 1].index / basket[bi].index - 1) * 1e4,
      fwd7: (basket[bi + 7].index / basket[bi].index - 1) * 1e4,
      fwd30: (basket[bi + 30].index / basket[bi].index - 1) * 1e4,
    });
  }
  const withFng = rows.filter((r) => r.fng != null);
  console.log(`aligned rows: ${rows.length} days (${withFng.length} with Fear & Greed)\n`);

  // ---- Screen 1: do these features predict FORWARD RETURNS? ---------------
  console.log('--- Screen 1: feature -> forward basket return ---');
  const s1 = [];
  const col = (rs, k) => rs.map((r) => r[k]);
  for (const [label, rs, key] of [
    ['Fear&Greed level -> fwd 1d', withFng, 'fwd1'],
    ['Fear&Greed level -> fwd 7d', withFng, 'fwd7'],
    ['Fear&Greed level -> fwd 30d', withFng, 'fwd30'],
  ]) s1.push(screen(label, col(rs, 'fng'), col(rs, key), 'bps'));
  for (const [label, key] of [
    ['trailing vol -> fwd 7d', 'fwd7'],
    ['trailing vol -> fwd 30d', 'fwd30'],
    ['BTC/alt rel-strength -> fwd 30d', 'fwd30'],
  ]) {
    const feat = label.startsWith('trailing vol') ? 'vol' : 'dominanceProxy';
    s1.push(screen(label, col(rows, feat), col(rows, key), 'bps'));
  }

  // ---- Screen 2: the question that actually matters -----------------------
  // Not "does it predict returns" (almost nothing does at daily scale) but
  // "is it a BETTER REGIME DETECTOR than the price-based ER we already ship?"
  console.log('\n--- Screen 2: feature -> FUTURE regime (next-30d BTC efficiency ratio) ---');
  console.log('  Incumbent to beat: trailing ER(30), the measure the shipped chop gate uses.');
  const s2 = [];
  s2.push(screen('trailing ER(30)  [INCUMBENT]', col(rows, 'erNow'), col(rows, 'erFwd')));
  s2.push(screen('Fear&Greed level', col(withFng, 'fng'), col(withFng, 'erFwd')));
  s2.push(screen('|Fear&Greed - 50| (extremity)', withFng.map((r) => Math.abs(r.fng - 50)), col(withFng, 'erFwd')));
  s2.push(screen('trailing 30d realized vol', col(rows, 'vol'), col(rows, 'erFwd')));
  s2.push(screen('BTC/alt rel-strength (dominance proxy)', col(rows, 'dominanceProxy'), col(rows, 'erFwd')));

  // Incremental value: does F&G add anything ON TOP of the incumbent? Regress
  // forward ER on trailing ER, then test whether F&G explains the residual.
  const fitted = (() => {
    const x = col(withFng, 'erNow'); const y = col(withFng, 'erFwd');
    const mx = lib.mean(x); const my = lib.mean(y);
    let num = 0; let den = 0;
    for (let i = 0; i < x.length; i += 1) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
    const beta = den > 0 ? num / den : 0;
    return y.map((v, i) => v - (my + beta * (x[i] - mx)));
  })();
  console.log('\n  Incremental test — does F&G explain what trailing ER does NOT?');
  screen('F&G -> residual of ER-only model', col(withFng, 'fng'), fitted);

  // ---- Screen 3: economic size, not just significance ---------------------
  // Even a "real" correlation is useless if conditioning on it does not move
  // the strategy's expectancy by more than the 8 bps cost.
  console.log('\n--- Screen 3: economic size (tercile spread in forward 30d basket return) ---');
  const terciles = (rs, key) => {
    const sorted = [...rs].sort((a, b) => a[key] - b[key]);
    const t = Math.floor(sorted.length / 3);
    return {
      low: lib.mean(sorted.slice(0, t).map((r) => r.fwd30)),
      high: lib.mean(sorted.slice(-t).map((r) => r.fwd30)),
    };
  };
  for (const [label, rs, key] of [
    ['Fear & Greed', withFng, 'fng'],
    ['trailing ER(30)', rows, 'erNow'],
    ['trailing 30d vol', rows, 'vol'],
  ]) {
    const t = terciles(rs, key);
    console.log(`  ${label.padEnd(20)} bottom third: ${lib.fmt(t.low).padStart(7)} bps   top third: ${lib.fmt(t.high).padStart(7)} bps   spread: ${lib.fmt(t.high - t.low).padStart(7)} bps (30d)`);
  }

  // ---- Screen 4: THE TWO TESTS THAT DECIDE IT ----------------------------
  //
  // (a) OVERLAP. A 30-day forward return sampled daily reuses 29/30 of the same
  //     future on consecutive rows. n=2452 is really ~82 independent windows, so
  //     the naive t is inflated by ~sqrt(30). Re-run on NON-OVERLAPPING windows.
  //
  // (b) IS IT EVEN EXTERNAL? alternative.me builds the Fear & Greed index from
  //     volatility (25%), market momentum/volume (25%), dominance (10%) and
  //     trends (10%) — i.e. ~70% of it is DERIVED FROM PRICE. So "F&G predicts
  //     returns" may be nothing more than "momentum predicts returns", which
  //     trend_momentum already harvests. The only thing that would justify a
  //     data feed is F&G explaining what price momentum does NOT.
  console.log('\n--- Screen 4: overlap correction + is F&G actually external? ---');

  for (const [label, horizon, key] of [['fwd 7d', 7, 'fwd7'], ['fwd 30d', 30, 'fwd30']]) {
    const nonOverlap = withFng.filter((_, i) => i % horizon === 0);
    const p = pearson(nonOverlap.map((r) => r.fng), nonOverlap.map((r) => r[key]));
    console.log(`  F&G -> ${label}, NON-OVERLAPPING: r=${lib.fmt(p.r, 3)}  t=${lib.fmt(p.t, 2)}  n=${p.n}`
      + `   (naive-overlapping t was ${label === 'fwd 7d' ? '8.00' : '13.15'})`);
  }

  // (b) Strip price momentum out first, then ask what F&G has left to say.
  const resid = (rs, xKey, yKey) => {
    const x = rs.map((r) => r[xKey]); const y = rs.map((r) => r[yKey]);
    const mx = lib.mean(x); const my = lib.mean(y);
    let num = 0; let den = 0;
    for (let i = 0; i < x.length; i += 1) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
    const beta = den > 0 ? num / den : 0;
    return y.map((v, i) => v - (my + beta * (x[i] - mx)));
  };
  const withMom = withFng.map((r, i, arr) => ({ ...r, mom30: i >= 30 ? r.dominanceProxy : null }));
  // Use BTC's own trailing 30d return as the momentum control.
  const momCol = [];
  for (const r of withFng) {
    const i = idx.get(r.date);
    momCol.push(i != null && i >= 30 ? (btcCloses[i] / btcCloses[i - 30] - 1) * 1e4 : 0);
  }
  const withMomRows = withFng.map((r, i) => ({ ...r, mom30: momCol[i] }));
  console.log(`  corr(F&G, trailing 30d BTC return) = ${lib.fmt(pearson(withMomRows.map((r) => r.fng), withMomRows.map((r) => r.mom30)).r, 3)}`
    + '   <- how much of "sentiment" is just price');
  const residFwd30 = resid(withMomRows, 'mom30', 'fwd30');
  const pInc = pearson(withMomRows.map((r) => r.fng), residFwd30);
  console.log(`  F&G -> fwd30 AFTER removing price momentum: r=${lib.fmt(pInc.r, 3)}  t=${lib.fmt(pInc.t, 2)} (overlapping)`);
  const nonOv = withMomRows.filter((_, i) => i % 30 === 0);
  const residNo = resid(nonOv, 'mom30', 'fwd30');
  const pIncNo = pearson(nonOv.map((r) => r.fng), residNo);
  console.log(`  same, NON-OVERLAPPING                     : r=${lib.fmt(pIncNo.r, 3)}  t=${lib.fmt(pIncNo.t, 2)}  n=${pIncNo.n}`);

  console.log('\n=== VERDICT ===');
  console.log('  NOTE: every forward-30d test above (returns AND regime) uses overlapping');
  console.log('  windows sampled daily, so its naive t is inflated by ~sqrt(30)~5.5x. The');
  console.log('  non-overlapping numbers in Screen 4 are the honest ones. Applying the same');
  console.log('  deflation to Screen 2, even the INCUMBENT trailing ER(30) is only ~|t|~2.');
  console.log('');
  console.log('  Fear & Greed: correlates 0.705 with trailing 30d BTC return — roughly 70% of');
  console.log('  the index is built from price/volatility/dominance by construction. Once price');
  console.log('  momentum is removed it explains essentially nothing (non-overlapping t=0.77,');
  console.log('  n=82). It is a repackaged momentum feature, not external information.');
  console.log('');
  console.log('  Funding rates: only ~97 days retrievable (Binance geo-blocked, Bybit 403).');
  console.log('  Too short to test. NOT a verdict on funding — a verdict on our data access.');
  console.log('');
  console.log('  BTC dominance: no free history. The price-based proxy is noise (t=0.24).');
  console.log('');
  console.log('  BOTTOM LINE: no external feed screened here beats price-derived features at');
  console.log('  either predicting returns or detecting the regime. Building a news crawler or');
  console.log('  paying for a sentiment feed is not justified by this evidence.');
}

main();
