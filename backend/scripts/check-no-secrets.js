const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const forbiddenFiles = [path.join(backendRoot, '.env')];
const secretLinePatterns = [
  /^(APCA_API_KEY_ID|ALPACA_KEY_ID|ALPACA_API_KEY_ID|APCA_API_SECRET_KEY|ALPACA_SECRET_KEY|ALPACA_API_SECRET_KEY|API_TOKEN)\s*=\s*(.+)$/i,
];

const isClearlyPlaceholder = (value) => {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return true;
  return v.includes('change_me') || v.includes('example') || v.includes('placeholder') || v.includes('<your') || v === '""' || v === "''";
};

const failures = [];
for (const file of forbiddenFiles) {
  if (fs.existsSync(file)) failures.push(`Forbidden secret file detected: ${path.relative(backendRoot, file) || '.env'}`);
}

function listEnvFilesFromTree(rootDir) {
  const found = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!/\.env(\.|$)/i.test(entry.name)) continue;
      if (entry.name.endsWith('.example')) continue;
      found.push(path.relative(backendRoot, absolutePath));
    }
  };
  walk(rootDir);
  return found;
}

let candidateFiles = [];
try {
  const trackedFiles = execSync('git ls-files', { encoding: 'utf8', cwd: backendRoot })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  candidateFiles = trackedFiles.filter((file) => /\.env(\.|$)/i.test(file) && !file.endsWith('.example'));
} catch (err) {
  candidateFiles = listEnvFilesFromTree(backendRoot);
  console.warn('secret_scan_git_unavailable_fallback_tree_scan', {
    error: err?.message || String(err),
    candidateFileCount: candidateFiles.length,
  });
}

for (const file of candidateFiles) {
  const absolutePath = path.join(backendRoot, file);
  if (!fs.existsSync(absolutePath)) continue;
  const content = fs.readFileSync(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    for (const pattern of secretLinePatterns) {
      const match = trimmed.match(pattern);
      if (!match) continue;
      const value = match[2];
      if (!isClearlyPlaceholder(value)) {
        failures.push(`Potential committed secret in ${file}: ${match[1]}`);
      }
    }
  }
}

if (failures.length) {
  console.error('secret_scan_failed', { failures });
  process.exit(1);
}

console.log('secret_scan_passed');
