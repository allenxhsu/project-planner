// Settings ▸ Sync: where the server is, whether to use it, and what it is doing.
//
// The plan itself is the unit that travels (see state/sync.js), so there is
// nothing here about tasks or resources — a URL, a token, a switch, and an
// honest status line.

import { el } from '../util.js';
import { open, foot, button } from './dialog.js';
import { getSettings, applySettings, syncNow, syncStatus, deviceId, WORKSPACE } from '../state/sync.js';
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

export function settingsDialog() {
  return open('Settings', (close) => {
    const current = getSettings();
    const url = el('input', { class: 'sc-input', type: 'text', value: current.url, placeholder: PLACEHOLDER, spellcheck: false });
    const token = el('input', { class: 'sc-input', type: 'password', value: current.token, placeholder: 'The workspace secret', spellcheck: false });
    const enabled = el('input', { class: 'sc-check', type: 'checkbox', checked: current.enabled });
    const status = el('div', { class: 'sync-status sc-mono', text: statusText(syncStatus()) });
    for (const input of [url, token]) input.addEventListener('keydown', (e) => e.stopPropagation());

    const onStatus = (e) => { status.textContent = statusText(e.detail || syncStatus()); };
    window.addEventListener(SYNC_EVENTS.status, onStatus);

    const save = async () => {
      await applySettings({ url: url.value, token: token.value, enabled: enabled.checked });
      status.textContent = statusText(syncStatus());
    };
    const done = () => { window.removeEventListener(SYNC_EVENTS.status, onStatus); close(null); };

    return [
      el('div', { class: 'sc-section-title', text: 'Sync' }),
      el('p', { class: 'sc-muted small', text: 'One plan is one record. Point every device at the same server and workspace, and whichever saved last wins — unless this plan has unsaved changes, in which case you are asked.' }),
      el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Server URL' }), url,
        el('span', { class: 'sc-faint field-hint', text: `The workspace URL, ending in /w/${WORKSPACE}.` })),
      el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Token' }), token,
        el('span', { class: 'sc-faint field-hint', text: 'The workspace secret. A loopback server on this machine may not need one.' })),
      el('label', { class: 'row check-row' }, enabled, el('span', { text: 'Sync this plan automatically (every 30 seconds, when the window is focused, and after each save)' })),
      status,
      el('div', { class: 'sc-faint field-hint', text: `This device is ${deviceId()} · plan ${store.project.id}` }),
      foot(
        button('Sync now', async () => { await save(); await syncNow(); status.textContent = statusText(syncStatus()); }),
        button('Save', save, 'sc-button--primary'),
        button('Close', done)),
    ];
  }, { wide: true });
}
