/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { requestJson } = require('../modules/http');

async function main() {
  const key = process.env.APCA_API_KEY_ID || process.env.ALPACA_KEY_ID || process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY;
  const secret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || process.env.ALPACA_API_SECRET_KEY;
  const base = (process.env.DATA_BASE || 'https://data.alpaca.markets').replace(/\/+$/, '');
  const url = `${base}/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD`;

  const data = await requestJson({
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret,
    },
    timeoutMs: 10000,
  });

  console.log('smoke_http_ok', {
    status: 200,
    hasQuotes: Boolean(data?.quotes),
    symbols: Object.keys(data?.quotes || {}),
  });
}

main().catch((error) => {
  console.error('smoke_http_failed', {
    statusCode: error?.statusCode ?? null,
    message: error?.message || String(error),
  });
  process.exitCode = 1;
});
