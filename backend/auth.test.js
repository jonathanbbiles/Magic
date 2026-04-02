const assert = require('assert/strict');
const { requireApiToken } = require('./auth');

function mockReq(headers = {}) {
  return {
    get(name) {
      return headers[String(name).toLowerCase()] || headers[name] || undefined;
    },
  };
}

(function testHintText() {
  const previous = process.env.API_TOKEN;
  process.env.API_TOKEN = 'backend_token_123456789';
  const req = mockReq({ authorization: 'Bearer wrong-token' });
  const response = {
    headers: {},
    statusCode: 200,
    payload: null,
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  let nextCalled = false;
  requireApiToken(req, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 401);
  assert.match(response.payload?.hint || '', /EXPO_PUBLIC_API_TOKEN/);
  assert.match(response.payload?.hint || '', /EXPO_PUBLIC_BACKEND_URL/);
  assert.match(response.payload?.hint || '', /API_TOKEN on the backend/);
  if (previous === undefined) {
    delete process.env.API_TOKEN;
  } else {
    process.env.API_TOKEN = previous;
  }
})();

(function testAllowsWhenApiTokenMissing() {
  const previous = process.env.API_TOKEN;
  delete process.env.API_TOKEN;
  const req = mockReq({});
  const response = {
    headers: {},
    statusCode: 200,
    payload: null,
    set() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  let nextCalled = false;
  requireApiToken(req, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload, null);
  if (previous !== undefined) process.env.API_TOKEN = previous;
})();

(function testEnforcesWhenApiTokenPresent() {
  const previous = process.env.API_TOKEN;
  process.env.API_TOKEN = 'backend_token_123456789';
  const req = mockReq({ 'x-api-key': 'backend_token_123456789' });
  const response = {
    headers: {},
    statusCode: 200,
    payload: null,
    set() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  let nextCalled = false;
  requireApiToken(req, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload, null);
  if (previous === undefined) {
    delete process.env.API_TOKEN;
  } else {
    process.env.API_TOKEN = previous;
  }
})();

console.log('auth.test.js passed');
