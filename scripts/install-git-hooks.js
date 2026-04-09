#!/usr/bin/env node
/**
 * Configure git to use the repo-tracked hooks in .git-hooks.
 * Idempotent and safe to run from any subdirectory.
 * Silently skips when:
 *   - we're not in a git working tree (e.g. running inside a Docker build)
 *   - we're in CI (hooks are not useful there)
 *   - .git-hooks/ isn't present
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function log(msg) {
  // Prefix so it's obvious in npm install output.
  console.log(`[install-git-hooks] ${msg}`);
}

if (process.env.CI) {
  log('CI detected, skipping.');
  process.exit(0);
}

let repoRoot;
try {
  repoRoot = execSync('git rev-parse --show-toplevel', {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch (_) {
  log('not a git repo, skipping.');
  process.exit(0);
}

const hooksDir = path.join(repoRoot, '.git-hooks');
if (!fs.existsSync(hooksDir)) {
  log(`${hooksDir} missing, skipping.`);
  process.exit(0);
}

try {
  const current = execSync('git config --get core.hooksPath', {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
  if (current === '.git-hooks') {
    log('core.hooksPath already set.');
  } else {
    execSync('git config core.hooksPath .git-hooks', { cwd: repoRoot });
    log('core.hooksPath set to .git-hooks.');
  }
} catch (_) {
  // `git config --get` exits non-zero when unset.
  execSync('git config core.hooksPath .git-hooks', { cwd: repoRoot });
  log('core.hooksPath set to .git-hooks.');
}

// Ensure the hook is executable.
try {
  const hook = path.join(hooksDir, 'pre-commit');
  if (fs.existsSync(hook)) {
    fs.chmodSync(hook, 0o755);
  }
} catch (err) {
  log(`chmod warning: ${err.message}`);
}
