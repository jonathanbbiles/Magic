const fs = require('fs');

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

console.log('frontend_lint_ok');
