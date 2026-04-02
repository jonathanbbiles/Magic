const http = require('http');
const { spawn } = require('child_process');

const ALPACA_ENV_KEYS = [
  'APCA_API_KEY_ID',
  'ALPACA_KEY_ID',
  'ALPACA_API_KEY_ID',
  'ALPACA_API_KEY',
  'APCA_API_SECRET_KEY',
  'ALPACA_SECRET_KEY',
  'ALPACA_API_SECRET_KEY',
];

const requestJson = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let payload = null;
        try { payload = body ? JSON.parse(body) : null; } catch (_) { payload = null; }
        resolve({ status: res.statusCode, payload, body });
      });
    });
    req.on('error', reject);
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnServer({ port, envOverrides = {} }) {
  const env = { ...process.env, PORT: String(port), ...envOverrides };
  const child = spawn('node', ['index.js'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { stdout: '', stderr: '', exitCode: null, signal: null };
  child.stdout.on('data', (chunk) => { state.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { state.stderr += chunk.toString(); });
  child.on('exit', (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
  });
  return { child, state };
}

async function waitForHealth(port, state, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exitCode !== null || state.signal !== null) {
      throw new Error('server_exited_before_health');
    }
    try {
      const res = await requestJson(port, '/health');
      if (res.status === 200 && res.payload?.ok) return res;
    } catch (_) {
      // keep polling
    }
    await delay(200);
  }
  throw new Error('server_health_timeout');
}

async function expectStartupFailure({ envOverrides, mustContain }) {
  const port = 3110;
  const { child, state } = spawnServer({ port, envOverrides });
  try {
    await delay(1500);
    if (state.exitCode === null && state.signal === null) {
      child.kill();
      throw new Error(`Expected startup failure but process is still running. stdout=${state.stdout} stderr=${state.stderr}`);
    }
    const combined = `${state.stdout}\n${state.stderr}`;
    if (!combined.includes(mustContain)) {
      throw new Error(`Expected failure output to include "${mustContain}". stdout=${state.stdout} stderr=${state.stderr}`);
    }
  } finally {
    child.kill();
  }
}

async function expectStartupSuccessNoApiToken() {
  const port = 3111;
  const envOverrides = {
    NODE_ENV: 'production',
    TRADE_BASE: 'https://api.alpaca.markets',
    DATA_BASE: 'https://data.alpaca.markets',
    APCA_API_KEY_ID: 'pk_live_realistic_key_123456',
    APCA_API_SECRET_KEY: 'sk_live_realistic_secret_abcdef123456',
  };
  delete envOverrides.API_TOKEN;
  const { child, state } = spawnServer({ port, envOverrides });
  try {
    await waitForHealth(port, state);
    const status = await requestJson(port, '/debug/auth');
    if (status.status !== 200 || !status.payload?.ok) {
      throw new Error(`Expected /debug/auth to return ok:true without API_TOKEN. got=${status.status} body=${status.body}`);
    }
    if (status.payload?.apiTokenSet !== false) {
      throw new Error(`Expected apiTokenSet=false, got ${JSON.stringify(status.payload)}`);
    }
    await delay(600);
    if (!state.stdout.includes('startup_truth_summary')) {
      throw new Error(`Expected startup_truth_summary log. stdout=${state.stdout}`);
    }
    if (!state.stdout.includes("effectiveTradeBase: 'https://api.alpaca.markets'")) {
      throw new Error(`Expected live TRADE_BASE in startup log. stdout=${state.stdout}`);
    }
    if (!state.stdout.includes("effectiveDataBase: 'https://data.alpaca.markets'")) {
      throw new Error(`Expected live DATA_BASE in startup log. stdout=${state.stdout}`);
    }
  } finally {
    child.kill();
  }
}

(async () => {
  ALPACA_ENV_KEYS.forEach((key) => delete process.env[key]);

  await expectStartupFailure({
    envOverrides: {
      NODE_ENV: 'production',
      TRADE_BASE: 'https://api.alpaca.markets',
      DATA_BASE: 'https://data.alpaca.markets',
    },
    mustContain: 'APCA_API_KEY_ID/ALPACA_KEY_ID is required and cannot be empty',
  });

  await expectStartupFailure({
    envOverrides: {
      NODE_ENV: 'production',
      TRADE_BASE: 'https://api.alpaca.markets',
      DATA_BASE: 'https://data.alpaca.markets',
      APCA_API_KEY_ID: '<your alpaca key id>',
      APCA_API_SECRET_KEY: '<your alpaca secret>',
    },
    mustContain: 'appears to be a placeholder value in production/live mode',
  });

  await expectStartupSuccessNoApiToken();

  console.log('startup_test_ok');
})().catch((err) => {
  console.error('startup_test_failed');
  console.error(err?.message || err);
  process.exitCode = 1;
});
