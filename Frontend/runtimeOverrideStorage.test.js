'use strict';

const assert = require('assert');
const {
  createRuntimeOverrideStorage,
  createMemoryAdapter,
  createLocalStorageAdapter,
} = require('./runtimeOverrideStorage.js');

function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

(function defaultsAreUsedWhenEmpty() {
  const store = createRuntimeOverrideStorage({
    adapter: createMemoryAdapter(),
    defaults: { baseUrl: 'https://default.example', apiToken: '' },
  });
  assert.deepStrictEqual(store.get(), {
    baseUrl: 'https://default.example',
    apiToken: '',
  });
})();

(function setRoundTripsBaseUrlAndToken() {
  const adapter = createMemoryAdapter();
  const store = createRuntimeOverrideStorage({
    adapter,
    defaults: { baseUrl: 'https://default.example', apiToken: '' },
  });
  const after = store.set({ baseUrl: 'https://override.example', apiToken: 'tok-123' });
  assert.deepStrictEqual(after, {
    baseUrl: 'https://override.example',
    apiToken: 'tok-123',
  });
  assert.deepStrictEqual(store.get(), after);
})();

(function clearingRevertsToDefaults() {
  const store = createRuntimeOverrideStorage({
    adapter: createMemoryAdapter(),
    defaults: { baseUrl: 'https://default.example', apiToken: '' },
  });
  store.set({ baseUrl: 'https://override.example', apiToken: 'tok-123' });
  const cleared = store.set({ baseUrl: '', apiToken: '' });
  assert.deepStrictEqual(cleared, {
    baseUrl: 'https://default.example',
    apiToken: '',
  });
})();

(function localStoragePersistsAcrossInstances() {
  const ls = fakeLocalStorage();
  const adapterA = createLocalStorageAdapter('mm-test', ls);
  const storeA = createRuntimeOverrideStorage({
    adapter: adapterA,
    defaults: { baseUrl: 'https://default.example', apiToken: '' },
  });
  storeA.set({ baseUrl: 'https://persist.example', apiToken: 'persisted-token' });

  const adapterB = createLocalStorageAdapter('mm-test', ls);
  const storeB = createRuntimeOverrideStorage({
    adapter: adapterB,
    defaults: { baseUrl: 'https://default.example', apiToken: '' },
  });
  assert.deepStrictEqual(storeB.get(), {
    baseUrl: 'https://persist.example',
    apiToken: 'persisted-token',
  });
})();

(function localStorageClearOnEmpty() {
  const ls = fakeLocalStorage();
  const adapter = createLocalStorageAdapter('mm-test', ls);
  const store = createRuntimeOverrideStorage({
    adapter,
    defaults: { baseUrl: 'https://default.example', apiToken: '' },
  });
  store.set({ baseUrl: 'https://something.example', apiToken: 't' });
  assert.ok(ls.getItem('mm-test'), 'storage should have value after set');
  store.set({ baseUrl: '', apiToken: '' });
  assert.strictEqual(ls.getItem('mm-test'), null, 'storage should be cleared when override empty');
})();

(function malformedPersistedJsonIsIgnored() {
  const ls = fakeLocalStorage();
  ls.setItem('mm-test', '{not json');
  const store = createRuntimeOverrideStorage({
    adapter: createLocalStorageAdapter('mm-test', ls),
    defaults: { baseUrl: 'https://default.example', apiToken: '' },
  });
  assert.deepStrictEqual(store.get(), {
    baseUrl: 'https://default.example',
    apiToken: '',
  });
})();

(function trimsWhitespace() {
  const store = createRuntimeOverrideStorage({
    adapter: createMemoryAdapter(),
    defaults: { baseUrl: '', apiToken: '' },
  });
  const after = store.set({ baseUrl: '  https://x.example  ', apiToken: '\ttok\n' });
  assert.deepStrictEqual(after, {
    baseUrl: 'https://x.example',
    apiToken: 'tok',
  });
})();

console.log('runtimeOverrideStorage tests passed');
