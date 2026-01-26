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

const clearAlpacaEnv = () => {
  ALPACA_ENV_KEYS.forEach((key) => {
    delete process.env[key];
  });
};

const requestJson = (port, path) =>
  new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch (err) {
          payload = null;
        }
        resolve({ status: res.statusCode, payload });
      });
    });
    req.on('error', reject);
  });

const waitForHealth = async (port) => {
  const attempts = 20;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await requestJson(port, '/health');
      if (res.status === 200 && res.payload?.ok) return res;
    } catch (err) {
      // ignore until retries exhausted
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server did not respond to /health');
};

(async () => {
  clearAlpacaEnv();
  try {
    delete require.cache[require.resolve('./trade')];
    require('./trade');
  } catch (err) {
    console.error('trade_require_failed', err);
    process.exit(1);
  }

  const port = 3105;
  const env = { ...process.env, PORT: String(port), API_TOKEN: 'test-token' };
  ALPACA_ENV_KEYS.forEach((key) => {
    delete env[key];
  });

  const child = spawn('node', ['index.js'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(port);
    const status = await requestJson(port, '/debug/status');
    if (status.status !== 200 || !status.payload?.ok) {
      throw new Error('Expected /debug/status to return ok:true');
    }
    console.log('startup_test_ok');
  } catch (err) {
    console.error('startup_test_failed', err);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
