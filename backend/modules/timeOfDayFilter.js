// Time-of-day entry filter (2026-05-28) — meta-layer that gates entries by
// hour-of-week. Wraps every signal; not a signal itself. Crypto has
// documented intraday seasonality (Asian / European / US sessions, weekend
// liquidity drops). Restricting entries to high-quality hours can lift
// expectancy without changing any signal math.
//
// Default-OFF (allowedHoursMask='*'). Operator opts in by setting
// TIME_OF_DAY_ALLOWED_HOURS_UTC to a comma-separated list of UTC hours
// (e.g. '13,14,15,16,17,18,19,20,21' for the US session 13:00-21:00 UTC).
//
// Format options:
//   '*'                    -> allow all hours (filter is a no-op)
//   '13,14,15,16'          -> allow only those hours-of-day UTC, every day
//   'mon-fri:13-21'        -> allow Mon-Fri 13:00-21:00 UTC (range form)
//   'mon-sun:0-23'         -> allow all (equivalent to '*')
//
// The filter exposes its decision so callers can log/forensics it. When
// the filter rejects, the entry is skipped with reason 'time_of_day_blocked'.
//
// Wired into `scanAndEnter` in trade.js immediately after signal evaluation
// passes (so it observes only would-be entries — same placement discipline
// as the regime veto). Backtester reads the same env via
// `backtestEnvFallbacks.js` so live and backtest agree on which hours fire.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseHourRange(spec) {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('-')) {
    const [lo, hi] = trimmed.split('-').map((s) => Number(s.trim()));
    if (!isFiniteNumber(lo) || !isFiniteNumber(hi)) return null;
    if (lo < 0 || hi > 23 || lo > hi) return null;
    return { lo: Math.floor(lo), hi: Math.floor(hi) };
  }
  const single = Number(trimmed);
  if (!isFiniteNumber(single) || single < 0 || single > 23) return null;
  return { lo: Math.floor(single), hi: Math.floor(single) };
}

function parseDayRange(spec) {
  const trimmed = String(spec || '').trim().toLowerCase();
  if (!trimmed || trimmed === '*') return { dayMask: 0b1111111 };
  let mask = 0;
  for (const piece of trimmed.split(',')) {
    const cleaned = piece.trim();
    if (!cleaned) continue;
    if (cleaned.includes('-')) {
      const [lo, hi] = cleaned.split('-').map((s) => DAY_NAMES.indexOf(s.trim()));
      if (lo < 0 || hi < 0 || lo > hi) return null;
      for (let i = lo; i <= hi; i += 1) mask |= 1 << i;
    } else {
      const idx = DAY_NAMES.indexOf(cleaned);
      if (idx < 0) return null;
      mask |= 1 << idx;
    }
  }
  return mask === 0 ? null : { dayMask: mask };
}

// Returns a parsed schedule object or null when the input is unparseable
// (caller should treat unparseable as 'allow all' to fail open).
function parseAllowedHoursSpec(rawSpec) {
  const spec = String(rawSpec ?? '').trim();
  if (!spec || spec === '*') return { allowAll: true };

  // Detect "days:hours" form vs "hours" form.
  if (spec.includes(':')) {
    const [dayPart, hourPart] = spec.split(':');
    const days = parseDayRange(dayPart);
    if (!days) return null;
    const hourRanges = [];
    for (const piece of String(hourPart || '').split(',')) {
      const range = parseHourRange(piece);
      if (range) hourRanges.push(range);
    }
    if (hourRanges.length === 0) return null;
    return { allowAll: false, dayMask: days.dayMask, hourRanges };
  }

  // Plain hour list/range form — applies to every day of the week.
  const hourRanges = [];
  for (const piece of spec.split(',')) {
    const range = parseHourRange(piece);
    if (range) hourRanges.push(range);
  }
  if (hourRanges.length === 0) return null;
  return { allowAll: false, dayMask: 0b1111111, hourRanges };
}

function isHourAllowed(schedule, dayOfWeek, hourOfDay) {
  if (!schedule || schedule.allowAll) return true;
  if (!isFiniteNumber(dayOfWeek) || !isFiniteNumber(hourOfDay)) return true;
  if (((schedule.dayMask || 0) & (1 << dayOfWeek)) === 0) return false;
  for (const range of schedule.hourRanges || []) {
    if (hourOfDay >= range.lo && hourOfDay <= range.hi) return true;
  }
  return false;
}

// Pure decision function. Returns:
//   { ok: true,  reason: null,                 dayOfWeek, hourOfDay }    -> entry allowed
//   { ok: false, reason: 'time_of_day_blocked', dayOfWeek, hourOfDay }   -> blocked
//   { ok: true,  reason: 'filter_disabled',     dayOfWeek, hourOfDay }   -> allowAll
function evaluateTimeOfDayFilter({ now = null, schedule = null } = {}) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  const dayOfWeek = date.getUTCDay();
  const hourOfDay = date.getUTCHours();
  const parsed = schedule || { allowAll: true };
  if (parsed.allowAll) {
    return { ok: true, reason: 'filter_disabled', dayOfWeek, hourOfDay };
  }
  const allowed = isHourAllowed(parsed, dayOfWeek, hourOfDay);
  return {
    ok: allowed,
    reason: allowed ? null : 'time_of_day_blocked',
    dayOfWeek,
    hourOfDay,
  };
}

module.exports = {
  parseAllowedHoursSpec,
  evaluateTimeOfDayFilter,
  isHourAllowed,
  DAY_NAMES,
};
