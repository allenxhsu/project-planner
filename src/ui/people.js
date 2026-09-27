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
import { RESOURCE_TYPES, identityOf } from '../model/model.js';
import { toDay, today, fromDay } from '../model/calendar.js';
import { currentLayout, reloadCalendarPlans } from './calendar.js';
import { visibilityOf } from '../state/mode.js';
import { agendaOf } from '../model/agenda.js';
import {
  peopleWithLoad, rememberPerson, updatePerson, forgetPerson,
  attachProfile, detachProfile, syncConfigured, linkPlansToDirectory, unlinkedCount,
} from '../state/sync.js';
import { profilerUrl } from '../io/profile.js';
import { showMenu, confirmDialog, formDialog, showText, pickFile } from './dialog.js';

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
async function pickProfile(person) {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    const record = await attachProfile(person.id, await file.text());
    if (!record) throw new Error('That person is no longer in the directory.');
    await reloadPeople();
  } catch (err) {
    showText('That profile could not be read', err.message);
  }
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

/** Merge: this person is someone else too — their work moves across, and they go. */
async function mergeInto(person) {
  const others = people.map((x) => x.person).filter((x) => x !== person && !(person.id && x.id === person.id));
  if (!others.length) return;
  const answer = await formDialog('Merge people', [
    { key: 'keep', label: `${person.name} is the same person as`, type: 'select', value: String(0),
      options: others.map((o, i) => ({ value: String(i), label: `${o.name}${o.id ? '' : ' (not in the directory)'}` })) },
  ]);
  if (!answer) return;
  const keep = others[+answer.keep];
  if (!keep) return;
  const yes = await confirmDialog(`Merge ${person.name} into ${keep.name}?`,
    `Every project's work, logged time and calendars for ${person.name} become ${keep.name}'s, and ${person.name} leaves the directory. Undo in each project brings it back.`, 'Merge');
  if (!yes) return;
  const { mergePeople } = await import('../state/sync.js');
  const n = await mergePeople(keep, person);
  await reloadPeople();
  showText('Merged', `${person.name} is now ${keep.name} in ${n} ${n === 1 ? 'project' : 'projects'}.`);
}

// ---------------------------------------------------------------- today's bar
//
// A game's health bar for the day: how much of today's work a person has
// done. Done is the time they clocked today (Start task now, then Stop or
// Done) and, for a task simply ticked off today, its duration; to go is the
// focus work still laid for them today (background work needs no attention,
// so it counts for neither). A run of days with something finished is a
// streak. At work, home projects count for nothing here (state/mode.js).

const mins = (m) => { const r = Math.round(m); return r < 60 ? `${r}m` : `${Math.floor(r / 60)}h${r % 60 ? ` ${r % 60}m` : ''}`; };

/** key → { done, left, finished, streak } for everyone the calendar knows about today. */
function todayScores() {
  const out = new Map();
  let layout;
  try { layout = currentLayout(); } catch { return out; }
  const known = [...layout.entries, ...(layout.history || [])];
  const shown = (project) => visibilityOf(project.workspaceId) !== 'hide';
  const todayNum = toDay(today());
  const todayIso = today();
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const score = (key) => { if (!out.has(key)) out.set(key, { done: 0, left: 0, finished: 0, streak: 0, days: new Set() }); return out.get(key); };
  const planOf = (id) => known.find((e) => e.project.id === id)?.project;
  for (const b of layout.all.blocks) {
    if (b.day !== todayNum || b.background) continue;
    const project = planOf(b.planId);
    if (!project || !shown(project)) continue;
    for (const key of b.people || []) {
      if (b.worked) score(key).done += b.minutes;
      else score(key).left += Math.max(0, b.end - Math.max(b.start, now));
    }
  }
  // What the calendar had laid for each task today (it remembers the day's
  // layout): the credit for a task ticked off without clocking it.
  let laid = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem('project-planner:today-blocks') || 'null');
    if (saved?.day === todayNum) for (const b of saved.blocks || []) laid.set(`${b.planId}|${b.taskId}`, (laid.get(`${b.planId}|${b.taskId}`) || 0) + (b.end - b.start));
  } catch { laid = new Map(); }
  for (const { project, schedule } of known) {
    if (!shown(project)) continue;
    const clocked = new Set((project.timesheets || []).filter((x) => x.date === todayIso && Number.isFinite(x.start)).map((x) => x.taskId));
    for (const t of project.tasks) {
      if (!t.doneAt) continue;
      const day = t.doneAt.slice(0, 10);
      const keys = t.assignments.map((a) => project.resources.find((r) => r.id === a.resourceId)).filter(Boolean).map(identityOf);
      for (const key of keys) {
        const s = score(key);
        s.days.add(day);
        if (day !== todayIso) continue;
        s.finished += 1;
        // Ticked off without clocking: the time laid for it today, else one of its chunks.
        if (!clocked.has(t.id)) {
          const work = Math.round((schedule.tasks[t.id]?.work ?? t.work ?? 1) * 60);
          s.done += laid.get(`${project.id}|${t.id}`) ?? Math.min(work, Math.round(agendaOf(project, t).blockHours * 60));
        }
      }
    }
  }
  for (const s of out.values()) {
    // Days in a row with something finished, up to today (or yesterday, if today has nothing yet).
    let d = s.days.has(todayIso) ? todayNum : todayNum - 1;
    while (s.days.has(fromDay(d))) { s.streak++; d--; }
  }
  return out;
}

function healthBar(s) {
  const total = s.done + s.left;
  if (!total && !s.finished) return el('div', { class: 'hp hp-idle sc-faint small', text: 'Nothing on today' });
  const pct = total ? Math.min(100, Math.round((s.done / total) * 100)) : 100;
  const tier = pct >= 100 ? 'full' : pct >= 60 ? 'high' : pct >= 25 ? 'mid' : 'low';
  return el('div', { class: `hp is-${tier}`, title: `${mins(s.done)} done today, ${mins(s.left)} still to go` },
    el('div', { class: 'hp-top' },
      el('span', { class: 'hp-label', text: pct >= 100 ? '✦ Day cleared' : `Today · ${pct}%` }),
      s.streak > 1 ? el('span', { class: 'hp-streak', title: `${s.streak} days in a row with something finished`, text: `🔥 ${s.streak}` }) : null,
      el('span', { class: 'sc-spacer' }),
      el('span', { class: 'hp-num sc-mono', text: `${mins(s.done)} / ${mins(total)}` })),
    el('div', { class: 'hp-track' },
      el('div', { class: 'hp-fill', style: { width: `${pct}%` } }),
      // A notch every hour of the day's work, like a game's segmented bar.
      ...Array.from({ length: Math.max(0, Math.floor(total / 60)) }, (_, i) => el('span', { class: 'hp-notch', style: { left: `${((i + 1) * 60 / total) * 100}%` } }))),
    el('div', { class: 'hp-foot sc-faint small', text: `${s.finished} task${s.finished === 1 ? '' : 's'} finished${s.left ? ` · ${mins(s.left)} to go` : ''}` }));
}

let scores = new Map();
let calendarAsked = false;

function row(entry) {
  const { person, plans, tasks, hours, cost } = entry;
  const key = person.id ? `person:${person.id}` : `who:${String(person.name || '').trim().toLowerCase()}`;
  const today_ = scores.get(key) || { done: 0, left: 0, finished: 0, streak: 0 };
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
      { label: 'Merge into someone else…', run: () => void mergeInto(person) },
      { label: 'Take out of the directory', danger: true, run: async () => {
        const yes = await confirmDialog(`Take ${person.name} out of the directory?`,
          'Plans they are already on keep them — this only stops them being offered for new work.');
        if (!yes) return;
        await forgetPerson(person.id);
        await reloadPeople();
      } },
    ] : [
      { label: 'Add to the directory', run: async () => { await rememberPerson({ name: person.name, initials: person.initials, type: person.resourceType, rate: person.rate, group: person.group }); await reloadPeople(); } },
      { label: 'Merge into someone else…', run: () => void mergeInto(person) },
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
    healthBar(today_),
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
  // The bars read every plan's day, as the calendar does: have it read them once.
  if (!calendarAsked) { calendarAsked = true; void reloadCalendarPlans(); }
  scores = todayScores();
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
