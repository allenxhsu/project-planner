// Settings ▸ Sync: where the server is, whether to use it, and what it is doing.
//
// The plan itself is the unit that travels (see state/sync.js), so there is
// nothing here about tasks or resources — a URL, a token, a switch, and an
// honest status line.

import { el } from '../util.js';
import { open, foot, button } from './dialog.js';
import { getSettings, applySettings, syncNow, syncStatus, deviceId, inPortal, persistence, requestPersistence, storageEstimate, storeCounts, WORKSPACE } from '../state/sync.js';
import { SYNC_EVENTS } from '../../sync-kit/js/events.js';
import { store } from '../state/store.js';

const PLACEHOLDER = `http://127.0.0.1:8080/w/${WORKSPACE}`;

function statusText(s) {
  if (s.phase === 'syncing') return 'Syncing…';
  if (s.phase === 'error') return `Last sync failed: ${s.lastError || 'unknown error'}`;
  if (!s.lastSyncAt) return 'Not synced yet.';
  const when = new Date(s.lastSyncAt);
  const clock = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Last sync ${clock} · ${s.pulled} in, ${s.pushed} out.`;
}

/**
 * Where this app's data is, and whether the browser has agreed to keep it.
 *
 * "Synced" answers half the question. The other half is whether the copy on
 * this machine survives the browser deciding it needs the space, which is a
 * thing browsers do to origins they think are disposable.
 */
function storageReadout() {
  const box = el('div', { class: 'storage-readout' });
  const line = el('div', { class: 'sc-mono small' }, 'Checking local storage…');
  const advice = el('div', { class: 'sc-faint small' });
  const counts = el('div', { class: 'sc-mono small' });
  box.append(line, advice, counts);

  const paint = async () => {
    const p = persistence().asked ? persistence() : await requestPersistence();
    const est = await storageEstimate();
    const used = est?.usage ? `${Math.max(1, Math.round(est.usage / 1024))} KB used` : '';
    if (p.state === 'persisted') {
      line.textContent = `Persisted${used ? ` · ${used}` : ''}`;
      advice.textContent = 'The browser has agreed to keep this app\u2019s data. It survives a restart and is not evicted when space runs short.';
    } else if (p.state === 'at-risk') {
      line.textContent = `At risk${used ? ` · ${used}` : ''}`;
      advice.textContent = 'The browser may clear this app\u2019s data when space runs short. Install the app from the browser\u2019s menu, or on iPhone add it to the Home Screen, and it will be kept.';
    } else if (p.state === 'unsupported') {
      line.textContent = 'At risk';
      advice.textContent = 'This browser will not say whether it keeps the data. Save a copy with File \u25b8 Export everything, or use the Mac app.';
    } else {
      line.textContent = 'Unknown';
      advice.textContent = 'The browser did not answer. Export everything from the File menu if this copy matters.';
    }
    const { local, server } = await storeCounts();
    counts.textContent = server === null
      ? `${local} record${local === 1 ? '' : 's'} here · the server was not reachable`
      : `${local} record${local === 1 ? '' : 's'} here · ${server} on the server`;
  };
  void paint();
  return { box, paint };
}

export function settingsDialog() {
  return open('Settings', (close) => {
    const current = getSettings();
    const url = el('input', { class: 'sc-input', type: 'text', value: current.url, placeholder: PLACEHOLDER, spellcheck: false });
    const token = el('input', { class: 'sc-input', type: 'password', value: current.token, placeholder: 'The workspace secret', spellcheck: false });
    const enabled = el('input', { class: 'sc-check', type: 'checkbox', checked: current.enabled });
    const status = el('div', { class: 'sync-status sc-mono', text: statusText(syncStatus()) });
    for (const input of [url, token]) input.addEventListener('keydown', (e) => e.stopPropagation());

    const storage = storageReadout();
    const onStatus = (e) => { status.textContent = statusText(e.detail || syncStatus()); };
    window.addEventListener(SYNC_EVENTS.status, onStatus);

    const save = async () => {
      await applySettings({ url: url.value, token: token.value, enabled: enabled.checked });
      status.textContent = statusText(syncStatus());
    };
    const done = () => { window.removeEventListener(SYNC_EVENTS.status, onStatus); close(null); };

    // Served by the Portal, there is nothing to fill in: the server is the
    // origin this page came from and the session is the credential. Showing a
    // URL and a token there would invite someone to configure their way out of
    // a working setup.
    if (inPortal()) {
      return [
        el('div', { class: 'sc-section-title', text: 'Sync' }),
        el('p', { class: 'sc-muted small', text: 'Signed in via the toolkit.' }),
        el('p', { class: 'sc-faint small', text: `Served at ${location.host}, this app syncs with that origin as the account you are signed in as — there is no URL to paste and no token to keep. The bar at the top of the window switches apps, shows the account and signs out.` }),
        status,
        el('div', { class: 'sc-section-title', text: 'On this device' }),
        storage.box,
        el('div', { class: 'sc-faint field-hint', text: `This device is ${deviceId()} · plan ${store.project.id}` }),
        foot(
          button('Sync now', async () => { await syncNow(); status.textContent = statusText(syncStatus()); void storage.paint(); }),
          button('Close', done)),
      ];
    }

    return [
      el('div', { class: 'sc-section-title', text: 'Sync' }),
      el('p', { class: 'sc-muted small', text: 'One plan is one record. Point every device at the same server and workspace, and whichever saved last wins — unless this plan has unsaved changes, in which case you are asked.' }),
      el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Server URL' }), url,
        el('span', { class: 'sc-faint field-hint', text: `The workspace URL, ending in /w/${WORKSPACE}.` })),
      el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Token' }), token,
        el('span', { class: 'sc-faint field-hint', text: 'The workspace secret. A loopback server on this machine may not need one.' })),
      el('label', { class: 'row check-row' }, enabled, el('span', { text: 'Sync this plan automatically (every 30 seconds, when the window is focused, and after each save)' })),
      status,
      el('div', { class: 'sc-section-title', text: 'On this device' }),
      storage.box,
      el('div', { class: 'sc-faint field-hint', text: `This device is ${deviceId()} · plan ${store.project.id}` }),
      foot(
        button('Sync now', async () => { await save(); await syncNow(); status.textContent = statusText(syncStatus()); void storage.paint(); }),
        button('Save', save, 'sc-button--primary'),
        button('Close', done)),
    ];
  }, { wide: true });
}
