// Magic diagnostics MCP server tests.
// Zero-dep, no test framework — plain assert + a fake HTTP server stub.

'use strict';

const assert = require('assert/strict');
const http = require('http');

// Stand up a fake backend HTTP server so we don't make real network calls.
function startFakeBackend({ routes }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const handler = routes[url.pathname];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const result = handler(req, url);
      const status = result.status || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function loadServer() {
  delete require.cache[require.resolve('./server')];
  return require('./server');
}

async function test_toolsList_exposesFourTools() {
  const mod = loadServer();
  const resp = await mod.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/list',
  });
  assert.strictEqual(resp.jsonrpc, '2.0');
  assert.strictEqual(resp.id, 1);
  assert.ok(Array.isArray(resp.result.tools));
  assert.strictEqual(resp.result.tools.length, 4);
  const names = resp.result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['get_diagnostics', 'get_logs', 'get_runtime_config', 'get_scorecard']);
}

async function test_initialize_returnsServerInfo() {
  const mod = loadServer();
  const resp = await mod.handleMessage({
    jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  });
  assert.strictEqual(resp.result.protocolVersion, '2024-11-05');
  assert.strictEqual(resp.result.serverInfo.name, 'magic-diagnostics');
  assert.ok(resp.result.capabilities.tools);
}

async function test_unknownMethod_returnsError() {
  const mod = loadServer();
  const resp = await mod.handleMessage({
    jsonrpc: '2.0', id: 3, method: 'unknown/method',
  });
  assert.ok(resp.error);
  assert.strictEqual(resp.error.code, -32601);
}

async function test_notifications_returnNothing() {
  const mod = loadServer();
  const resp = await mod.handleMessage({
    jsonrpc: '2.0', method: 'notifications/initialized',
  });
  assert.strictEqual(resp, null);
}

async function test_toolCall_unknownTool_returnsError() {
  const mod = loadServer();
  const resp = await mod.handleMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nonexistent', arguments: {} },
  });
  assert.ok(resp.error);
  assert.match(resp.error.message, /Unknown tool/);
}

async function test_toolCall_dispatchesToBackend() {
  const { server, port } = await startFakeBackend({
    routes: {
      '/dashboard': (req) => {
        // Verify Auth header propagates.
        assert.strictEqual(req.headers.authorization, 'Bearer test_token_abc');
        return { body: { ok: true, account: { equity: '0' }, meta: { signalSelector: { signalVersion: 'mean_reversion' } } } };
      },
      '/debug/logs': (req, url) => {
        const limit = url.searchParams.get('limit');
        const level = url.searchParams.get('level');
        return { body: { ok: true, count: 1, entries: [{ ts: 0, level: level || 'info', msg: 'test' }], echo: { limit, level } } };
      },
      '/debug/runtime-config': () => ({ body: { ok: true, version: 'abc123' } }),
      '/dashboard/scorecard': () => ({ body: { totalClosedTrades: 130, winRate: 0.369 } }),
    },
  });
  try {
    process.env.MAGIC_BACKEND_URL = `http://127.0.0.1:${port}`;
    process.env.MAGIC_API_TOKEN = 'test_token_abc';
    const mod = loadServer();

    // get_diagnostics
    const diagResp = await mod.handleMessage({
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_diagnostics', arguments: {} },
    });
    assert.ok(diagResp.result.content);
    const diagPayload = JSON.parse(diagResp.result.content[0].text);
    assert.strictEqual(diagPayload.meta.signalSelector.signalVersion, 'mean_reversion');

    // get_logs with filter args
    const logsResp = await mod.handleMessage({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'get_logs', arguments: { level: 'warn', limit: 50 } },
    });
    const logsPayload = JSON.parse(logsResp.result.content[0].text);
    assert.strictEqual(logsPayload.echo.level, 'warn');
    assert.strictEqual(logsPayload.echo.limit, '50');

    // get_runtime_config
    const cfgResp = await mod.handleMessage({
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_runtime_config', arguments: {} },
    });
    const cfgPayload = JSON.parse(cfgResp.result.content[0].text);
    assert.strictEqual(cfgPayload.version, 'abc123');

    // get_scorecard
    const sc = await mod.handleMessage({
      jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_scorecard', arguments: {} },
    });
    const scPayload = JSON.parse(sc.result.content[0].text);
    assert.strictEqual(scPayload.totalClosedTrades, 130);
  } finally {
    server.close();
    delete process.env.MAGIC_BACKEND_URL;
    delete process.env.MAGIC_API_TOKEN;
  }
}

async function test_toolCall_backendError_returnsIsError() {
  const { server, port } = await startFakeBackend({
    routes: {
      '/dashboard': () => ({ status: 401, body: { error: 'unauthorized' } }),
    },
  });
  try {
    process.env.MAGIC_BACKEND_URL = `http://127.0.0.1:${port}`;
    process.env.MAGIC_API_TOKEN = 'wrong';
    const mod = loadServer();
    const resp = await mod.handleMessage({
      jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'get_diagnostics', arguments: {} },
    });
    assert.strictEqual(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /HTTP 401/);
  } finally {
    server.close();
    delete process.env.MAGIC_BACKEND_URL;
    delete process.env.MAGIC_API_TOKEN;
  }
}

async function test_noBackendUrl_returnsClearError() {
  delete process.env.MAGIC_BACKEND_URL;
  delete process.env.MAGIC_API_TOKEN;
  const mod = loadServer();
  const resp = await mod.handleMessage({
    jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'get_diagnostics', arguments: {} },
  });
  assert.strictEqual(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /MAGIC_BACKEND_URL not set/);
}

(async () => {
  await test_toolsList_exposesFourTools();
  await test_initialize_returnsServerInfo();
  await test_unknownMethod_returnsError();
  await test_notifications_returnNothing();
  await test_toolCall_unknownTool_returnsError();
  await test_toolCall_dispatchesToBackend();
  await test_toolCall_backendError_returnsIsError();
  await test_noBackendUrl_returnsClearError();
  console.log('mcp-magic-diagnostics tests passed', { tests: 8 });
})().catch((err) => {
  console.error('mcp-magic-diagnostics tests FAILED', err);
  process.exit(1);
});
