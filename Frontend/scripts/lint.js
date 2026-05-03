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

// Metro/Hermes resolves relative requires by appending `.js`. If the source
// path already includes `.js`, the resolver looks up `foo.js.js` and crashes
// with `Unable to resolve module 'module://foo.js.js'` at runtime even though
// the bundle compiles. Keep helper imports extension-less.
const runtimeOverrideRefs = source.match(
  /(?:require\(|from\s+)['"]\.\/runtimeOverrideStorage(\.js)?['"]/g,
);
if (!runtimeOverrideRefs || runtimeOverrideRefs.length === 0) {
  throw new Error('missing_runtime_override_storage_import');
}
for (const ref of runtimeOverrideRefs) {
  if (ref.includes('runtimeOverrideStorage.js')) {
    throw new Error('runtime_override_import_must_not_include_js_extension');
  }
}

console.log('frontend_lint_ok');
