const assert = require('assert/strict');
const {
  parseAllowedHoursSpec,
  evaluateTimeOfDayFilter,
} = require('./timeOfDayFilter');

// 1. Empty / '*' / unset -> allowAll
for (const raw of ['', null, undefined, '*', '  ']) {
  const schedule = parseAllowedHoursSpec(raw);
  assert.equal(schedule.allowAll, true, `expected allowAll for ${JSON.stringify(raw)}`);
}

// 2. Plain hour list applies to every day
{
  const schedule = parseAllowedHoursSpec('13,14,15');
  assert.equal(schedule.allowAll, false);
  assert.equal(schedule.dayMask, 0b1111111);
  assert.equal(schedule.hourRanges.length, 3);
}

// 3. Hour range '13-21' parsed as single range
{
  const schedule = parseAllowedHoursSpec('13-21');
  assert.equal(schedule.hourRanges.length, 1);
  assert.equal(schedule.hourRanges[0].lo, 13);
  assert.equal(schedule.hourRanges[0].hi, 21);
}

// 4. Day-then-hour form 'mon-fri:13-21'
{
  const schedule = parseAllowedHoursSpec('mon-fri:13-21');
  assert.equal(schedule.allowAll, false);
  // dayMask bits: sun=0 mon=1 tue=2 wed=3 thu=4 fri=5 sat=6
  // mon-fri = bits 1-5 set => 0b0111110 = 62
  assert.equal(schedule.dayMask, 0b0111110);
}

// 5. Invalid input returns null (so caller can fail open)
for (const raw of ['25-26', 'xyz', 'mon-foo:1-2', 'mon-fri:25']) {
  assert.equal(parseAllowedHoursSpec(raw), null, `expected null for ${JSON.stringify(raw)}`);
}

// 6. evaluateTimeOfDayFilter on a Monday 14:00 UTC with 'mon-fri:13-21' => allowed
{
  const monday14 = new Date('2026-05-25T14:00:00Z'); // Mon
  const schedule = parseAllowedHoursSpec('mon-fri:13-21');
  const result = evaluateTimeOfDayFilter({ now: monday14, schedule });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
}

// 7. Saturday is blocked under 'mon-fri:13-21'
{
  const saturday14 = new Date('2026-05-23T14:00:00Z'); // Sat
  const schedule = parseAllowedHoursSpec('mon-fri:13-21');
  const result = evaluateTimeOfDayFilter({ now: saturday14, schedule });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'time_of_day_blocked');
}

// 8. Hour outside range is blocked
{
  const monday03 = new Date('2026-05-25T03:00:00Z'); // Mon 03:00 UTC
  const schedule = parseAllowedHoursSpec('mon-fri:13-21');
  const result = evaluateTimeOfDayFilter({ now: monday03, schedule });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'time_of_day_blocked');
}

// 9. allowAll always returns ok regardless of time
{
  const schedule = { allowAll: true };
  const result = evaluateTimeOfDayFilter({ now: new Date('2026-05-23T04:00:00Z'), schedule });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'filter_disabled');
}

// 10. Multi-range hour list 'mon-fri:8-11,13-17' admits both ranges
{
  const schedule = parseAllowedHoursSpec('mon-fri:8-11,13-17');
  const mondayMorning = new Date('2026-05-25T09:00:00Z');
  const mondayAfternoon = new Date('2026-05-25T15:00:00Z');
  const mondayLunch = new Date('2026-05-25T12:00:00Z'); // between ranges -> blocked
  assert.equal(evaluateTimeOfDayFilter({ now: mondayMorning, schedule }).ok, true);
  assert.equal(evaluateTimeOfDayFilter({ now: mondayAfternoon, schedule }).ok, true);
  assert.equal(evaluateTimeOfDayFilter({ now: mondayLunch, schedule }).ok, false);
}

console.log('time-of-day filter tests passed');
