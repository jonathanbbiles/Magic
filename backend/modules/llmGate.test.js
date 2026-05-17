const assert = require('assert/strict');
const {
  evaluate,
  parseDecision,
  buildPrompt,
  extractResponseText,
  stripCodeFence,
  DEFAULT_CONFIG,
} = require('./llmGate');

// 1. buildPrompt produces a string containing the symbol and event lines.
{
  const prompt = buildPrompt({
    symbol: 'BTC/USD',
    eventContext: { source: 'binance_usdm', direction: 'neg_to_pos', latestBps: 8 },
    features: { price: 84000, spreadBps: 6, rsi14: 41 },
  });
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.includes('BTC/USD'));
  assert.ok(prompt.includes('direction: neg_to_pos'));
  assert.ok(prompt.includes('spreadBps:'));
  assert.ok(prompt.includes('JSON'));
}

// 2. parseDecision parses a clean YES response.
{
  const r = parseDecision('{"decision":"YES","confidence":80,"targetBps":100,"stopBps":80,"reasoning":"good setup"}');
  assert.equal(r.decision, 'YES');
  assert.equal(r.confidence, 80);
  assert.equal(r.targetBps, 100);
  assert.equal(r.stopBps, 80);
  assert.equal(r.reasoning, 'good setup');
}

// 3. parseDecision parses a clean NO response with null targets.
{
  const r = parseDecision('{"decision":"NO","confidence":20,"targetBps":null,"stopBps":null,"reasoning":"spread too wide"}');
  assert.equal(r.decision, 'NO');
  assert.equal(r.confidence, 20);
  assert.equal(r.targetBps, null);
  assert.equal(r.stopBps, null);
}

// 4. parseDecision strips ```json fences (some Gemini responses include them).
{
  const r = parseDecision('```json\n{"decision":"YES","confidence":75,"targetBps":120,"stopBps":90,"reasoning":"x"}\n```');
  assert.equal(r.decision, 'YES');
  assert.equal(r.confidence, 75);
  assert.equal(r.targetBps, 120);
}

// 5. parseDecision returns NO on unparseable text.
{
  const r = parseDecision('not json at all');
  assert.equal(r.decision, 'NO');
  assert.equal(r.confidence, 0);
  assert.equal(r.reasoning, 'unparseable_llm_response');
}

// 6. parseDecision returns NO on empty text.
{
  const r = parseDecision('');
  assert.equal(r.decision, 'NO');
  assert.equal(r.reasoning, 'empty_llm_response');
}

// 7. parseDecision clamps absurd targetBps to the cap.
{
  const r = parseDecision('{"decision":"YES","confidence":90,"targetBps":99999,"stopBps":5000,"reasoning":"x"}');
  assert.equal(r.decision, 'YES');
  assert.equal(r.targetBps, DEFAULT_CONFIG.maxTargetBps);
  assert.equal(r.stopBps, DEFAULT_CONFIG.maxStopBps);
}

// 8. parseDecision treats unknown decision string as NO.
{
  const r = parseDecision('{"decision":"MAYBE","confidence":50,"reasoning":"x"}');
  assert.equal(r.decision, 'NO');
}

// 9. extractResponseText pulls text from Gemini's nested shape.
{
  const text = extractResponseText({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] });
  assert.equal(text, 'hello');
}
{
  const text = extractResponseText({ candidates: [] });
  assert.equal(text, null);
}
{
  const text = extractResponseText(null);
  assert.equal(text, null);
}

// 10. stripCodeFence strips both ```json and bare ``` fences.
{
  assert.equal(stripCodeFence('```json\n{}\n```'), '{}');
  assert.equal(stripCodeFence('```\n{}\n```'), '{}');
  assert.equal(stripCodeFence('{}'), '{}');
  assert.equal(stripCodeFence('  {"a":1}  '), '{"a":1}');
}

// 11. evaluate with no apiKey returns NO without calling fetch.
async function testNoApiKey() {
  // Wipe env; explicitly pass apiKey=null so no key resolves.
  const old = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  let fetchCalled = false;
  const r = await evaluate({
    symbol: 'BTC/USD',
    eventContext: {},
    features: {},
    fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; },
  });
  if (old != null) process.env.GEMINI_API_KEY = old;
  assert.equal(r.decision, 'NO');
  assert.equal(r.reasoning, 'no_gemini_api_key_set');
  assert.equal(r.apiCalled, false);
  assert.equal(fetchCalled, false);
}

// 12. evaluate with a successful YES response returns YES with parsed fields.
async function testYesResponse() {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{ text: '{"decision":"YES","confidence":78,"targetBps":110,"stopBps":80,"reasoning":"funding flip + RSI<50"}' }],
        },
      }],
    }),
  });
  const r = await evaluate({
    symbol: 'BTC/USD',
    eventContext: { source: 'binance_usdm', direction: 'neg_to_pos' },
    features: { price: 84000, spreadBps: 5 },
    apiKey: 'test_key',
    fetchImpl: fakeFetch,
  });
  assert.equal(r.decision, 'YES');
  assert.equal(r.confidence, 78);
  assert.equal(r.targetBps, 110);
  assert.equal(r.stopBps, 80);
  assert.equal(r.apiCalled, true);
}

// 13. evaluate maps HTTP non-2xx to NO.
async function testHttpError() {
  const fakeFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const r = await evaluate({
    symbol: 'BTC/USD',
    eventContext: {},
    features: {},
    apiKey: 'test_key',
    fetchImpl: fakeFetch,
  });
  assert.equal(r.decision, 'NO');
  assert.ok(r.reasoning.startsWith('http_error:429'));
  assert.equal(r.apiCalled, true);
}

// 14. evaluate maps fetch throw to NO.
async function testFetchThrow() {
  const fakeFetch = async () => { throw new Error('network down'); };
  const r = await evaluate({
    symbol: 'BTC/USD',
    eventContext: {},
    features: {},
    apiKey: 'test_key',
    fetchImpl: fakeFetch,
  });
  assert.equal(r.decision, 'NO');
  assert.ok(r.reasoning.startsWith('fetch_error:'));
  assert.equal(r.apiCalled, true);
}

// 15. evaluate maps malformed payload to NO.
async function testMalformedPayload() {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'lol not json' }] } }] }),
  });
  const r = await evaluate({
    symbol: 'BTC/USD',
    eventContext: {},
    features: {},
    apiKey: 'test_key',
    fetchImpl: fakeFetch,
  });
  assert.equal(r.decision, 'NO');
  assert.equal(r.reasoning, 'unparseable_llm_response');
}

(async () => {
  await testNoApiKey();
  await testYesResponse();
  await testHttpError();
  await testFetchThrow();
  await testMalformedPayload();
  console.log('llmGate tests passed');
})().catch((err) => {
  console.error('llmGate tests FAILED:', err);
  process.exit(1);
});
