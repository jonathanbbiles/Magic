const fs = require('fs');

const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
if (!appJson?.expo?.name) {
  throw new Error('app_json_missing_expo_name');
}
if (!appJson?.expo?.slug) {
  throw new Error('app_json_missing_expo_slug');
}
console.log('frontend_check_ok');
