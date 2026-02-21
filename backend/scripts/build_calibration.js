const fs = require('fs');
const path = require('path');

const inputPath = path.resolve(process.argv[2] || './data/trade_forensics.jsonl');
const outputPath = path.resolve(process.argv[3] || './data/calibration.json');

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function logit(p) {
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(clamped / (1 - clamped));
}

function fit(records) {
  const samples = [];
  const updatesByTrade = new Map();
  for (const rec of records) {
    if (rec.type === 'update' && rec.tradeId) {
      updatesByTrade.set(rec.tradeId, { ...(updatesByTrade.get(rec.tradeId) || {}), ...(rec.patch || {}) });
    }
  }
  for (const rec of records) {
    if (!rec.tradeId || rec.type === 'update') continue;
    const p = Number(rec?.decision?.probability ?? rec?.decision?.predictorProbability);
    const pnl = Number(updatesByTrade.get(rec.tradeId)?.exit?.netPnlEstimateUsd);
    if (!Number.isFinite(p) || !Number.isFinite(pnl)) continue;
    samples.push({ x: logit(p), y: pnl > 0 ? 1 : 0 });
  }
  if (samples.length < 20) return { type: 'logistic', a: 0, b: 1, samples: samples.length };
  let a = 0;
  let b = 1;
  const lr = 0.01;
  for (let step = 0; step < 300; step += 1) {
    let da = 0;
    let db = 0;
    for (const s of samples) {
      const pred = sigmoid(a + b * s.x);
      const err = pred - s.y;
      da += err;
      db += err * s.x;
    }
    a -= (lr * da) / samples.length;
    b -= (lr * db) / samples.length;
  }
  return { type: 'logistic', a, b, samples: samples.length };
}

const records = readJsonLines(inputPath);
const model = fit(records);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(model, null, 2));
console.log('calibration_written', { outputPath, samples: model.samples, type: model.type });
