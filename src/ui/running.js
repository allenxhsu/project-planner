// Parallel tracks: several things under way at once — the washer on, the
// kitchen half tidied, an assistant chewing on a document — each needing a
// look now and then. A task is running once it is started (Start task now):
// a live block from the minute it began to the minute it is meant to end.
//
// Three ways to keep an eye on them, sharing what is here:
//   - the track strip (a day view layout): each task of the day a row against
//     the hours, running ones lit, with how long is left;
//   - the running dock (a day view layout): the day's calendar, and beside it
//     a card per running task, with Stop, Done and Open;
//   - the control board (its own view, Running): a big timer per running task
//     over a slim strip of the day.
// At work, a home project's running task is only counted, never named (state/mode.js).

import { el } from '../util.js';
import { store, set } from '../state/store.js';
import { toDay, today, fromDay } from '../model/calendar.js';
import { formatClock } from '../model/agenda.js';
import { visibilityOf } from '../state/mode.js';
import { checkInsOf } from '../model/model.js';
import { currentLayout, personColour, planPalette } from './calendar.js';

const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const span = (m) => { const a = Math.abs(Math.round(m)); return a < 60 ? `${a}m` : `${Math.floor(a / 60)}h${a % 60 ? ` ${a % 60}m` : ''}`; };

/** Everything the three views need about today: its blocks, the running ones, who is where. */
export function todaysTracks() {
  const { entries, history = [], all } = currentLayout();
  const known = [...entries, ...history];
  const day = toDay(today());
  const now = nowMinutes();
  const entryOf = (planId) => known.find((e) => e.project.id === planId);
  const hidden = (planId) => visibilityOf(entryOf(planId)?.project.workspaceId) === 'hide';
  const palette = planPalette(entries);
  const describe = (b) => {
    const e = entryOf(b.planId);
    const t = e?.project.tasks.find((x) => x.id === b.taskId);
    return {
      block: b, planId: b.planId, taskId: b.taskId,
      name: hidden(b.planId) ? 'Busy' : (t?.name || 'Task'),
      planName: hidden(b.planId) ? '' : (e?.project.name || b.planName || ''),
      hidden: hidden(b.planId), dimmed: visibilityOf(e?.project.workspaceId) === 'dim',
      colour: palette.get(b.planId) || personColour(b.planName || ''),
      start: b.start, end: b.end, left: b.end - now, elapsed: now - b.start,
      background: !!b.background,
      // The next look it needs: a background task's next check-in, else its end.
      nextCheck: t && !hidden(b.planId) ? checkInsOf(t, b.start, b.end).find((m) => m > now) ?? null : null,
    };
  };
  const blocks = (all.blocks || []).filter((b) => b.day === day);
  const running = blocks.filter((b) => b.live).map(describe).sort((a, b) => a.end - b.end);
  const next = blocks.filter((b) => !b.live && !b.worked && b.start >= now && !hidden(b.planId)).map(describe).sort((a, b) => a.start - b.start);
  return { day, now, blocks: blocks.map(describe), running, next, meetings: (all.meetings || []).filter((m) => m.day === day && !m.allDay) };
}

/** How many tasks are running today (for switching the calendar to the day view). */
export const runningCount = () => { try { return todaysTracks().running.length; } catch { return 0; } };

// ------------------------------------------------------------------ actions

async function ensureOpen(planId) {
  if (planId === store.project.id) return true;
  const { openPlan } = await import('../state/sync.js');
  return openPlan(planId);
}
async function stop(track) { const m = await import('./blockmenu.js'); await m.stopNowDialog({ planId: track.planId, taskId: track.taskId }); }
async function done(track) { const m = await import('./blockmenu.js'); m.completeBlock(track.block, true); }
async function openTrack(track) { const m = await import('./blockmenu.js'); await m.taskSheet({ planId: track.planId, taskId: track.taskId, block: track.block }); }
async function start(track) {
  if (!(await ensureOpen(track.planId))) return;
  const t = store.project.tasks.find((x) => x.id === track.taskId);
  if (!t) return;
  const m = await import('./blockmenu.js');
  await m.startNowDialog(t, track.block);
}

const timeLeft = (t) => (t.left >= 0 ? `${span(t.left)} left · ends ${formatClock(t.end)}` : `over by ${span(t.left)} · was due ${formatClock(t.end)}`);

/** One running task, as a card: its name, time left, and the ways to act on it. */
function trackCard(t, { big = false } = {}) {
  const share = Math.max(0, Math.min(1, t.elapsed / Math.max(1, t.end - t.start)));
  return el('div', { class: `rt-card${big ? ' is-big' : ''}${t.left < 0 ? ' is-over' : ''}${t.dimmed ? ' is-dimmed' : ''}${t.background ? ' is-background' : ''}`, style: { '--rt': t.colour.line } },
    el('div', { class: 'rt-kind', text: t.background ? 'Background' : 'Focus' }),
    big ? el('div', { class: 'rt-clock sc-mono', text: t.left >= 0 ? span(t.left) : `+${span(t.left)}` }) : null,
    el('div', { class: 'rt-name', text: t.name }),
    t.planName ? el('div', { class: 'rt-plan sc-faint small', text: t.planName }) : null,
    el('div', { class: 'rt-bar' }, el('span', { style: { width: `${Math.round(share * 100)}%` } })),
    el('div', { class: 'rt-when sc-faint small', text: `▶ since ${formatClock(t.start)} · ${timeLeft(t)}` }),
    t.nextCheck !== null ? el('div', { class: 'rt-when small', text: `◉ check on it at ${formatClock(t.nextCheck)} (in ${span(t.nextCheck - nowMinutes())})` }) : null,
    t.hidden ? null : el('div', { class: 'rt-actions' },
      el('button', { class: 'sc-button sc-button--sm', text: '■ Stop', title: 'Log the time and say what is left', onclick: () => { void stop(t); } }),
      el('button', { class: 'sc-button sc-button--sm', text: '✓ Done', onclick: () => { void done(t); } }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Open', onclick: () => { void openTrack(t); } })));
}

function upNextList(next, limit = 6) {
  if (!next.length) return el('p', { class: 'sc-faint small', text: 'Nothing else laid for today.' });
  return el('div', { class: 'rt-next' }, ...next.slice(0, limit).map((t) => el('div', { class: 'rt-next-row' },
    el('span', { class: 'sc-mono sc-faint', text: formatClock(t.start) }),
    el('span', { class: 'rt-next-name', text: t.name }),
    el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '▶ Start', title: 'Start it now, alongside the rest', onclick: () => { void start(t); } }))));
}

// ------------------------------------------------------------------ C: the running dock

/** Beside the day's calendar: a card per running task, then what is next. */
export function renderDock(root) {
  const { running, next } = todaysTracks();
  root.append(el('aside', { class: 'rt-dock' },
    el('div', { class: 'rt-head' }, el('strong', { text: `Running${running.length ? ` · ${running.length}` : ''}` })),
    running.length ? el('div', { class: 'rt-cards' }, ...[...running.filter((t) => !t.background), ...running.filter((t) => t.background)].map((t) => trackCard(t)))
      : el('p', { class: 'sc-faint small', text: 'Nothing running. Start a task (its menu ▸ Start task now, or ▶ below) and it shows here.' }),
    el('div', { class: 'rt-head' }, el('strong', { text: 'Up next today' })),
    upNextList(next)));
}

// ------------------------------------------------------------------ B: the track strip

/** Each of today's tasks a row against the hours; the running ones lit. */
export function renderStrip(pane, { openAt = 8 * 60 } = {}) {
  const { blocks, now, meetings } = todaysTracks();
  const from = Math.max(0, Math.floor(Math.min(openAt, now - 60, ...blocks.map((b) => b.start), ...meetings.map((m) => m.start)) / 60) * 60);
  const to = Math.min(24 * 60, Math.ceil(Math.max(from + 8 * 60, now + 60, ...blocks.map((b) => b.end), ...meetings.map((m) => m.end)) / 60) * 60);
  const x = (m) => `${((Math.max(from, Math.min(to, m)) - from) / (to - from)) * 100}%`;
  const w = (a, b) => `${((Math.min(to, b) - Math.max(from, a)) / (to - from)) * 100}%`;
  const rows = new Map();
  for (const b of blocks) {
    const key = b.hidden ? `busy|${b.planId}` : `${b.planId}|${b.taskId}`;
    if (!rows.has(key)) rows.set(key, { name: b.name, planName: b.planName, colour: b.colour, items: [], live: false, dimmed: b.dimmed });
    const row = rows.get(key);
    row.items.push(b);
    if (b.block.live) row.live = true;
  }
  const ordered = [...rows.values()].sort((a, b) => (b.live - a.live) || Math.min(...a.items.map((i) => i.start)) - Math.min(...b.items.map((i) => i.start)));
  const hours = [];
  for (let h = from; h <= to; h += 60) hours.push(el('span', { class: 'rs-hour sc-mono', style: { left: x(h) }, text: formatClock(h) }));
  const lane = (row) => el('div', { class: `rs-row${row.live ? ' is-live' : ''}${row.dimmed ? ' is-dimmed' : ''}` },
    el('div', { class: 'rs-label' }, el('div', { class: 'rs-name', text: row.name }), row.planName ? el('div', { class: 'sc-faint small', text: row.planName }) : null),
    el('div', { class: 'rs-track' },
      ...row.items.map((t) => el('button', {
        class: `rs-bar${t.block.live ? ' is-live' : ''}${t.block.worked ? ' is-worked' : ''}${t.hidden ? ' cal-busy' : ''}`,
        style: { left: x(t.start), width: w(t.start, t.end), '--rt': t.colour.line, background: t.hidden ? '' : t.colour.fill },
        title: `${t.name} · ${formatClock(t.start)} – ${formatClock(t.end)}`,
        onclick: t.hidden ? null : () => { void openTrack(t); },
      }, el('span', { text: `${t.background ? '◌ ' : ''}${t.block.live ? timeLeft(t) : `${formatClock(t.start)} – ${formatClock(t.end)}`}${t.background && t.nextCheck !== null ? ` · check ${formatClock(t.nextCheck)}` : ''}` }))),
      el('div', { class: 'rs-now', style: { left: x(now) } })));
  pane.append(el('div', { class: 'rs' },
    el('div', { class: 'rs-row rs-axis' }, el('div', { class: 'rs-label' }), el('div', { class: 'rs-track' }, ...hours, el('div', { class: 'rs-now', style: { left: x(now) } }))),
    meetings.length ? el('div', { class: 'rs-row' }, el('div', { class: 'rs-label' }, el('div', { class: 'rs-name', text: 'Meetings' })),
      el('div', { class: 'rs-track' }, ...meetings.map((m) => el('div', { class: 'rs-bar is-meeting', style: { left: x(m.start), width: w(m.start, m.end) }, title: m.title }, el('span', { text: m.title }))))) : null,
    ...(ordered.length ? ordered.map(lane) : [el('p', { class: 'empty', text: 'Nothing laid for today.' })])));
}

// ------------------------------------------------------------------ D: the control board

let ticker = null;
/** Running (its own view): a big timer per running task, over a slim strip of the day. */
export function renderRunning(root) {
  root.replaceChildren();
  const { running, next, blocks, now } = todaysTracks();
  const x = (m) => `${(m / (24 * 60)) * 100}%`;
  const strip = el('div', { class: 'rb-strip' },
    ...blocks.map((t) => el('span', { class: `rb-seg${t.block.live ? ' is-live' : ''}${t.hidden ? ' cal-busy' : ''}`, style: { left: x(t.start), width: x(t.end - t.start), background: t.hidden ? '' : t.colour.line }, title: t.name })),
    el('span', { class: 'rs-now', style: { left: x(now) } }));
  root.append(el('div', { class: 'rb' },
    el('div', { class: 'rb-head' },
      el('h2', { text: running.length ? `${running.length} running` : 'Nothing running' }),
      running.length ? el('span', { class: 'sc-faint', text: `${running.filter((t) => !t.background).length} focus · ${running.filter((t) => t.background).length} in the background` }) : null,
      el('span', { class: 'sc-faint', text: `${fromDay(toDay(today()))} · ${formatClock(now)}` }),
      el('span', { class: 'sc-spacer' }),
      el('button', { class: 'sc-button sc-button--sm', text: 'Calendar', onclick: () => set({ view: 'calendar', calendarRange: 'day' }) })),
    strip,
    running.length ? el('div', { class: 'rb-grid' }, ...[...running.filter((t) => !t.background), ...running.filter((t) => t.background)].map((t) => trackCard(t, { big: true })))
      : el('p', { class: 'sc-muted', text: 'Start tasks to see them here side by side — each with its own clock. Up next:' }),
    el('h3', { text: 'Up next today' }),
    upNextList(next, 8)));
  // The clocks move on: redraw each half minute while this view is up.
  clearInterval(ticker);
  ticker = setInterval(() => { if (store.ui.view === 'running' && root.isConnected) renderRunning(root); else clearInterval(ticker); }, 30_000);
}
