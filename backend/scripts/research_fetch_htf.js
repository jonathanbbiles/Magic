// Research data fetcher (2026-08-09 sprint). Pulls max-history klines at 1h /
// 4h / 1d for the full canonical universe plus the free external-context feeds,
// and caches them under research_data/. Read-only: touches no config, no venue,
// places no orders.
//
// Usage: node scripts/research_fetch_htf.js [--intervals=1h,4h] [--force]

const fs = require('fs');
const path = require('path');
const https = require('https');
const symbols = require('../modules/binanceSymbols');
const md = require('../modules/binanceMarketData');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const FORCE = process.argv.includes('--force');
const INTERVALS = String(arg('intervals', '1h,4h')).split(',').map((s) => s.trim()).filter(Boolean);
const OUT = path.join(__dirname, '..', '..', 'research_data');

// Max pages per symbol per interval. 1000 bars/page.
const MAX_PAGES = { '1h': 70, '4h': 25, '1d': 6 };

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'magic-research/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad json from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchKlines(interval) {
  const file = path.join(OUT, `research_klines_${interval}.json`);
  if (!FORCE && fs.existsSync(file)) {
    console.log(`  ${interval}: cached (${file})`);
    return;
  }
  const universe = symbols.TIER1_CANONICAL.concat(symbols.TIER2_CANONICAL);
  await symbols.hydrate({ universe });
  const bars = {};
  const startMs = Date.parse('2017-01-01T00:00:00Z'); // API clamps to listing date
  const endMs = Date.now();
  for (const sym of universe) {
    try {
      const b = await md.fetchAllKlinesForSymbol(sym, {
        interval, startMs, endMs, pageLimit: 1000, maxPages: MAX_PAGES[interval] || 25,
      });
      if (Array.isArray(b) && b.length > 200) {
        bars[sym] = b;
        process.stdout.write(`  ${interval} ${sym}: ${b.length}\n`);
      } else {
        process.stdout.write(`  ${interval} ${sym}: SKIP (${b ? b.length : 0} bars)\n`);
      }
    } catch (err) {
      process.stdout.write(`  ${interval} ${sym}: FAILED (${err && err.message})\n`);
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), interval, bars }));
  console.log(`  ${interval}: wrote ${Object.keys(bars).length} symbols -> ${file}`);
}

// Crypto Fear & Greed index (alternative.me) — free, daily, no key, back to
// 2018-02-01. This is the ONLY external context feed in this sprint that is
// both free and has usable history; see STRATEGY_RESEARCH.md for what is not.
async function fetchFearGreed() {
  const file = path.join(OUT, 'research_fear_greed.json');
  if (!FORCE && fs.existsSync(file)) { console.log('  fear&greed: cached'); return; }
  const j = await getJson('https://api.alternative.me/fng/?limit=0&format=json');
  const rows = (j && j.data ? j.data : []).map((r) => ({
    date: new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10),
    value: Number(r.value),
    label: r.value_classification,
  })).filter((r) => Number.isFinite(r.value)).sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), rows }));
  console.log(`  fear&greed: ${rows.length} daily rows ${rows[0]?.date} -> ${rows[rows.length - 1]?.date}`);
}

// OKX perpetual funding-rate history (8h settlements). Binance's futures
// endpoint is geo-blocked (HTTP 451) and Bybit returns 403 from here, so OKX is
// the only reachable funding source. Paginated backwards by `before`/`after`.
async function fetchFunding() {
  const file = path.join(OUT, 'research_funding_okx.json');
  if (!FORCE && fs.existsSync(file)) { console.log('  funding: cached'); return; }
  const rows = [];
  let before = Date.now();
  for (let page = 0; page < 60; page += 1) {
    const url = `https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100&before=${''}&after=${before}`;
    let j;
    try { j = await getJson(url); } catch (_) { break; }
    const data = (j && j.data) || [];
    if (!data.length) break;
    for (const r of data) {
      const ts = Number(r.fundingTime);
      const rate = Number(r.fundingRate);
      if (Number.isFinite(ts) && Number.isFinite(rate)) rows.push({ ts, rate });
    }
    const oldest = Math.min(...data.map((r) => Number(r.fundingTime)));
    if (!Number.isFinite(oldest) || oldest >= before) break;
    before = oldest;
    await new Promise((r) => setTimeout(r, 120));
  }
  rows.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), rows }));
  const f = rows[0]; const l = rows[rows.length - 1];
  console.log(`  funding(OKX BTC-USDT-SWAP): ${rows.length} rows ${f ? new Date(f.ts).toISOString().slice(0, 10) : '-'} -> ${l ? new Date(l.ts).toISOString().slice(0, 10) : '-'}`);
}

async function main() {
  console.log('Fetching research data (read-only, public endpoints)...');
  for (const iv of INTERVALS) await fetchKlines(iv);
  await fetchFearGreed();
  await fetchFunding();
  console.log('done');
}

main().catch((e) => { console.error('fetch_failed', e && e.stack || e); process.exit(1); });
