const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sourceScript = path.resolve(__dirname, 'check-no-secrets.js');

function runSecretScan(backendDir) {
  return spawnSync(process.execPath, [path.join(backendDir, 'scripts', 'check-no-secrets.js')], {
    cwd: backendDir,
    encoding: 'utf8',
  });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-no-secrets-test-'));
const backendDir = path.join(tmpRoot, 'backend');
const scriptsDir = path.join(backendDir, 'scripts');
fs.mkdirSync(scriptsDir, { recursive: true });
fs.copyFileSync(sourceScript, path.join(scriptsDir, 'check-no-secrets.js'));

fs.writeFileSync(path.join(backendDir, '.env.example'), 'APCA_API_KEY_ID=example\n');
let result = runSecretScan(backendDir);
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stderr, /secret_scan_git_unavailable_fallback_tree_scan/);
assert.match(result.stdout, /secret_scan_passed/);

fs.writeFileSync(path.join(backendDir, '.env.handoff'), 'APCA_API_KEY_ID=real_secret_value\n');
result = runSecretScan(backendDir);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /secret_scan_failed/);

console.log('check-no-secrets.test.js passed');
