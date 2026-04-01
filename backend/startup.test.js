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

const requestJson = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch (_) {
          payload = null;
        }
        resolve({ status: res.statusCode, payload });
      });
    });
    req.on('error', reject);
  });

const formatFailure = (message, childState) => {
  const lines = [message];
  if (childState.exitCode !== null || childState.signal !== null) {
    lines.push(`childExitCode=${childState.exitCode} childSignal=${childState.signal}`);
  }
  lines.push(`--- child stdout ---\n${childState.stdout || '(empty)'}`);
  lines.push(`--- child stderr ---\n${childState.stderr || '(empty)'}`);
  return lines.join('\n');
};

const waitForHealth = async (port, childState) => {
  const deadlineMs = Date.now() + 12000;
  while (Date.now() < deadlineMs) {
    if (childState.exitCode !== null || childState.signal !== null) {
      throw new Error(formatFailure('Server exited before /health became ready.', childState));
    }
    try {
      const res = await requestJson(port, '/health');
      if (res.status === 200 && res.payload?.ok) return res;
    } catch (_) {
      // retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(formatFailure('Server did not respond to /health within 12 seconds.', childState));
};

(async () => {
  clearAlpacaEnv();

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

  const childState = { stdout: '', stderr: '', exitCode: null, signal: null };
  child.stdout.on('data', (chunk) => {
    childState.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    childState.stderr += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    childState.exitCode = code;
    childState.signal = signal;
  });

  try {
    await waitForHealth(port, childState);
    const status = await requestJson(port, '/debug/status', { 'x-api-token': 'test-token' });
    if (status.status !== 200 || !status.payload?.ok) {
      throw new Error(formatFailure('Expected /debug/status to return ok:true.', childState));
    }
    console.log('startup_test_ok');
  } catch (err) {
    console.error('startup_test_failed');
    console.error(err?.message || err);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
