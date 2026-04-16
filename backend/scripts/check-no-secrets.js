const { execSync } = require('child_process');
const fs = require('fs');

const forbiddenFiles = ['backend/.env'];
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
  if (fs.existsSync(file)) failures.push(`Forbidden secret file detected: ${file}`);
}

let trackedFiles = [];
try {
  trackedFiles = execSync('git ls-files', { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
} catch (err) {
  console.error('secret_scan_failed_to_list_files', err?.message || String(err));
  process.exit(1);
}

const candidateFiles = trackedFiles.filter((file) => /\.env(\.|$)/i.test(file) && !file.endsWith('.example'));
for (const file of candidateFiles) {
  const content = fs.readFileSync(file, 'utf8');
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
