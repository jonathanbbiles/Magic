const fs = require('fs');
const path = require('path');

const source = fs.readFileSync('App.js', 'utf8');

if (!source.includes('DEFAULT_BACKEND_URL')) {
  throw new Error('missing_default_backend_url_constant');
}
if (!source.includes('EXPO_PUBLIC_BACKEND_URL')) {
  throw new Error('missing_backend_env_reference');
}
if (!source.includes('configBanner')) {
  throw new Error('missing_backend_config_warning_banner');
}
// Regression guard: the runtime-override storage helpers must stay inlined
// in App.js. The Metro/EAS bundler has repeatedly failed to resolve a
// separate ./runtimeOverrideStorage module (see commits b04dd2d / d20ecf8 /
// c9b0fe8), so re-introducing that require/import would break the app on
// device.
if (/require\(['"]\.\/runtimeOverrideStorage(\.js)?['"]\)/.test(source)) {
  throw new Error('app_js_must_not_require_runtime_override_storage');
}
if (/from ['"]\.\/runtimeOverrideStorage(\.js)?['"]/.test(source)) {
  throw new Error('app_js_must_not_import_runtime_override_storage');
}
if (!source.includes('function createRuntimeOverrideStorage(')) {
  throw new Error('app_js_must_inline_create_runtime_override_storage');
}

// Metro/Hermes resolves relative requires by appending `.js`. If the source
// path already includes `.js`, the resolver looks up `foo.js.js` and crashes
// with `Unable to resolve module 'module://foo.js.js'` at runtime even though
// the bundle compiles. Keep helper imports extension-less in every JS file in
// the Frontend directory (App.js, tests, future siblings) — Metro's haste map
// scans the whole tree, so a `.js`-suffixed reference anywhere is enough to
// reintroduce the regression.
const RUNTIME_OVERRIDE_RE = /(?:require\(|from\s+)['"]\.\/runtimeOverrideStorage(\.js)?['"]/g;
const FRONTEND_FILES_TO_SCAN = ['App.js', 'runtimeOverrideStorage.test.js'];

let totalRuntimeOverrideRefs = 0;
for (const relPath of FRONTEND_FILES_TO_SCAN) {
  const absPath = path.resolve(relPath);
  if (!fs.existsSync(absPath)) continue;
  const fileSource = fs.readFileSync(absPath, 'utf8');
  const refs = fileSource.match(RUNTIME_OVERRIDE_RE) || [];
  for (const ref of refs) {
    if (ref.includes('runtimeOverrideStorage.js')) {
      const err = new Error('runtime_override_import_must_not_include_js_extension');
      err.file = relPath;
      err.match = ref;
      throw err;
    }
  }
  totalRuntimeOverrideRefs += refs.length;
}

if (totalRuntimeOverrideRefs === 0) {
  throw new Error('missing_runtime_override_storage_import');
}

console.log('frontend_lint_ok');
