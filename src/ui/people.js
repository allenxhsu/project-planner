// The People screen: everyone who does the work, in one place.
//
// A plan's Resource Sheet answers "who is on this plan". It is the wrong place
// to answer "who is Uma Chen, and what is she carrying" — that question spans
// plans, and asking it per plan is how the same person ends up with three
// rates and four spellings of their name. So the directory is the record of a
// person, this screen is where it is kept, and an edit here is written into
// every plan that points at them (state/sync.js `updatePerson`).
//
// Stakeholder profiles are not kept here either. Profiler owns those, and a
// person carries the summary of the profile Profiler exported, with a link back
// to it (io/profile.js).

import { el, clear, formatHours, formatMoney } from '../util.js';
import { store, set } from '../state/store.js';
import { RESOURCE_TYPES } from '../model/model.js';
import {
  peopleWithLoad, rememberPerson, updatePerson, forgetPerson,
  attachProfile, detachProfile, syncConfigured, linkPlansToDirectory, unlinkedCount,
} from '../state/sync.js';
import { profilerUrl } from '../io/profile.js';
import { showMenu, confirmDialog, formDialog, showText } from './dialog.js';

/** The last reading of the directory. Rendering is synchronous; reading is not. */
let people = [];
let loading = false;
let loaded = false;
let failed = null;
/** Plan resources that name a directory person without pointing at them. */
let unlinked = 0;

export async function reloadPeople() {
  loading = true; failed = null; set({});
  try {
    people = await peopleWithLoad();
    unlinked = await unlinkedCount();
  } catch (err) { people = []; failed = err.message; }
  loading = false; loaded = true; set({});
}

const TYPE_OPTIONS = Object.entries(RESOURCE_TYPES || { work: 'Work', material: 'Material', cost: 'Cost' })
  .map(([value, label]) => ({ value, label: typeof label === 'string' ? label : label?.label || value }));

const initialsFor = (name) => String(name).split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 3);

/** Open Profiler, where stakeholder profiles are kept. */
function openProfiler(person) {
  const url = profilerUrl();
  const win = globalThis.open?.(url, '_blank');
  if (!win) showText('Open Profiler', `Profiler is at:\n\n${url}\n\n${person ? `Look for ${person.name}.` : ''}`);
}

/** Read a Profiler export file onto a person. */
function pickProfile(person) {
  const input = document.getElementById('file-input');
  const previous = input.accept;
  input.value = ''; input.accept = '.json,application/json';
  input.onchange = async () => {
    input.accept = previous;
    const file = input.files[0];
    if (!file) return;
    try {
      const record = await attachProfile(person.id, await file.text());
      if (!record) throw new Error('That person is no longer in the directory.');
      await reloadPeople();
    } catch (err) {
      showText('That profile could not be read', err.message);
    }
  };
  input.click();
}

async function editPerson(person) {
  const values = await formDialog(`Edit ${person.name}`, [
    { key: 'name', label: 'Name', value: person.name },
    { key: 'initials', label: 'Initials', value: person.initials || initialsFor(person.name) },
    { key: 'resourceType', label: 'Type', type: 'select', value: person.resourceType || 'work', options: TYPE_OPTIONS },
    { key: 'role', label: 'Role', value: person.role || '', placeholder: 'Systems engineer' },
    { key: 'team', label: 'Team', value: person.team || '', placeholder: 'Platform' },
    { key: 'group', label: 'Group', value: person.group || '', hint: 'What the Resource Sheet calls a group.' },
    { key: 'email', label: 'Email', value: person.email || '' },
    { key: 'rate', label: 'Standard rate', type: 'number', min: '0', step: '1', value: person.rate ?? 0, hint: 'Per hour. Used to cost work in every plan.' },
  ], 'Save', 'Saved here and written into every plan that uses this person.');
  if (!values) return;
  await updatePerson(person.id, { ...values, rate: Number(values.rate) || 0 });
  await reloadPeople();
}

async function addPerson() {
  const values = await formDialog('Add someone', [
    { key: 'name', label: 'Name', value: '' },
    { key: 'initials', label: 'Initials', value: '' },
    { key: 'type', label: 'Type', type: 'select', value: 'work', options: TYPE_OPTIONS },
    { key: 'role', label: 'Role', value: '' },
    { key: 'rate', label: 'Standard rate', type: 'number', min: '0', step: '1', value: 0 },
  ], 'Add', 'They go in the directory, ready to put on any plan.');
  if (!values?.name?.trim()) return;
  const made = await rememberPerson({ ...values, initials: values.initials || initialsFor(values.name), rate: Number(values.rate) || 0 });
  if (made && values.role) await updatePerson(made.id, { role: values.role });
  await reloadPeople();
}

function profileBlock(person) {
  const profile = person.profile;
  if (!profile?.instruments?.length) {
    return el('div', { class: 'person-profile is-empty' },
      el('span', { class: 'sc-faint small', text: 'No profile attached' }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Attach profile…', title: 'Read a profile exported from Profiler', onclick: (e) => { e.stopPropagation(); pickProfile(person); } }));
  }
  return el('div', { class: 'person-profile' },
    ...profile.instruments.map((i) => el('span', {
      class: 'sc-pill person-code',
      style: { '--tint': 'var(--sc-accent, var(--sc-app))' },
      title: [i.name, i.tagline, i.confidence === null ? null : `confidence ${Math.round(i.confidence * 100)}%`, ...i.caveats].filter(Boolean).join('\n'),
      text: i.headline || i.name,
    })),
    el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Profiler ↗', title: 'Open the Profiler app', onclick: (e) => { e.stopPropagation(); openProfiler(person); } }));
}

function row(entry) {
  const { person, plans, tasks, hours, cost } = entry;
  const listed = !!person.id;
  const menu = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const items = listed ? [
      { label: 'Edit…', run: () => void editPerson(person) },
      '-',
      { label: person.profile ? 'Replace the profile…' : 'Attach a profile from Profiler…', run: () => pickProfile(person) },
      { label: 'Open Profiler', run: () => openProfiler(person) },
      ...(person.profile ? [{ label: 'Forget the attached profile', run: async () => { await detachProfile(person.id); await reloadPeople(); } }] : []),
      '-',
      { label: 'Take out of the directory', danger: true, run: async () => {
        const yes = await confirmDialog(`Take ${person.name} out of the directory?`,
          'Plans they are already on keep them — this only stops them being offered for new work.');
        if (!yes) return;
        await forgetPerson(person.id);
        await reloadPeople();
      } },
    ] : [
      { label: 'Add to the directory', run: async () => { await rememberPerson({ name: person.name, initials: person.initials, type: person.resourceType, rate: person.rate, group: person.group }); await reloadPeople(); } },
    ];
    showMenu(r.left - 200, r.bottom + 4, items);
  };

  return el('article', { class: `person-card sc-card sc-brackets sc-brackets--hover${listed ? '' : ' is-loose'}`, onclick: () => listed && void editPerson(person) },
    el('div', { class: 'person-head' },
      el('span', { class: 'person-mark sc-mono', text: person.initials || initialsFor(person.name) }),
      el('div', { class: 'person-who' },
        el('h3', { class: 'person-name', text: person.name }),
        el('div', { class: 'sc-faint small', text: [person.role, person.team || person.group].filter(Boolean).join(' · ') || (listed ? 'In the directory' : 'Only in a plan') })),
      listed ? null : el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-warn, var(--sc-danger))' }, text: 'Not shared' }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '⋮', title: 'Actions', onclick: menu })),
    profileBlock(person),
    el('div', { class: 'person-load' },
      el('span', { class: 'sc-mono', title: 'Hours of work assigned across every plan', text: formatHours(hours) }),
      el('span', { class: 'sc-faint', text: `${tasks} ${tasks === 1 ? 'task' : 'tasks'}` }),
      person.rate ? el('span', { class: 'sc-faint sc-mono', text: `${formatMoney(cost)} · ${formatMoney(person.rate)}/h` }) : null),
    el('div', { class: 'person-plans' },
      plans.length
        ? plans.map((name) => el('span', { class: 'sc-pill person-plan', title: 'On this plan', text: name }))
        : el('span', { class: 'sc-faint small', text: 'Not on any plan yet' })));
}

export function renderPeople(root) {
  clear(root);
  if (!loaded && !loading) void reloadPeople();
  const pane = el('div', { class: 'projects-pane' });
  root.append(pane);

  pane.append(el('div', { class: 'projects-head people-head' },
    el('div', { class: 'people-head-text' },
      el('div', { class: 'sc-display', text: 'People' }),
      el('span', { class: 'sc-muted small', text: syncConfigured()
        ? 'One record per person, shared by every plan and every device. Editing someone here changes them everywhere.'
        : 'One record per person, shared by every plan on this device. Editing someone here changes them everywhere.' })),
    el('div', { class: 'people-head-actions' },
      el('button', { class: 'sc-button sc-button--sm', text: 'Open Profiler ↗', title: 'Stakeholder profiles live in Profiler', onclick: () => openProfiler(null) }),
      el('button', { class: 'sc-button sc-button--primary sc-button--sm', text: 'Add someone', onclick: () => void addPerson() }))));

  if (failed) pane.append(el('p', { class: 'empty warn', text: `The directory could not be read: ${failed}` }));

  // Plans made before someone was in the directory name them and nothing more.
  if (unlinked) {
    pane.append(el('div', { class: 'sc-panel people-link' },
      el('span', { text: `${unlinked} ${unlinked === 1 ? 'resource names' : 'resources name'} someone in the directory without being linked to them, so edits here will not reach ${unlinked === 1 ? 'it' : 'them'}.` }),
      el('span', { class: 'sc-spacer' }),
      el('button', { class: 'sc-button sc-button--primary sc-button--sm', text: 'Link them by name', onclick: async () => {
        const { linked, plans } = await linkPlansToDirectory();
        await reloadPeople();
        showText('Linked to the directory', `${linked} ${linked === 1 ? 'resource' : 'resources'} in ${plans} ${plans === 1 ? 'plan' : 'plans'} now point at a person in the directory. Editing someone on this screen changes them in every one.`);
      } })));
  }

  const loose = people.filter((p) => !p.person.id);
  const listed = people.filter((p) => p.person.id);

  const grid = el('div', { class: 'person-grid' });
  for (const entry of listed) grid.append(row(entry));
  pane.append(grid);

  if (loading) pane.append(el('p', { class: 'empty', text: 'Reading the directory…' }));
  else if (!listed.length) pane.append(el('p', { class: 'empty', text: 'Nobody in the directory yet. Add someone, or add them from a plan below.' }));

  if (loose.length) {
    pane.append(el('div', { class: 'sc-section-title', text: `In a plan but not shared (${loose.length})` }),
      el('p', { class: 'sc-faint small', text: 'These resources are written into one plan only. Add them to the directory and the same person can be used everywhere, with one rate.' }));
    const looseGrid = el('div', { class: 'person-grid' });
    for (const entry of loose) looseGrid.append(row(entry));
    pane.append(looseGrid);
  }
}
