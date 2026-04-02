// Shared env boolean parser.
// Accepts: true/false, 1/0, yes/no, on/off, y/n (case-insensitive).
function readEnvFlag(name, defaultValue = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'n' || raw === 'off') return false;
  return defaultValue;
}

module.exports = {
  readEnvFlag,
};
