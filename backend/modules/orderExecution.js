const { requestJson, logHttpError } = require('./http');

const ALPACA_KEY_ENV_VARS = ['APCA_API_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_API_KEY_ID', 'ALPACA_API_KEY'];
const ALPACA_SECRET_ENV_VARS = ['APCA_API_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_API_SECRET_KEY'];

let alpacaAuthWarned = false;

const orderExecutionRuntime = {
  setEngineState: () => {},
  setLastActionTrace: () => {},
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

function configureOrderExecutionRuntime({ setEngineState, setLastActionTrace, sleep } = {}) {
  if (typeof setEngineState === 'function') {
    orderExecutionRuntime.setEngineState = setEngineState;
  }
  if (typeof setLastActionTrace === 'function') {
    orderExecutionRuntime.setLastActionTrace = setLastActionTrace;
  }
  if (typeof sleep === 'function') {
    orderExecutionRuntime.sleep = sleep;
  }
}

function normalizeTradeBase(baseUrl) {
  if (!baseUrl) return 'https://api.alpaca.markets';
  const trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes('data.alpaca.markets')) {
      console.warn('trade_base_invalid_host', { host: parsed.hostname });
      return 'https://api.alpaca.markets';
    }
  } catch (err) {
    console.warn('trade_base_parse_failed', { baseUrl: trimmed });
  }
  return trimmed.replace(/\/v2$/, '');
}

function normalizeDataBase(baseUrl) {
  if (!baseUrl) return 'https://data.alpaca.markets';
  let trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes('api.alpaca.markets') || parsed.hostname.includes('paper-api.alpaca.markets')) {
      console.warn('data_base_invalid_host', { host: parsed.hostname });
      return 'https://data.alpaca.markets';
    }
  } catch (err) {
    console.warn('data_base_parse_failed', { baseUrl: trimmed });
  }
  trimmed = trimmed.replace(/\/v1beta2$/, '');
  trimmed = trimmed.replace(/\/v1beta3$/, '');
  trimmed = trimmed.replace(/\/v2\/stocks$/, '');
  trimmed = trimmed.replace(/\/v2$/, '');
  return trimmed;
}

function resolveAlpacaAuth() {
  const keyId =
    process.env.APCA_API_KEY_ID ||
    process.env.ALPACA_KEY_ID ||
    process.env.ALPACA_API_KEY_ID ||
    process.env.ALPACA_API_KEY ||
    '';
  const secretKey =
    process.env.APCA_API_SECRET_KEY ||
    process.env.ALPACA_SECRET_KEY ||
    process.env.ALPACA_API_SECRET_KEY ||
    '';
  const alpacaKeyIdPresent = Boolean(keyId);
  const alpacaAuthOk = Boolean(keyId && secretKey);
  const missing = [];
  if (!keyId) missing.push('key id');
  if (!secretKey) missing.push('secret key');
  if (!alpacaAuthWarned && !alpacaAuthOk) {
    console.warn('alpaca_auth_missing', {
      missing,
      checkedKeyVars: ALPACA_KEY_ENV_VARS,
      checkedSecretVars: ALPACA_SECRET_ENV_VARS,
    });
    alpacaAuthWarned = true;
  }
  return {
    keyId: keyId || null,
    secretKey: secretKey || null,
    alpacaAuthOk,
    alpacaKeyIdPresent,
    missing,
    checkedKeyVars: ALPACA_KEY_ENV_VARS,
    checkedSecretVars: ALPACA_SECRET_ENV_VARS,
  };
}

function requireAlpacaAuth() {
  const status = resolveAlpacaAuth();
  if (!status.alpacaAuthOk) {
    const err = new Error('alpaca_auth_missing');
    err.code = 'ALPACA_AUTH_MISSING';
    err.details = {
      missing: status.missing,
      checkedKeyVars: status.checkedKeyVars,
      checkedSecretVars: status.checkedSecretVars,
    };
    throw err;
  }
  return status;
}

function alpacaHeaders() {
  const auth = requireAlpacaAuth();
  const headers = { Accept: 'application/json' };
  headers['APCA-API-KEY-ID'] = auth.keyId;
  headers['APCA-API-SECRET-KEY'] = auth.secretKey;
  return headers;
}

function alpacaJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...alpacaHeaders(),
  };
}

async function placeOrderUnified({
  symbol,
  url,
  payload,
  label = 'orders_submit',
  reason = null,
  context = null,
  intent = null,
}) {
  if (!url) throw new Error('placeOrderUnified: missing url');
  if (!payload) throw new Error('placeOrderUnified: missing payload');

  const retryDelaysMs = [500, 1500];
  let resp;

  try {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        resp = await requestJson({
          url,
          method: 'POST',
          headers: alpacaJsonHeaders(),
          body: JSON.stringify(payload),
        });
        break;
      } catch (err) {
        const statusCode = err?.statusCode ?? err?.status ?? null;
        const retryable = statusCode === 429 || statusCode === 503;
        if (!retryable || attempt >= retryDelaysMs.length) {
          throw err;
        }
        const delayMs = retryDelaysMs[attempt];
        console.log('order_submit_retry', {
          attempt: attempt + 1,
          symbol,
          statusCode,
          delayMs,
        });
        await orderExecutionRuntime.sleep(delayMs);
      }
    }

    const order = resp?.json ?? resp;
    console.log('order_submitted', {
      symbol,
      id: order?.id ?? null,
      client_order_id: payload?.client_order_id ?? null,
      label,
      reason,
      context,
      intent,
    });
    if (String(intent || '').toLowerCase() === 'entry' && String(payload?.side || '').toLowerCase() === 'buy') {
      orderExecutionRuntime.setEngineState('waiting_for_fill', { reason: 'buy_submitted', context: { symbol } });
      orderExecutionRuntime.setLastActionTrace('lastBuySubmit', {
        symbol,
        orderId: order?.id ?? null,
        clientOrderId: payload?.client_order_id ?? null,
        type: payload?.type || null,
      });
    }
    if (String(payload?.side || '').toLowerCase() === 'sell') {
      orderExecutionRuntime.setEngineState('placing_sell', { reason: 'sell_submitted', context: { symbol } });
      orderExecutionRuntime.setLastActionTrace('lastSellSubmit', {
        symbol,
        orderId: order?.id ?? null,
        clientOrderId: payload?.client_order_id ?? null,
        type: payload?.type || null,
      });
    }

    return order;
  } catch (err) {
    const statusCode = err?.statusCode ?? err?.status ?? null;
    const responseText = err?.responseText ?? err?.snippet ?? null;

    if (typeof logHttpError === 'function') {
      logHttpError({
        context: 'placeOrderUnified',
        url,
        method: 'POST',
        statusCode,
        error: err?.message ?? String(err),
        responseText,
        responseHeaders: err?.responseHeaders ?? null,
        extra: {
          symbol,
          label,
          reason,
          context,
          intent,
          payloadPreview: {
            type: payload?.type,
            side: payload?.side,
            time_in_force: payload?.time_in_force,
            qty: payload?.qty,
            notional: payload?.notional,
            limit_price: payload?.limit_price,
            client_order_id: payload?.client_order_id,
          },
        },
      });
    } else {
      console.log('order_submit_failed', {
        symbol,
        label,
        reason,
        context,
        intent,
        statusCode,
        error: err?.message ?? String(err),
        responseText,
      });
    }
    orderExecutionRuntime.setLastActionTrace('lastExecutionFailure', {
      stage: 'order_submit',
      symbol,
      label,
      reason: reason || null,
      message: err?.message || String(err),
      statusCode,
    });
    orderExecutionRuntime.setEngineState('degraded', { reason: 'order_submit_failed', context: { symbol, statusCode } });

    throw err;
  }
}

module.exports = {
  placeOrderUnified,
  alpacaHeaders,
  alpacaJsonHeaders,
  resolveAlpacaAuth,
  requireAlpacaAuth,
  normalizeTradeBase,
  normalizeDataBase,
  configureOrderExecutionRuntime,
};
