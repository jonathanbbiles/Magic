#!/usr/bin/env node
// Magic diagnostics MCP server (2026-05-21 PM).
//
// Exposes the trading-bot's debug + dashboard endpoints to a Claude Code
// session via MCP. Zero-dep Node implementation — speaks JSON-RPC 2.0
// over stdio per the MCP protocol spec. No SDK, no npm install needed.
//
// Tools surfaced:
//   - get_diagnostics():  full /dashboard blob (account, positions, meta)
//   - get_logs(opts):     /debug/logs?since=&limit=&level=
//   - get_runtime_config(): /debug/runtime-config (config + git commit)
//   - get_scorecard():    /dashboard/scorecard (closed-trade stats)
//
// Environment:
//   MAGIC_BACKEND_URL  — e.g. https://magic-...onrender.com (required)
//   MAGIC_API_TOKEN    — matches backend's API_TOKEN env (required when
//                         backend has API_TOKEN set, which is the
//                         production default)
//
// Why zero-dep: this server runs inside Claude Code sessions (local +
// web container). Pinning it to no deps means it works the moment the
// repo is cloned — no `npm install` step, no version-pin drift with
// the backend's deps.

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const SERVER_NAME = 'magic-diagnostics';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const BACKEND_URL = String(process.env.MAGIC_BACKEND_URL || '').replace(/\/+$/, '');
const API_TOKEN = String(process.env.MAGIC_API_TOKEN || '').trim();

// HTTP request helper. Returns parsed JSON body or throws with a structured
// error containing the HTTP status + response snippet so the MCP client
// sees actionable failures (not opaque "fetch failed").
function httpRequest({ path, query = null }) {
  if (!BACKEND_URL) {
    return Promise.reject(new Error('MAGIC_BACKEND_URL not set in environment'));
  }
  const url = new URL(`${BACKEND_URL}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const protocol = url.protocol === 'https:' ? https : http;
  const headers = { Accept: 'application/json' };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
  return new Promise((resolve, reject) => {
    const req = protocol.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode} from ${url.pathname}`);
          err.statusCode = res.statusCode;
          err.bodySnippet = raw.slice(0, 500);
          return reject(err);
        }
        try {
          resolve(JSON.parse(raw));
        } catch (parseErr) {
          // Non-JSON response (e.g. /debug/logs is JSON, but a stray HTML
          // 502 page would land here). Surface raw text for visibility.
          resolve({ raw });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after 15s: ${url.pathname}`));
    });
    req.end();
  });
}

// ---- Tool implementations ------------------------------------------------

async function toolGetDiagnostics() {
  const data = await httpRequest({ path: '/dashboard' });
  return data;
}

async function toolGetLogs(args) {
  const params = {
    since: args?.sinceMs || args?.since,
    limit: args?.limit,
    level: args?.level, // 'info' | 'warn' | 'error'
  };
  return httpRequest({ path: '/debug/logs', query: params });
}

async function toolGetRuntimeConfig() {
  return httpRequest({ path: '/debug/runtime-config' });
}

async function toolGetScorecard() {
  return httpRequest({ path: '/dashboard/scorecard' });
}

const TOOLS = [
  {
    name: 'get_diagnostics',
    description:
      'Fetch the full /dashboard diagnostics blob from the running trading bot. '
      + 'Returns the same JSON the operator pastes manually today: account state, '
      + 'positions, meta (backtests, signal selector, gate audits, recommendations), '
      + 'and recent events.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolGetDiagnostics,
  },
  {
    name: 'get_logs',
    description:
      'Fetch recent log entries from the bot\'s in-memory ring buffer. Filter by '
      + 'level (info/warn/error), limit count, or sinceMs timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Optional level filter.' },
        limit: { type: 'number', description: 'Max entries to return (default 200, max 2000).' },
        sinceMs: { type: 'number', description: 'Unix-ms timestamp; entries newer than this only.' },
      },
      additionalProperties: false,
    },
    handler: toolGetLogs,
  },
  {
    name: 'get_runtime_config',
    description:
      'Fetch the bot\'s active runtime config: git commit, effective env values, '
      + 'universe symbols, signal flags. Use to verify what version is deployed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolGetRuntimeConfig,
  },
  {
    name: 'get_scorecard',
    description:
      'Fetch closed-trade scorecard: win rate, avg net pnl, profit factor, '
      + 'tp fill rate, median hold time. Pure summary; cheaper than full diagnostics.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolGetScorecard,
  },
];

// ---- MCP protocol (JSON-RPC 2.0 over stdio) ------------------------------
//
// Spec: https://modelcontextprotocol.io/specification
// Transport: line-delimited JSON, one message per line on stdin/stdout.
// stderr is reserved for server logging — Claude Code surfaces it but
// won't try to parse it as a protocol message.

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function makeErrorResponse(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

function makeResultResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') return null;
  const { method, params, id } = message;

  // Notifications (no id) — handle but never respond.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return null;
    if (method === 'notifications/cancelled') return null;
    return null;
  }

  try {
    if (method === 'initialize') {
      return makeResultResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (method === 'tools/list') {
      return makeResultResponse(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    if (method === 'tools/call') {
      const toolName = params?.name;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return makeErrorResponse(id, -32602, `Unknown tool: ${toolName}`);
      }
      const args = params?.arguments || {};
      try {
        const result = await tool.handler(args);
        return makeResultResponse(id, {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        });
      } catch (toolErr) {
        const errText = toolErr?.statusCode
          ? `HTTP ${toolErr.statusCode}: ${toolErr.bodySnippet || toolErr.message}`
          : (toolErr?.message || String(toolErr));
        return makeResultResponse(id, {
          isError: true,
          content: [{ type: 'text', text: errText }],
        });
      }
    }
    if (method === 'ping') {
      return makeResultResponse(id, {});
    }
    return makeErrorResponse(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    return makeErrorResponse(id, -32603, err?.message || 'Internal error');
  }
}

// Line-buffered stdin reader. Each line is a complete JSON-RPC message.
function startStdinLoop() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newlineIdx;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (parseErr) {
        process.stderr.write(`[mcp-magic] parse error: ${parseErr.message}\n`);
        continue;
      }
      // Handle async, write response when ready.
      Promise.resolve(handleMessage(parsed)).then((response) => {
        if (response) writeMessage(response);
      }).catch((err) => {
        process.stderr.write(`[mcp-magic] handler error: ${err?.stack || err}\n`);
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) {
  if (!BACKEND_URL) {
    process.stderr.write('[mcp-magic] WARNING: MAGIC_BACKEND_URL not set. Tool calls will fail until configured.\n');
  }
  process.stderr.write(`[mcp-magic] ${SERVER_NAME} v${SERVER_VERSION} ready (backend=${BACKEND_URL || 'unset'}, auth=${API_TOKEN ? 'token-set' : 'no-token'})\n`);
  startStdinLoop();
}

module.exports = { TOOLS, handleMessage, httpRequest };
