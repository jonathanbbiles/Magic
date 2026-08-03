'use strict';
// Pure redaction of sensitive account/position fields from public diagnostics
// endpoints, for UNauthenticated callers only (2026-06-30). Kept pure + isolated
// so it is hermetically testable; index.js owns the auth check and applies this
// to /dashboard, /debug/status and /monitor response bodies.
function redactDiagnosticsBody(pathName, body) {
  if (!body || typeof body !== 'object') return body;
  if (pathName === '/dashboard') {
    // Paper venue is a virtual portfolio filled on public prices — there is no
    // real money, no credentials, and nothing sensitive to protect. Return it
    // intact so the read-only monitor works without a token. (Redaction exists
    // to keep an anonymous caller from seeing a LIVE account's equity.)
    if (body.account && body.account.raw_venue === 'paper') return body;
    const out = { ...body, account: null, positions: [], redacted: true };
    if (out.meta && typeof out.meta === 'object') {
      out.meta = { ...out.meta, weekAgoEquity: null, latestEquity: null, equityChanges: null };
    }
    return out;
  }
  if (pathName === '/debug/status') {
    const out = { ...body, redacted: true };
    if (out.diagnostics && typeof out.diagnostics === 'object') {
      out.diagnostics = { ...out.diagnostics, openPositions: [], openOrders: [] };
    }
    return out;
  }
  if (pathName === '/monitor') {
    return { ...body, latest: null, heartbeats: [], alerts: [], redacted: true };
  }
  return body;
}
module.exports = { redactDiagnosticsBody };
