// LLM Gate — text-only conviction filter for Phase 1 of the selective engine
// (see backend/modules/selectiveEngine.js).
//
// Wraps Google's Gemini 2.5 Flash REST API (free tier: 10 RPM, 500 RPD,
// vision-capable). Phase 1 uses text-only prompts; vision is a Phase 1.5
// option once the text path validates.
//
// Why this exists:
//   The Phase 1 plan replaces the OHLCV-only signal selector with an
//   event-triggered architecture. When an event fires (e.g. a funding-rate
//   flip), we build a structured feature context and ask the LLM whether
//   this is a high-conviction setup. Only confident YES decisions place
//   trades. The LLM's "decision" is the gate; OHLCV-derived metrics feed
//   the prompt as features, not as veto gates.
//
// Fail-safe behavior (CRITICAL):
//   On ANY error path — network failure, rate-limit, malformed response,
//   missing API key, timeout — the gate returns `{ decision: 'NO', ... }`.
//   We'd rather miss a trade than fire a bad one. The live system is small
//   enough that a missed opportunity costs less than a bad entry.
//
// What this module does NOT do:
//   - Does NOT place trades. selectiveEngine.js owns placement.
//   - Does NOT cache responses. Each call is fresh (the prompt context
//     includes a timestamp anyway).
//   - Does NOT auto-retry on transient errors. One attempt; if it fails,
//     decision=NO and the event is logged.

const DEFAULT_CONFIG = Object.freeze({
  // Gemini model. 2.5 Flash is the current free-tier-friendly model
  // (10 RPM, 500 RPD on the free tier). The :latest alias would also work
  // but pinning to a stable version avoids silent prompt-format drift.
  model: 'gemini-2.5-flash',
  // API base. v1beta is the documented stable endpoint for generateContent.
  apiBase: 'https://generativelanguage.googleapis.com/v1beta',
  // Request timeout. Gemini Flash usually responds in <2s; 15s is a generous
  // ceiling that still lets us fail fast on stalls.
  timeoutMs: 15_000,
  // Minimum confidence (0-100) the LLM must return alongside a YES decision
  // for the engine to act on it. Lower confidence → no trade even on YES.
  // Default 65 is intentionally conservative; tune via env per Phase 1
  // backtest results.
  minConfidence: 65,
  // Hard upper bound on per-trade target / stop the LLM is allowed to set.
  // Defensive: bounds a model that mis-parses the prompt and asks for an
  // unreasonable TP/stop.
  maxTargetBps: 300,
  maxStopBps: 300,
});

// The prompt structure the LLM sees. Designed for JSON-out: we explicitly
// instruct the model to return ONLY a JSON object with the fields we care
// about, and we validate that on response.
function buildPrompt({ symbol, eventContext, features }) {
  const eventLines = Object.entries(eventContext || {})
    .map(([k, v]) => `  ${k}: ${formatVal(v)}`)
    .join('\n');
  const featureLines = Object.entries(features || {})
    .map(([k, v]) => `  ${k}: ${formatVal(v)}`)
    .join('\n');
  return [
    'You are evaluating a candidate cryptocurrency long entry for a small retail account.',
    'Round-trip transaction cost is ~30 bps. Net profit per trade must clear that to be worth taking.',
    'The bot is selective by design — it would rather skip a marginal setup than take it.',
    '',
    `Symbol: ${symbol}`,
    '',
    'Trigger event:',
    eventLines || '  (none)',
    '',
    'Market features (current snapshot):',
    featureLines || '  (none)',
    '',
    'Decide: should the bot enter a long position on this symbol right now?',
    '',
    'Respond with a SINGLE JSON object and nothing else. Schema:',
    '{',
    '  "decision": "YES" | "NO",',
    '  "confidence": integer 0-100,',
    '  "targetBps": integer 30-300 (net take-profit, only if decision=YES; null otherwise),',
    '  "stopBps": integer 30-300 (stop-loss, only if decision=YES; null otherwise),',
    '  "reasoning": "short string explaining the call"',
    '}',
    '',
    'Be conservative. Decision=NO if any of these are true:',
    '- Spread is wide relative to your target (target must clear spread + 30 bps fees).',
    '- The trigger context is ambiguous or stale.',
    '- Momentum is strongly against the direction the trigger implies.',
    '- You are uncertain.',
  ].join('\n');
}

function formatVal(v) {
  if (v == null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NaN';
    return v.toFixed(Math.abs(v) < 1 ? 4 : 2);
  }
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Parse Gemini's response payload (the wire format wraps the text in
// candidates[0].content.parts[0].text). Returns the inner string or null.
function extractResponseText(body) {
  try {
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

// Some models wrap JSON in ```json ... ``` fences. Strip them.
function stripCodeFence(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

function clampBps(raw, max) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, Math.round(n)));
}

function parseDecision(rawText, config = DEFAULT_CONFIG) {
  const cleaned = stripCodeFence(rawText);
  if (!cleaned) return { decision: 'NO', confidence: 0, targetBps: null, stopBps: null, reasoning: 'empty_llm_response' };
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    return { decision: 'NO', confidence: 0, targetBps: null, stopBps: null, reasoning: 'unparseable_llm_response' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { decision: 'NO', confidence: 0, targetBps: null, stopBps: null, reasoning: 'non_object_response' };
  }
  const decisionRaw = String(parsed.decision || '').trim().toUpperCase();
  const decision = decisionRaw === 'YES' ? 'YES' : 'NO';
  const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0)));
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 500) : '';
  if (decision === 'NO') {
    return { decision, confidence, targetBps: null, stopBps: null, reasoning };
  }
  return {
    decision,
    confidence,
    targetBps: clampBps(parsed.targetBps, config.maxTargetBps),
    stopBps: clampBps(parsed.stopBps, config.maxStopBps),
    reasoning,
  };
}

// Async call to Gemini. Returns the same shape parseDecision returns, plus
// `apiCalled: true|false` so the caller can distinguish "LLM said NO" from
// "we never reached the LLM".
//
// Inputs:
//   - symbol         (string)  the Alpaca pair, e.g. 'BTC/USD'
//   - eventContext   (object)  trigger details (funding flip, news, etc.)
//   - features       (object)  market snapshot (price, spread, RSI, EMAs, etc.)
//   - config         (object)  optional overrides on DEFAULT_CONFIG
//   - apiKey         (string)  Gemini API key (otherwise reads GEMINI_API_KEY)
//   - fetchImpl      (fn)      injected for testing
async function evaluate({
  symbol,
  eventContext,
  features,
  config: userConfig = {},
  apiKey = null,
  fetchImpl = null,
} = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const key = apiKey || process.env.GEMINI_API_KEY || '';
  if (!key) {
    return {
      decision: 'NO',
      confidence: 0,
      targetBps: null,
      stopBps: null,
      reasoning: 'no_gemini_api_key_set',
      apiCalled: false,
    };
  }
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) {
    return {
      decision: 'NO',
      confidence: 0,
      targetBps: null,
      stopBps: null,
      reasoning: 'no_fetch_impl_available',
      apiCalled: false,
    };
  }
  if (!symbol || typeof symbol !== 'string') {
    return {
      decision: 'NO',
      confidence: 0,
      targetBps: null,
      stopBps: null,
      reasoning: 'invalid_symbol',
      apiCalled: false,
    };
  }

  const prompt = buildPrompt({ symbol, eventContext, features });
  const url = `${config.apiBase}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      decision: 'NO',
      confidence: 0,
      targetBps: null,
      stopBps: null,
      reasoning: `fetch_error:${err?.name || 'unknown'}`,
      apiCalled: true,
      errorMessage: String(err?.message || err).slice(0, 200),
    };
  }
  clearTimeout(timer);
  if (!res || !res.ok) {
    return {
      decision: 'NO',
      confidence: 0,
      targetBps: null,
      stopBps: null,
      reasoning: `http_error:${res?.status || 'no_response'}`,
      apiCalled: true,
    };
  }
  let payload;
  try { payload = await res.json(); } catch {
    return {
      decision: 'NO',
      confidence: 0,
      targetBps: null,
      stopBps: null,
      reasoning: 'json_parse_error',
      apiCalled: true,
    };
  }
  const text = extractResponseText(payload);
  if (!text) {
    return {
      decision: 'NO',
      confidence: 0,
      targetBps: null,
      stopBps: null,
      reasoning: 'no_text_in_response',
      apiCalled: true,
    };
  }
  const parsed = parseDecision(text, config);
  return { ...parsed, apiCalled: true };
}

module.exports = {
  evaluate,
  parseDecision,
  buildPrompt,
  extractResponseText,
  stripCodeFence,
  DEFAULT_CONFIG,
};
