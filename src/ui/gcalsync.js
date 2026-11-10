// Sync Google: the review before anything is written.
//
// The button on the calendar toolbar works out everything a run would do
// (state/gcal.js planSync) and shows it here in plain sections: what the
// calendar did that the planner will take, what the planner will push, the
// hand-made events it proposes to link (ticked to accept), the events it
// found that match nothing (ticked to become tasks), the ambiguous ones it
// will not guess at, and the plans with no calendar. Apply writes both
// sides; nothing is written before.
//
// Four states before the list: no sync server, no Google account, an
// account that may only read (a link to allow writing), and nothing to do.

import { el } from '../util.js';
import { open, foot, button } from './dialog.js';
import { set } from '../state/store.js';
import { planSync, applySync, WRITE_FEATURE } from '../state/gcal.js';
import { formatDate } from '../model/calendar.js';

const clock = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${(h % 12) || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`; };
const when = (e) => `${formatDate(e.dateIso || e.day, 'day')} ${clock(e.start)}–${clock(e.end ?? e.start + e.minutes)}`;

export async function syncDialog() {
  let state = { loading: true, error: null, run: null, result: null, applying: false };
  const ticked = { links: new Set(), orphans: new Set() };
  let body = null;
  let redraw = () => {};

  const load = async () => {
    state = { ...state, loading: true, error: null };
    redraw();
    try {
      const run = await planSync();
      // Every proposed link is ticked to start with: the match was by name, and a person unticks what is wrong.
      ticked.links.clear(); ticked.orphans.clear();
      (run.actions?.link || []).forEach((_, i) => ticked.links.add(i));
      state = { ...state, loading: false, run };
    } catch (err) {
      state = { ...state, loading: false, error: err.message };
    }
    redraw();
  };

  const connect = async (features) => {
    const { connectAccount } = await import('./gcal.js');
    await connectAccount(features);
  };

  const section = (title, rows, { empty = null } = {}) => {
    if (!rows.length && !empty) return null;
    return el('div', { class: 'gsync-section' },
      el('div', { class: 'sc-label', text: `${title}${rows.length ? ` (${rows.length})` : ''}` }),
      rows.length ? el('ul', { class: 'gsync-list' }, ...rows) : el('p', { class: 'sc-faint small', text: empty }));
  };
  const row = (...parts) => el('li', { class: 'gsync-row' }, ...parts);
  const pill = (text, cls = '') => el('span', { class: `sc-pill gsync-pill ${cls}`, text });
  const tick = (setOf, i, label) => el('label', { class: 'gsync-tick' },
    el('input', { type: 'checkbox', class: 'sc-check', checked: setOf.has(i), onchange: (e) => { if (e.target.checked) setOf.add(i); else setOf.delete(i); } }),
    label);

  const render = (close) => {
    const { loading, error, run, result, applying } = state;
    if (loading) return [el('p', { class: 'sc-muted', text: 'Reading the plan calendars…' })];
    if (error) return [el('p', { class: 'sc-alert sc-alert--danger', text: error }), foot(button('Try again', load), button('Close', () => close(null)))];
    if (result) {
      return [
        el('p', { text: `Done. ${result.pushed} event${result.pushed === 1 ? '' : 's'} written to Google, ${result.pulled} task${result.pulled === 1 ? '' : 's'} moved here${result.linked ? `, ${result.linked} linked` : ''}${result.adopted ? `, ${result.adopted} made from events` : ''}.` }),
        foot(button('Close', () => close(result), 'sc-button--primary')),
      ];
    }
    if (!run.ok) {
      const why = {
        'no-server': ['Google is reached through your sync server.', 'Turn sync on (Settings ▸ Sync, or pair this Mac) first.', null],
        'not-signed-in': ['Sign in to your sync server first.', 'The Portal signs you in; the Mac app is paired with a token.', null],
        'not-configured': ['This sync server is not set up for Google Calendar.', 'It has no Google client secret.', null],
        'not-connected': ['No Google account is connected yet.', 'Connect one, allowing it to write events, and every plan with a calendar named for it syncs.', ['Connect Google…', () => connect(`calendar,${WRITE_FEATURE}`)]],
      }[run.reason] || ['Google could not be reached.', '', null];
      return [el('p', { text: why[0] }), el('p', { class: 'sc-muted small', text: why[1] }),
        foot(why[2] ? button(why[2][0], why[2][1], 'sc-button--primary') : el('span'), button('Close', () => close(null)))];
    }
    const a = run.actions;
    const name = (x) => `${x.taskName} (${x.planName})`;
    const parts = [];
    if (run.reason === 'not-granted') {
      parts.push(el('div', { class: 'sc-alert sc-alert--warning gsync-grant' },
        el('span', { text: 'This Google account was connected for reading. Reading back works; pushing the week needs it to be allowed to write.' }),
        button('Allow writing…', () => connect(`calendar,${WRITE_FEATURE}`), 'sc-button--sm')));
    }
    parts.push(el('p', { class: 'sc-faint small', text: `${formatDate(a.window[0], 'day')} – ${formatDate(a.window[1], 'day')} · ${a.keep} event${a.keep === 1 ? '' : 's'} already in step.` }));
    parts.push(section('Calendar → planner', [
      ...a.pull.map((c) => row(pill('moved', 'is-pull'), el('span', { class: 'gsync-what' }, el('strong', { text: name(c) }),
        el('span', { class: 'sc-faint', text: ` ${c.changes.pin.from ? when(c.changes.pin.from) : 'unplaced'} → ${when({ dateIso: c.changes.pin.to.day, start: c.changes.pin.to.start, end: c.changes.pin.to.start + c.changes.pin.to.minutes })}${c.changes.name ? `, renamed “${c.changes.name.to}”` : ''}${c.changes.done ? ', done' : ''}${c.conflict ? ` — the calendar wins over the planner's ${c.plannerChange}` : ''}` })))),
      ...a.unlink.map((u) => row(pill('deleted there', 'is-unlink'), el('span', { class: 'gsync-what' }, el('strong', { text: name(u) }), el('span', { class: 'sc-faint', text: ` ${when(u.link)} — taken off the calendar` })))),
    ], { empty: 'Nothing moved on the calendars since the last sync.' }));
    parts.push(section('Planner → calendar', [
      ...a.create.map((d) => row(pill('new', 'is-create'), el('span', { class: 'gsync-what' }, el('strong', { text: d.title }), el('span', { class: 'sc-faint', text: ` ${when(d)}` })))),
      ...a.update.map(({ desired: d, existing: e }) => row(pill('retitle', 'is-update'), el('span', { class: 'gsync-what' }, el('strong', { text: d.title }), el('span', { class: 'sc-faint', text: ` ${when(d)} (was “${e.title}”)` })))),
      ...a.delete.map((e) => row(pill('remove', 'is-delete'), el('span', { class: 'gsync-what' }, el('strong', { text: e.title }), el('span', { class: 'sc-faint', text: ` ${when(e)} — its task is gone` })))),
    ], { empty: 'Every laid block already has its event.' }));
    if (a.link.length) {
      const rows = a.link.map((l, i) => {
        const what = el('span', { class: 'gsync-what' }, el('strong', { text: `“${l.event.title}”` }), el('span', { class: 'sc-faint', text: ` ${when(l.event)} → ${name(l)} (by ${l.how})` }));
        return row(tick(ticked.links, i, what));
      });
      parts.push(section('Hand-made events that look like these tasks', rows));
    }
    if (a.orphans.length) {
      const rows = a.orphans.map((e, i) => {
        const what = el('span', { class: 'gsync-what' }, el('strong', { text: `“${e.title}”` }), el('span', { class: 'sc-faint', text: ` ${when(e)} · ${e.planName} — tick to make it a task` }));
        return row(tick(ticked.orphans, i, what));
      });
      parts.push(section('On a plan calendar, matching no task', rows));
    }
    if (a.ambiguous.length) {
      const rows = a.ambiguous.map((x) => row(pill('?', 'is-ambiguous'),
        el('span', { class: 'gsync-what' }, el('strong', { text: `“${x.event.title}”` }), el('span', { class: 'sc-faint', text: ` ${when(x.event)} could be ${x.candidates.map((t) => t.name).join(' or ')} — rename the event to say which` }))));
      parts.push(section('Ambiguous — not guessed', rows));
    }
    if (a.unmapped.length) {
      const rows = a.unmapped.map((n) => row(pill('no calendar', 'is-unmapped'),
        el('span', { class: 'gsync-what' }, el('strong', { text: n }), el('span', { class: 'sc-faint', text: ' — make a Google calendar named “Claude - <workspace> - <plan>”, or pick one in Project settings ▸ Connected calendars' }))));
      parts.push(section('Plans with no calendar', rows));
    }
    const todo = a.pull.length + a.unlink.length + a.create.length + a.update.length + a.delete.length;
    const canApply = !applying && (todo > 0 || ticked.links.size > 0 || ticked.orphans.size > 0) && (run.status.writer || (a.create.length + a.update.length + a.delete.length === 0));
    parts.push(foot(
      button('Read again', load),
      el('span', { class: 'sc-spacer' }),
      button('Close', () => close(null)),
      el('button', { class: 'sc-button sc-button--primary', text: applying ? 'Applying…' : 'Apply', disabled: !canApply, onclick: async () => {
        state = { ...state, applying: true }; redraw();
        try {
          const result = await applySync(run, { links: [...ticked.links], orphans: [...ticked.orphans] });
          state = { ...state, applying: false, result };
          set({ hint: `Google Calendar: ${result.pushed} written, ${result.pulled} read back.` });
        } catch (err) {
          state = { ...state, applying: false, error: err.message };
        }
        redraw();
      } })));
    return parts;
  };

  await open('Google Calendar', (close) => {
    body = el('div', { class: 'gsync' });
    redraw = () => { body.replaceChildren(...render(close).filter(Boolean)); };
    void load();
    return body;
  }, { wide: true });
}
