// Dates and the working calendar.
//
// The model keeps dates as ISO strings ('2026-09-21'); the scheduler works in
// day numbers (days since 1970-01-01, UTC) so that arithmetic never meets a
// time zone or a daylight-saving jump. Durations are working days.

export const DAY_MS = 86400000;
export const toDay = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS);
export const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (n) => (((n + 4) % 7) + 7) % 7;
export const isoValid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(toDay(s));
export const today = () => fromDay(Math.floor(Date.now() / DAY_MS) + Math.floor(-new Date().getTimezoneOffset() / 1440));

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = MONTH_NAMES.map((m) => m.slice(0, 3));

/** '2026-09-21' → 'Mon 21 Sep 26' style labels. */
export function formatDate(iso, style = 'short') {
  if (!iso) return '';
  const n = toDay(iso);
  const d = new Date(n * DAY_MS);
  const day = d.getUTCDate(), mon = MON[d.getUTCMonth()], y = d.getUTCFullYear();
  if (style === 'short') return `${WEEKDAY_NAMES[weekday(n)].slice(0, 3)} ${day} ${mon} ${String(y).slice(2)}`;
  if (style === 'day') return `${day} ${mon}`;
  if (style === 'month') return `${MONTH_NAMES[d.getUTCMonth()]} ${y}`;
  return `${WEEKDAY_NAMES[weekday(n)]}, ${day} ${MONTH_NAMES[d.getUTCMonth()]} ${y}`;
}

/** Monday on or before day n. */
export const weekStart = (n) => n - ((weekday(n) + 6) % 7);
export function monthStart(n) {
  const d = new Date(n * DAY_MS);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY_MS);
}
export function addMonths(n, k) {
  const d = new Date(n * DAY_MS);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1) / DAY_MS);
}

export const DEFAULT_CALENDAR = { workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [] };

/**
 * A working calendar over day numbers.
 *   isWorking(n)   next(n) / prev(n)  first working day at or after / before n
 *   add(n, k)      k working days after working day n (k may be negative)
 *   between(a, b)  working days in [a, b] inclusive
 */
export function makeCalendar(cal = DEFAULT_CALENDAR) {
  const workDays = new Set((cal.workDays && cal.workDays.length ? cal.workDays : [0, 1, 2, 3, 4, 5, 6]));
  const holidays = new Set((cal.holidays || []).filter(isoValid).map(toDay));
  const isWorking = (n) => workDays.has(weekday(n)) && !holidays.has(n);
  const next = (n) => { let i = 0; while (!isWorking(n) && i++ < 4000) n++; return n; };
  const prev = (n) => { let i = 0; while (!isWorking(n) && i++ < 4000) n--; return n; };
  const add = (n, k) => {
    if (k > 0) { for (let i = 0; i < k; i++) n = next(n + 1); }
    else if (k < 0) { for (let i = 0; i < -k; i++) n = prev(n - 1); }
    return n;
  };
  const between = (a, b) => { let c = 0; for (let n = a; n <= b; n++) if (isWorking(n)) c++; return c; };
  /** Signed working-day distance from a to b: 0 when equal, 1 for the next working day. */
  const distance = (a, b) => (b >= a ? between(a, b) - (isWorking(a) ? 1 : 0) : -(between(b, a) - (isWorking(b) ? 1 : 0)));
  return { isWorking, next, prev, add, between, distance, hoursPerDay: cal.hoursPerDay || 8, workDays, holidays };
}

/** '5d' | '5' | '2w' | '1.5 days' | '8h' → working days. Throws on nonsense. */
export function parseDuration(text, hoursPerDay = 8) {
  const s = String(text ?? '').trim().toLowerCase();
  if (s === '') return 0;
  const m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(d|day|days|w|wk|wks|week|weeks|h|hr|hrs|hour|hours|mo|mon|month|months)?\.?$/);
  if (!m) throw new Error(`“${text}” is not a duration. Use forms like 5d, 2w or 8h.`);
  const n = parseFloat(m[1].replace(',', '.'));
  if (n < 0) throw new Error('A duration cannot be negative.');
  const u = m[2] || 'd';
  let days = n;
  if (u.startsWith('w')) days = n * 5;
  else if (u.startsWith('h')) days = n / hoursPerDay;
  else if (u.startsWith('mo')) days = n * 20;
  return Math.round(days * 100) / 100;
}
export const formatDuration = (days) => (days % 1 ? `${Math.round(days * 100) / 100}d` : `${days}d`);
