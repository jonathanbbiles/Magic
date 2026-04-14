const fs = require('fs');

const source = fs.readFileSync('App.js', 'utf8');

if (source.includes('magic-lw8t.onrender.com')) {
  throw new Error('unsafe_production_fallback_detected');
}
if (!source.includes('EXPO_PUBLIC_BACKEND_URL')) {
  throw new Error('missing_backend_env_reference');
}
if (!source.includes('configBanner')) {
  throw new Error('missing_backend_config_warning_banner');
}

console.log('frontend_lint_ok');
