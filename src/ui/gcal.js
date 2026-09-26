// Google Calendar, by signing in: the connected Google accounts, and every
// calendar on them to tick — instead of pasting a secret iCal address per
// calendar. The accounts are connected on the sync server (it keeps Google's
// permission, so the Mac app and the Portal share it); a ticked calendar
// becomes a connected calendar of the open plan, read through the server.

import { el } from '../util.js';
import { store } from '../state/store.js';
import * as act from '../state/actions.js';
import { hosted, post } from '../host.js';
import { open, foot, button, confirmDialog } from './dialog.js';
import { feeds } from '../model/model.js';

/** Open Google's sign-in: a window here, the default browser from the Mac app. */
async function connectAccount() {
  const { serverOrigin } = await import('../state/sync.js');
  const origin = serverOrigin();
  if (!origin) { act.hint('Calendars are read through your sync server: turn sync on (or pair this Mac) first.'); return false; }
  const url = `${origin}/calendar/google/connect`;
  if (hosted) post({ type: 'openURL', url });
  else window.open(url, 'connect-google', 'width=520,height=720');
  return true;
}

async function load() {
  const { serverFetch } = await import('../state/sync.js');
  const accountsRes = await serverFetch('/calendar/google/accounts');
  if (accountsRes.status === 401) throw new Error('Sign in to your sync server first — it is where Google accounts are connected.');
  if (!accountsRes.ok) throw new Error(`The server could not list Google accounts (${accountsRes.status}).`);
  const { configured, accounts } = await accountsRes.json();
  if (!accounts.length) return { configured, accounts, calendars: [], problems: [] };
  const calRes = await serverFetch('/calendar/google/calendars');
  const { calendars, problems } = calRes.ok ? await calRes.json() : { calendars: [], problems: accounts.map((a) => ({ account: a.email, error: 'google-unavailable' })) };
  return { configured, accounts, calendars, problems };
}

/**
 * Settings ▸ Calendars ▸ Google: connect accounts, tick calendars. Also where
 * "＋ Add calendar" goes, with a way through to pasting a link for Outlook,
 * Hotmail or anything else that publishes one.
 */
export async function googleCalendarsDialog() {
  const project = store.project;
  let state = { loading: true, error: null, data: null };
  const onMessage = (e) => { if (e.data?.type === 'calendar-connected') void refresh(); };
  const onFocus = () => { void refresh(); };
  let body = null;
  let redraw = () => {};
  const refresh = async () => {
    state = { ...state, loading: true };
    redraw();
    try { state = { loading: false, error: null, data: await load() }; } catch (err) { state = { loading: false, error: err.message, data: null }; }
    redraw();
  };
  window.addEventListener('message', onMessage);
  window.addEventListener('focus', onFocus);

  const chosen = new Map();   // `${account}|${id}` → calendar, ticked in this dialog
  const existing = () => new Map(feeds(store.project).filter((f) => f.google).map((f) => [`${f.google.account}|${f.google.calendarId}`, f]));
  const people = [{ value: '', label: 'Me / unassigned' }, ...project.resources.filter((r) => r.type === 'work').map((r) => ({ value: r.id, label: r.name }))];
  const whose = el('select', { class: 'sc-select sc-select--sm' }, ...people.map((o) => el('option', { value: o.value, text: o.label })));

  const result = await open('Google calendars', (close) => {
    body = el('div', { class: 'gcal' });
    redraw = () => {
      body.replaceChildren();
      const have = existing();
      if (state.error) body.append(el('p', { class: 'sc-alert sc-alert--warning', text: state.error }));
      if (state.loading && !state.data) { body.append(el('p', { class: 'sc-faint', text: 'Asking your sync server…' })); return; }
      const data = state.data;
      if (data && !data.configured) body.append(el('p', { class: 'sc-alert sc-alert--warning', text: 'This sync server is not set up for Google Calendar yet (it has no Google client secret).' }));
      if (data && !data.accounts.length) {
        body.append(el('p', { class: 'sc-muted', text: 'No Google account connected yet. Connect one and every calendar on it is listed here to tick — no links to paste.' }));
      }
      for (const account of data?.accounts || []) {
        const problem = data.problems.find((p) => p.account === account.email);
        const mine = data.calendars.filter((c) => c.account === account.email);
        body.append(el('div', { class: 'gcal-account' },
          el('div', { class: 'gcal-account-head' },
            el('strong', { text: account.email }),
            el('span', { class: 'sc-spacer' }),
            el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Disconnect', onclick: async () => {
              if (!(await confirmDialog(`Disconnect ${account.email}?`, 'Its calendars stop being read, and Google is told to forget this permission. Calendars already added keep the events they have.'))) return;
              const { serverFetch } = await import('../state/sync.js');
              await serverFetch(`/calendar/google/accounts/${encodeURIComponent(account.email)}`, { method: 'DELETE' });
              void refresh();
            } })),
          problem ? el('p', { class: 'sc-alert sc-alert--warning small', text: problem.error === 'reconnect' ? 'Google needs this account connected again (permission expired or was removed).' : 'Google could not be reached for this account just now.' }) : null,
          problem?.error === 'reconnect' ? el('button', { class: 'sc-button sc-button--sm', text: 'Connect again', onclick: () => { void connectAccount(); } }) : null,
          ...mine.map((c) => {
            const key = `${c.account}|${c.id}`;
            const added = have.get(key);
            const box = el('input', { type: 'checkbox', class: 'sc-check', checked: !!added || chosen.has(key), disabled: !!added,
              onchange: (e) => { if (e.target.checked) chosen.set(key, c); else chosen.delete(key); } });
            return el('label', { class: `gcal-cal${added ? ' is-added' : ''}` }, box,
              el('span', { class: 'gcal-dot', style: { background: c.colour || 'var(--sc-accent-2)' } }),
              el('span', { class: 'gcal-name', text: c.name }),
              c.primary ? el('span', { class: 'ps-chip', text: 'Primary' }) : null,
              added ? el('span', { class: 'sc-faint small', text: `added · ${added.events.length} events` }) : null);
          })));
      }
      body.append(el('div', { class: 'gcal-actions' },
        el('button', { class: 'sc-button sc-button--sm sc-button--primary', text: data?.accounts?.length ? '＋ Connect another Google account' : '＋ Connect a Google account',
          disabled: data && !data.configured, onclick: () => { void connectAccount(); } }),
        el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '↻ Refresh', onclick: () => { void refresh(); } }),
        state.loading ? el('span', { class: 'sc-faint small', text: 'Refreshing…' }) : null),
        el('p', { class: 'sc-faint small', text: hosted ? 'Google’s sign-in opens in your web browser; come back here when it says connected.' : 'Google’s sign-in opens in a small window.' }));
    };
    redraw();
    setTimeout(() => { void refresh(); }, 0);
    return [
      body,
      el('div', { class: 'gcal-whose' }, el('span', { text: 'Whose hours the ticked calendars are' }), whose),
      foot(
        el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Paste a link instead (Outlook, Hotmail, iCal)…', onclick: () => close('link') }),
        el('span', { class: 'sc-spacer' }),
        button('Cancel', () => close(null)),
        button('Add ticked calendars', () => close('add'), 'sc-button--primary')),
    ];
  }, { wide: true });
  window.removeEventListener('message', onMessage);
  window.removeEventListener('focus', onFocus);

  if (result === 'link') { await act.connectCalendarDialog(); return; }
  if (result !== 'add' || !chosen.size) return;
  for (const c of chosen.values()) act.connectGoogleCalendar({ account: c.account, calendarId: c.id, name: c.name, resourceId: whose.value || null });
  act.hint(`Added ${chosen.size} Google calendar${chosen.size === 1 ? '' : 's'}; reading them now.`);
}
