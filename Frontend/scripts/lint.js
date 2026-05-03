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

console.log('frontend_lint_ok');
