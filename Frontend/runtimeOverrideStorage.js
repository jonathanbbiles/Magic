'use strict';

const trim = (value) => String(value == null ? '' : value).trim();

function readPersisted(adapter) {
  if (!adapter || typeof adapter.get !== 'function') return {};
  try {
    const raw = adapter.get();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePersisted(adapter, override) {
  if (!adapter) return;
  try {
    const hasValue = Boolean(override && (override.baseUrl || override.apiToken));
    if (hasValue && typeof adapter.set === 'function') {
      adapter.set(JSON.stringify({
        baseUrl: trim(override.baseUrl) || undefined,
        apiToken: trim(override.apiToken) || undefined,
      }));
    } else if (typeof adapter.remove === 'function') {
      adapter.remove();
    }
  } catch {
    // ignore
  }
}

function createRuntimeOverrideStorage({ adapter, defaults }) {
  const safeDefaults = {
    baseUrl: trim(defaults && defaults.baseUrl),
    apiToken: trim(defaults && defaults.apiToken),
  };
  const persisted = readPersisted(adapter);
  const state = {
    baseUrl: trim(persisted.baseUrl) || safeDefaults.baseUrl,
    apiToken: trim(persisted.apiToken) || safeDefaults.apiToken,
  };

  function get() {
    return { baseUrl: state.baseUrl, apiToken: state.apiToken };
  }

  function set(next) {
    const nextBaseUrl = trim(next && next.baseUrl);
    const nextApiToken = trim(next && next.apiToken);
    state.baseUrl = nextBaseUrl || safeDefaults.baseUrl;
    state.apiToken = nextApiToken;
    writePersisted(adapter, { baseUrl: nextBaseUrl, apiToken: nextApiToken });
    return get();
  }

  return { get, set };
}

function createMemoryAdapter() {
  let value = null;
  return {
    get() { return value; },
    set(v) { value = String(v); },
    remove() { value = null; },
  };
}

function createLocalStorageAdapter(key, storage) {
  return {
    get() {
      try { return storage.getItem(key); } catch { return null; }
    },
    set(value) {
      try { storage.setItem(key, value); } catch { /* ignore */ }
    },
    remove() {
      try { storage.removeItem(key); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  createRuntimeOverrideStorage,
  createMemoryAdapter,
  createLocalStorageAdapter,
};
