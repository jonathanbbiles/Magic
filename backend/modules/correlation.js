function computeReturns(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return [];
  const out = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = Number(prices[i - 1]);
    const next = Number(prices[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) continue;
    out.push(Math.log(next / prev));
  }
  return out;
}

function pearsonCorr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    const va = Number(a[i]);
    const vb = Number(b[i]);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return null;
    sumA += va;
    sumB += vb;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null;
  return cov / Math.sqrt(varA * varB);
}

function computeCorrelationMatrix(symbolToPrices) {
  const symbols = Object.keys(symbolToPrices || {});
  const matrix = {};
  const returnsBySymbol = {};
  for (const symbol of symbols) {
    returnsBySymbol[symbol] = computeReturns(symbolToPrices[symbol]);
  }
  for (const left of symbols) {
    matrix[left] = matrix[left] || {};
    for (const right of symbols) {
      if (left === right) {
        matrix[left][right] = 1;
        continue;
      }
      if (matrix[left][right] !== undefined) continue;
      const corr = pearsonCorr(returnsBySymbol[left], returnsBySymbol[right]);
      matrix[left][right] = corr;
      matrix[right] = matrix[right] || {};
      matrix[right][left] = corr;
    }
  }
  return matrix;
}

function clusterSymbols(existingSymbols, candidateSymbol, matrix, threshold) {
  const symbols = Array.isArray(existingSymbols) ? existingSymbols : [];
  const out = [candidateSymbol];
  for (const symbol of symbols) {
    const corr = matrix?.[candidateSymbol]?.[symbol];
    if (Number.isFinite(corr) && corr >= threshold) {
      out.push(symbol);
    }
  }
  return Array.from(new Set(out));
}

module.exports = {
  computeReturns,
  pearsonCorr,
  computeCorrelationMatrix,
  clusterSymbols,
};
