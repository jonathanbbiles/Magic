// PART 3 — Seasonality scan (2026-08-09 research sprint).
//
// Day-of-week, month-of-year, turn-of-month and (when 1h data is present)
// hour-of-day return patterns across the 30-symbol universe.
//
// SKEPTIC'S FRAMING. Seasonality is the single most overfit family in retail
// quant. With 7 weekdays x 12 months x 24 hours you get ~43 independent-ish
// buckets; at p<0.05 you EXPECT ~2 to look "significant" from pure noise. So
// this script holds every effect to three bars at once:
//   1. STATISTICAL — |t| >= 3 (not 2), on a large sample.
//   2. ECONOMIC    — the effect must exceed the 8 bps round-trip cost by a
//                    margin worth trading, not merely be non-zero.
//   3. STABILITY   — it must hold in BOTH halves of the sample with the same
//                    sign. Anything that flips sign is noise, whatever its t.
// A bucket that clears (1) but fails (2) or (3) is reported as a MIRAGE.
//
// Read-only. Uses simple close-to-close bar returns (no strategy overlay), which
// is the right unit for "is there a calendar tilt in the underlying at all".

const lib = require('./research/lib');

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// PSEUDO-REPLICATION GUARD — read this before trusting any t-stat below.
//
// Pooling 30 crypto symbols on the same day does NOT give 30 independent
// observations: these tokens are ~0.7-0.9 cross-sectionally correlated, so one
// market-wide move is counted 30 times. That inflates the naive t-stat by
// roughly sqrt(n_symbols) ~ 5.5x and manufactures "significance" out of nothing.
// This is the single most common way a seasonality scan fools its author.
//
// The FIX used here: collapse each calendar period to ONE observation — the
// equal-weight basket return across all symbols with data that period. Those
// period returns are (approximately) independent, so their t-stat is honest.
// The naive pooled t is still printed alongside, purely to show the size of the
// illusion.
function collapseToBasket(rows) {
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    byTs.get(r.ts).push(r);
  }
  const out = [];
  for (const [ts, group] of byTs) {
    const g0 = group[0];
    out.push({
      ts,
      bps: group.reduce((s, x) => s + x.bps, 0) / group.length,
      symbolsInBasket: group.length,
      dow: g0.dow, month: g0.month, dom: g0.dom, hour: g0.hour, daysInMonth: g0.daysInMonth,
    });
  }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// Every bar return, tagged with its calendar coordinates. Pooled across symbols.
function collectReturns(bars, { intraday = false } = {}) {
  const out = [];
  for (const sym of Object.keys(bars)) {
    const b = bars[sym];
    for (let i = 1; i < b.length; i += 1) {
      const p0 = Number(b[i - 1].c); const p1 = Number(b[i].c);
      if (!(p0 > 0) || !(p1 > 0)) continue;
      const d = new Date(b[i].t);
      out.push({
        sym,
        ts: b[i].t,
        bps: (p1 / p0 - 1) * 10000,
        dow: d.getUTCDay(),
        month: d.getUTCMonth(),
        dom: d.getUTCDate(),
        hour: intraday ? d.getUTCHours() : null,
        daysInMonth: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(),
      });
    }
  }
  return out;
}

// Report a set of buckets against all three bars.
function report(title, buckets, { costBps = lib.COST_BPS, minAbsT = 3, pooledBuckets = null } = {}) {
  console.log(`\n--- ${title} ---`);
  console.log(`${'bucket'.padEnd(12)} ${'days'.padStart(6)} ${'mean bps'.padStart(9)} ${'t(honest)'.padStart(10)} ${'t(naive)'.padStart(9)} ${'1st half'.padStart(9)} ${'2nd half'.padStart(9)}  verdict`);
  const survivors = [];
  for (const [label, rows] of buckets) {
    if (!rows.length) continue;
    const vals = rows.map((r) => r.bps);
    const t = lib.tStat(vals);
    const m = lib.mean(vals);
    const pooled = pooledBuckets && pooledBuckets.get(label);
    const tNaive = pooled && pooled.length ? lib.tStat(pooled.map((r) => r.bps)) : NaN;
    const sorted = [...rows].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const half = Math.floor(sorted.length / 2);
    const h1 = lib.mean(sorted.slice(0, half).map((r) => r.bps));
    const h2 = lib.mean(sorted.slice(half).map((r) => r.bps));
    const statOk = Math.abs(t) >= minAbsT;
    const econOk = Math.abs(m) > costBps;
    const stableOk = Math.sign(h1) === Math.sign(h2) && h1 !== 0;
    let verdict;
    if (statOk && econOk && stableOk) { verdict = 'SURVIVES all 3 bars'; survivors.push({ label, m, t, h1, h2, n: vals.length }); }
    else if (statOk && !econOk) verdict = `mirage: |${lib.fmt(m, 1)}| < ${costBps}bps cost`;
    else if (statOk && !stableOk) verdict = 'mirage: sign flips between halves';
    else if (!statOk && econOk) verdict = `big but not significant (|t|=${lib.fmt(Math.abs(t), 1)})`;
    else verdict = 'noise';
    console.log(
      `${label.padEnd(12)} ${String(vals.length).padStart(6)} ${lib.fmt(m, 1).padStart(9)} ${lib.fmt(t, 2).padStart(10)} ${lib.fmt(tNaive, 2).padStart(9)} ${lib.fmt(h1, 1).padStart(9)} ${lib.fmt(h2, 1).padStart(9)}  ${verdict}`,
    );
  }
  return survivors;
}

function groupBy(rows, fn) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function main() {
  const daily = lib.loadKlines('1d');
  const pooled = collectReturns(daily);
  const rows = collapseToBasket(pooled);   // ONE observation per day
  console.log('=== PART 3: seasonality scan ===');
  console.log(`universe: ${Object.keys(daily).length} symbols | pooled bar-returns n=${pooled.length} -> collapsed to ${rows.length} independent DAYS`);
  console.log(`bars: |t(honest)| >= ${3}  AND  |mean| > ${lib.COST_BPS} bps cost  AND  same sign in both halves`);
  console.log('t(honest) = equal-weight basket, one obs/day. t(naive) = pooled across symbols,');
  console.log('shown only to expose how much cross-sectional correlation inflates it.');
  console.log(`(basket overall mean: ${lib.fmt(lib.mean(rows.map((r) => r.bps)), 1)} bps/day — the drift every bucket is measured against)`);

  const all = [];
  const mk = (src, fn, keys) => {
    const m = new Map();
    for (const k of keys) m.set(k.label, src.filter((r) => fn(r, k)));
    return m;
  };

  const dowKeys = DOW.map((label, d) => ({ label, d }));
  all.push(...report('Day of week (UTC)', mk(rows, (r, k) => r.dow === k.d, dowKeys),
    { pooledBuckets: mk(pooled, (r, k) => r.dow === k.d, dowKeys) }));

  const monKeys = MONTH.map((label, m) => ({ label, m }));
  all.push(...report('Month of year', mk(rows, (r, k) => r.month === k.m, monKeys),
    { pooledBuckets: mk(pooled, (r, k) => r.month === k.m, monKeys) }));

  const tomFns = [
    ['turn(-3..+3)', (r) => r.dom <= 3 || r.dom > r.daysInMonth - 3],
    ['mid-month', (r) => r.dom > 3 && r.dom <= r.daysInMonth - 3],
    ['first day', (r) => r.dom === 1],
    ['last day', (r) => r.dom === r.daysInMonth],
  ];
  const tomB = new Map(tomFns.map(([l, f]) => [l, rows.filter(f)]));
  const tomP = new Map(tomFns.map(([l, f]) => [l, pooled.filter(f)]));
  all.push(...report('Turn of month', tomB, { pooledBuckets: tomP }));

  try {
    const hourly = lib.loadKlines('1h');
    const hPooled = collectReturns(hourly, { intraday: true });
    const hRows = collapseToBasket(hPooled);
    console.log(`\n(hourly: pooled n=${hPooled.length} -> ${hRows.length} independent hourly basket returns)`);
    const hourKeys = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00`, h }));
    // 24 buckets = 24 shots at a false positive, so demand |t| >= 3.5 here.
    all.push(...report('Hour of day (UTC)', mk(hRows, (r, k) => r.hour === k.h, hourKeys),
      { minAbsT: 3.5, pooledBuckets: mk(hPooled, (r, k) => r.hour === k.h, hourKeys) }));
  } catch (e) {
    console.log('\n(hourly cache absent — skipping hour-of-day)');
  }

  console.log('\n=== VERDICT ===');
  if (!all.length) {
    console.log('NO calendar bucket survived all three bars once cross-sectional correlation');
    console.log('is accounted for. Seasonality here is a MIRAGE: the effects that looked');
    console.log('significant under naive pooling are an artefact of counting one market-wide');
    console.log('move 30 times, and what remains is smaller than the 8 bps round-trip cost');
    console.log('and/or flips sign between the two halves of the sample.');
  } else {
    console.log(`${all.length} bucket(s) survived all three bars:`);
    for (const s2 of all) console.log(`  ${s2.label}: ${lib.fmt(s2.m, 1)} bps (t=${lib.fmt(s2.t, 2)}, n=${s2.n} days, halves ${lib.fmt(s2.h1, 1)}/${lib.fmt(s2.h2, 1)})`);
    console.log('\nEven so: treat as a TILT candidate only, never a standalone signal, and');
    console.log('re-test on data generated AFTER this run before acting on it.');
  }
}

main();
