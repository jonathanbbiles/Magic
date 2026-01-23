const fs = require('fs');
const path = require('path');
const { fetchCryptoBars } = require('../trade');
const { normalizePair } = require('../symbolUtils');

const DATASET_DIR = process.env.DATASET_DIR || './data';
const DATASET_FORMAT = process.env.DATASET_FORMAT || 'jsonl';
const TARGET_MOVE_BPS = Number(process.env.TARGET_MOVE_BPS || 100);
const TARGET_HORIZON_MINUTES = Number(process.env.TARGET_HORIZON_MINUTES || 30);
const LABELER_INTERVAL_MS = Number(process.env.LABELER_INTERVAL_MS || 300000);
const LABELER_MAX_RECORDS = Number(process.env.LABELER_MAX_RECORDS || 200);
const LABELER_SLEEP_MS = Number(process.env.LABELER_SLEEP_MS || 200);

const predictorPath = path.resolve(DATASET_DIR, `predictor.${DATASET_FORMAT}`);
const labelsPath = path.resolve(DATASET_DIR, 'labeled.jsonl');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLastLines(filePath, maxLines = 2000, maxBytes = 2_000_000) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stats = fs.statSync(filePath);
    if (!stats.size) return [];
    const size = Math.min(stats.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stats.size - size);
    fs.closeSync(fd);
    const content = buffer.toString('utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
  } catch (err) {
    console.warn('labeler_read_failed', { filePath, error: err?.message || String(err) });
    return [];
  }
}

function parseJsonLines(lines) {
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      return null;
    }
  }).filter(Boolean);
}

function keyForRecord(record) {
  return `${record?.ts || ''}_${record?.symbol || ''}`;
}

function appendLabel(record) {
  try {
    fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
    fs.appendFileSync(labelsPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    console.warn('labeler_append_failed', { error: err?.message || String(err) });
  }
}

function computeBuckets() {
  return [
    { key: '0.5-0.6', min: 0.5, max: 0.6 },
    { key: '0.6-0.7', min: 0.6, max: 0.7 },
    { key: '0.7-0.8', min: 0.7, max: 0.8 },
    { key: '0.8-0.9', min: 0.8, max: 0.9 },
    { key: '0.9-1.0', min: 0.9, max: 1.0 },
  ];
}

function bucketForProbability(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p)) return null;
  const buckets = computeBuckets();
  return buckets.find((bucket) => p >= bucket.min && p < bucket.max) || buckets[buckets.length - 1];
}

function getRecentLabels(limit = 200) {
  const lines = readLastLines(labelsPath, limit);
  return parseJsonLines(lines);
}

function getLabelStats(hours = 6) {
  const maxLines = 4000;
  const lines = readLastLines(labelsPath, maxLines);
  const records = parseJsonLines(lines);
  const cutoffMs = Date.now() - Math.max(1, Number(hours) || 6) * 60 * 60 * 1000;
  const filtered = records.filter((record) => {
    const tsMs = Date.parse(record?.ts);
    return Number.isFinite(tsMs) && tsMs >= cutoffMs;
  });
  const buckets = computeBuckets();
  const bucketStats = new Map(buckets.map((bucket) => [
    bucket.key,
    { count: 0, hits: 0, maxUpSum: 0, maxDownSum: 0 },
  ]));

  let total = 0;
  let totalHits = 0;
  filtered.forEach((record) => {
    total += 1;
    if (record?.hitTarget) totalHits += 1;
    const bucket = bucketForProbability(record?.predictorProbability);
    if (!bucket) return;
    const stats = bucketStats.get(bucket.key);
    stats.count += 1;
    if (record?.hitTarget) stats.hits += 1;
    if (Number.isFinite(record?.maxUpBps)) stats.maxUpSum += record.maxUpBps;
    if (Number.isFinite(record?.maxDownBps)) stats.maxDownSum += record.maxDownBps;
  });

  const byBucket = {};
  buckets.forEach((bucket) => {
    const stats = bucketStats.get(bucket.key);
    const count = stats.count || 0;
    byBucket[bucket.key] = {
      count,
      hitRate: count ? stats.hits / count : 0,
      averageMaxUpBps: count ? stats.maxUpSum / count : 0,
      averageMaxDownBps: count ? stats.maxDownSum / count : 0,
    };
  });

  const overall = {
    count: total,
    hitRate: total ? totalHits / total : 0,
  };

  return { overall, byBucket };
}

async function labelRecord(record) {
  const symbol = normalizePair(record.symbol);
  const tsMs = Date.parse(record.ts);
  const refPrice = Number(record.refPrice);
  if (!Number.isFinite(tsMs) || !Number.isFinite(refPrice) || refPrice <= 0) {
    return null;
  }

  const horizonMinutes = Number(record?.config?.targetHorizonMinutes || TARGET_HORIZON_MINUTES);
  const targetMoveBps = Number(record?.config?.targetMoveBps || TARGET_MOVE_BPS);
  const endMs = tsMs + horizonMinutes * 60 * 1000;
  if (Date.now() < endMs) {
    return null;
  }

  const startIso = new Date(tsMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const barsResp = await fetchCryptoBars({
    symbols: [symbol],
    limit: Math.max(6, Math.ceil(horizonMinutes) + 2),
    timeframe: '1Min',
    start: startIso,
    end: endIso,
  });

  const barKey = normalizePair(symbol);
  const barSeries = barsResp?.bars?.[barKey] || barsResp?.bars?.[normalizePair(barKey)] || [];
  if (!Array.isArray(barSeries) || !barSeries.length) return null;

  let maxHigh = -Infinity;
  let minLow = Infinity;
  let hitTarget = false;
  let timeToHitMinutes = null;
  const targetPrice = refPrice * (1 + targetMoveBps / 10000);

  for (let i = 0; i < barSeries.length; i += 1) {
    const bar = barSeries[i];
    const high = Number(bar.h ?? bar.high ?? bar.high_price ?? bar.c ?? bar.close ?? bar.vwap);
    const low = Number(bar.l ?? bar.low ?? bar.low_price ?? bar.c ?? bar.close ?? bar.vwap);
    if (Number.isFinite(high)) {
      if (high > maxHigh) maxHigh = high;
      if (!hitTarget && high >= targetPrice) {
        hitTarget = true;
        const barTs = Date.parse(bar.t ?? bar.timestamp);
        if (Number.isFinite(barTs)) {
          timeToHitMinutes = Math.max(0, (barTs - tsMs) / 60000);
        } else {
          timeToHitMinutes = i;
        }
      }
    }
    if (Number.isFinite(low)) {
      if (low < minLow) minLow = low;
    }
  }

  const maxUpBps = Number.isFinite(maxHigh) ? ((maxHigh - refPrice) / refPrice) * 10000 : null;
  const maxDownBps = Number.isFinite(minLow) ? ((minLow - refPrice) / refPrice) * 10000 : null;

  return {
    ...record,
    hitTarget,
    timeToHitMinutes,
    maxUpBps,
    maxDownBps,
  };
}

async function runLabelerOnce() {
  const predictorLines = readLastLines(predictorPath, LABELER_MAX_RECORDS * 4);
  const predictorRecords = parseJsonLines(predictorLines);
  if (!predictorRecords.length) return;

  const labeledLines = readLastLines(labelsPath, 5000);
  const labeledRecords = parseJsonLines(labeledLines);
  const labeledKeys = new Set(labeledRecords.map((record) => keyForRecord(record)));

  const pending = predictorRecords
    .filter((record) => record?.decision && record?.ts && record?.symbol)
    .filter((record) => !labeledKeys.has(keyForRecord(record)))
    .slice(-LABELER_MAX_RECORDS);

  for (const record of pending) {
    const labeled = await labelRecord(record);
    if (labeled) {
      appendLabel(labeled);
    }
    await sleep(LABELER_SLEEP_MS);
  }
}

let labelerIntervalId = null;

function startLabeler() {
  if (labelerIntervalId) return;
  labelerIntervalId = setInterval(() => {
    runLabelerOnce().catch((err) => {
      console.error('labeler_run_failed', err?.message || err);
    });
  }, LABELER_INTERVAL_MS);
  setTimeout(() => {
    runLabelerOnce().catch((err) => {
      console.error('labeler_run_failed', err?.message || err);
    });
  }, 0);
  console.log('labeler_started', { intervalMs: LABELER_INTERVAL_MS });
}

module.exports = {
  startLabeler,
  getRecentLabels,
  getLabelStats,
};
