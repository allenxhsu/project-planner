// iCalendar (RFC 5545) — enough of it to know when you are busy.
//
// Google Calendar and Outlook both hand out a private ICS address for a
// calendar, which is the one way to read someone's real meetings without an
// OAuth client, a consent screen or a token to keep. That is what this reads:
// events, with times, including the repeating ones — a daily stand-up that did
// not repeat would make the whole exercise pointless.
//
// Deliberately partial, and it says so: VTIMEZONE is not interpreted (times
// are read as local), and the repeat rules are the ones real calendars use —
// DAILY, WEEKLY, MONTHLY and YEARLY with INTERVAL, BYDAY, COUNT and UNTIL.
// Anything cleverer is kept as its first occurrence rather than guessed at.

const DAY_MS = 86400000;
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Unfold the line continuations RFC 5545 requires, then split into lines. */
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/** `DTSTART;TZID=Europe/London:20260921T090000` → name, params, value. */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = left.split(';');
  const params = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/**
 * An ICS date or date-time, as local wall-clock milliseconds.
 *
 * A `Z` time is converted to this machine's local time, which is what someone
 * reading their own calendar means by "9 o'clock". A floating or TZID time is
 * taken at face value for the same reason — guessing at a VTIMEZONE would be
 * worse than reading the number that is written down.
 */
function parseDate(value, params = {}) {
  const v = String(value).trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date) return { ms: new Date(+date[1], +date[2] - 1, +date[3]).getTime(), allDay: true };
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!dt) return null;
  const [, y, mo, d, h, mi, s, z] = dt;
  const ms = z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
    : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return { ms, allDay: params.VALUE === 'DATE' };
}

/** Expand one event's repeat rule across `[from, to]`, in milliseconds. */
function expand(event, rule, from, to, cap = 400) {
  if (!rule) return [event.start];
  const parts = {};
  for (const bit of String(rule).split(';')) {
    const eq = bit.indexOf('=');
    if (eq > 0) parts[bit.slice(0, eq).toUpperCase()] = bit.slice(eq + 1);
  }
  const freq = (parts.FREQ || '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [event.start];
  const interval = Math.max(1, parseInt(parts.INTERVAL, 10) || 1);
  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  const until = parts.UNTIL ? parseDate(parts.UNTIL)?.ms ?? null : null;
  const byDay = (parts.BYDAY || '').split(',').map((d) => BYDAY[d.trim().slice(-2).toUpperCase()]).filter((d) => d !== undefined);

  const out = [];
  const first = new Date(event.start);
  let made = 0;
  for (let step = 0; step < cap * interval && out.length < cap; step++) {
    let when;
    if (freq === 'DAILY') when = new Date(first.getTime() + step * interval * DAY_MS);
    else if (freq === 'WEEKLY') {
      // A weekly rule with BYDAY happens on each named day of each week it covers.
      const weekStartMs = first.getTime() - ((first.getDay() - (byDay.length ? 0 : first.getDay())) * DAY_MS);
      const days = byDay.length ? byDay : [first.getDay()];
      const week = new Date(weekStartMs + step * interval * 7 * DAY_MS);
      for (const wd of days) {
        const at = new Date(week);
        at.setDate(at.getDate() + ((wd - at.getDay() + 7) % 7));
        at.setHours(first.getHours(), first.getMinutes(), first.getSeconds(), 0);
        if (at.getTime() >= event.start && at.getTime() <= to && (until === null || at.getTime() <= until)) out.push(at.getTime());
      }
      if (count !== null && out.length >= count) break;
      if (weekStartMs + step * interval * 7 * DAY_MS > to) break;
      continue;
    } else if (freq === 'MONTHLY') { when = new Date(first); when.setMonth(when.getMonth() + step * interval); }
    else { when = new Date(first); when.setFullYear(when.getFullYear() + step * interval); }

    const ms = when.getTime();
    if (until !== null && ms > until) break;
    if (ms > to) break;
    if (ms >= from - DAY_MS) out.push(ms);
    made++;
    if (count !== null && made >= count) break;
  }
  const unique = [...new Set(out)].sort((a, b) => a - b);
  return count !== null ? unique.slice(0, count) : unique;
}

/**
 * Read an ICS document into events between `from` and `to` (milliseconds).
 *
 * @returns {{ events: Array<{uid, title, start, end, allDay, busy}>, name: string|null, skipped: number }}
 */
export function parseIcs(text, { from = Date.now() - 7 * DAY_MS, to = Date.now() + 120 * DAY_MS } = {}) {
  const lines = unfold(text);
  const events = [];
  let name = null;
  let skipped = 0;
  let current = null;
  let inEvent = false;

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN' && line.value === 'VEVENT') { inEvent = true; current = { busy: true }; continue; }
    if (line.name === 'END' && line.value === 'VEVENT') {
      inEvent = false;
      if (current?.start) {
        const span = current.end && current.end > current.start ? current.end - current.start : (current.allDay ? DAY_MS : 30 * 60000);
        for (const at of expand(current, current.rrule, from, to)) {
          if (at + span < from || at > to) continue;
          events.push({
            uid: current.uid || `${at}`, title: current.title || '(no title)',
            start: at, end: at + span, allDay: !!current.allDay, busy: current.busy !== false,
          });
        }
      } else skipped++;
      current = null;
      continue;
    }
    if (!inEvent) {
      if (line.name === 'X-WR-CALNAME') name = unescape(line.value);
      continue;
    }
    switch (line.name) {
      case 'UID': current.uid = line.value; break;
      case 'SUMMARY': current.title = unescape(line.value); break;
      case 'DTSTART': { const d = parseDate(line.value, line.params); if (d) { current.start = d.ms; current.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(line.value, line.params); if (d) current.end = d.ms; break; }
      case 'RRULE': current.rrule = line.value; break;
      // Anything the organiser marked free, or that was cancelled, is not busy.
      case 'TRANSP': if (line.value.toUpperCase() === 'TRANSPARENT') current.busy = false; break;
      case 'STATUS': if (line.value.toUpperCase() === 'CANCELLED') current.busy = false; break;
      default: break;
    }
  }
  events.sort((a, b) => a.start - b.start);
  return { events, name, skipped };
}
