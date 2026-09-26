// Starting a project, the way people actually start one: pick what it is like
// — a template, the sample, or nothing — then answer four questions. What is
// it called and where does it live; what phases does it run through and when
// is each due; who does the work of each; what else is worth recording about
// its tasks. What the answers do to the plan is model/setup.js.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { createProject, phases, phaseOf, isSummary, fieldsOf, FIELD_TYPES } from '../model/model.js';
import { sampleProject } from '../model/sample.js';
import { freshCopy, setUpProject, phaseFinishes } from '../model/setup.js';
import { toDay, fromDay, today, formatDate, makeCalendar, addMonths, monthStart, weekStart } from '../model/calendar.js';
import { open, foot, button, showMenu, showPanel, promptText } from './dialog.js';
import { datePanel } from './datepick.js';

const STEPS = [
  { id: 'name', label: 'Name & workspace' },
  { id: 'phases', label: 'Phases & dates' },
  { id: 'people', label: 'Assign people' },
  { id: 'fields', label: 'Custom fields' },
];
const SUGGESTED = ['Plan', 'Build', 'Launch'];

// ---------------------------------------------------------------- phase lengths
//
// A phase is shown as how long it runs, in working days: the first from the
// project start, each after that from the day after the one before it ends.
// Changing a length moves every later deadline with it, the way stretching one
// stage of a real plan pushes the rest.

function lengths(project, start, list) {
  const cal = makeCalendar(project.calendar);
  let prev = null;
  return list.map((ph) => {
    if (!ph.deadline) return null;
    const end = toDay(ph.deadline);
    const n = prev === null ? cal.distance(cal.next(toDay(start)), end) + 1 : cal.distance(prev, end);
    prev = end;
    return n;
  });
}
function relay(project, start, list, lens) {
  const cal = makeCalendar(project.calendar);
  let prev = null;
  list.forEach((ph, k) => {
    const n = lens[k];
    if (n === null || n === undefined) { if (ph.deadline) prev = toDay(ph.deadline); return; }
    const end = prev === null ? cal.add(cal.next(toDay(start)), Math.max(1, n) - 1) : cal.add(prev, Math.max(1, n));
    ph.deadline = fromDay(end);
    prev = end;
  });
}

// ---------------------------------------------------------------- fields editor

/** The list of custom fields, editable in place. `list` is changed as it is edited. */
export function fieldsEditor(list, redraw) {
  const box = el('div', { class: 'np-fields' });
  list.forEach((f, k) => {
    const options = el('input', {
      class: 'sc-input', type: 'text', value: (f.options || []).join(', '), placeholder: 'Options, separated by commas',
      oninput: (e) => { f.options = e.target.value.split(',').map((o) => o.trim()).filter(Boolean); },
    });
    box.append(el('div', { class: 'np-field' },
      el('input', { class: 'sc-input', type: 'text', value: f.name, placeholder: 'Field name', oninput: (e) => { f.name = e.target.value; } }),
      el('select', { class: 'sc-select', onchange: (e) => { f.type = e.target.value; redraw(); } },
        ...Object.entries(FIELD_TYPES).map(([id, label]) => el('option', { value: id, text: label, selected: f.type === id }))),
      f.type === 'select' || f.type === 'multi' ? options : el('span', { class: 'sc-faint small', text: f.type === 'person' || f.type === 'people' ? 'Someone on the plan' : '' }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '×', title: 'Remove this field', onclick: () => { list.splice(k, 1); redraw(); } })));
  });
  box.append(el('button', {
    class: 'sc-button sc-button--sm', text: '+ Add field',
    onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, Object.entries(FIELD_TYPES).map(([type, label]) => ({
        label, run: () => { list.push({ name: '', type, options: [] }); redraw(); setTimeout(() => box.parentElement?.querySelector('.np-field:last-of-type input')?.focus(), 0); },
      })));
    },
  }));
  return box;
}

/** Project ▸ Custom fields…: the same editor, for the plan that is open. */
export function editFieldsDialog() {
  const list = fieldsOf(store.project).map((f) => ({ ...f, options: [...f.options] }));
  return open('Custom fields', (close) => {
    const body = el('div', {});
    const draw = () => { clear(body); body.append(fieldsEditor(list, draw)); };
    draw();
    return [
      el('p', { class: 'sc-muted small', text: 'What this plan records about its tasks beyond the usual — a client, a budget code, a link to the brief. Each one shows on every task’s sheet.' }),
      body,
      foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)),
        button('Save', () => { act.setCustomFields(list); close(true); }, 'sc-button--primary')),
    ];
  }, { wide: true });
}

// ---------------------------------------------------------------- the wizard

async function templates() {
  const { listPlans } = await import('../state/sync.js');
  try { return (await listPlans()).filter((p) => p.template && p.ok); } catch { return []; }
}

export async function newProjectWizard() {
  const sync = await import('../state/sync.js');
  const [shelf, spaces, people] = await Promise.all([templates(), sync.listWorkspaces().catch(() => []), sync.listPeople().catch(() => [])]);

  const s = {
    step: null, base: null, from: '', name: '', workspaceId: sync.activeWorkspace() || '', start: fromDay(toDay(today())),
    onCalendar: true, phases: [], fields: [],
  };

  // What a choice in the gallery starts from.
  const begin = async (kind, id = null) => {
    let base;
    if (kind === 'scratch') base = createProject('', s.start);
    else if (kind === 'sample') base = sampleProject();
    else base = await sync.readPlan(id);
    if (!base) { act.hint('That template could not be read.'); return false; }
    if (kind !== 'scratch') { base.id = createProject().id; freshCopy(base, s.start); }
    s.base = base;
    s.from = kind === 'scratch' ? '' : base.name.replace(/\s*\(template\)\s*$/i, '');
    s.name = s.from;
    const ends = kind === 'scratch' ? new Map() : phaseFinishes(base);
    const leafCount = (phId) => base.tasks.filter((t, i) => !isSummary(base, i) && phaseOf(base, t.id) === phId).length;
    s.phases = phases(base).map((ph) => ({ id: ph.id, name: ph.name, deadline: ends.get(ph.id) || null, people: [], count: leafCount(ph.id) }));
    s.fields = fieldsOf(base).map((f) => ({ ...f, options: [...f.options] }));
    s.step = 'name';
    return true;
  };

  const done = await open('New project', (close) => {
    const body = el('div', { class: 'np-body' });
    const footer = el('div', {});
    // Where the step being drawn puts itself: the body, or the step's own box.
    let out = body;
    const put = (...nodes) => out.append(...nodes.filter(Boolean));

    const go = (step) => { s.step = step; draw(); };
    const stepIndex = () => STEPS.findIndex((x) => x.id === s.step);

    const create = async () => {
      if (!s.name.trim()) { go('name'); act.hint('The project needs a name.'); return; }
      // Someone typed in by name joins the directory, so the next plan knows them.
      for (const ph of s.phases) {
        for (const person of ph.people) {
          if (person.personId) continue;
          const rec = await sync.rememberPerson({ name: person.name }).catch(() => null);
          if (rec) person.personId = rec.id;
        }
      }
      const project = setUpProject(s.base, {
        name: s.name, workspaceId: s.workspaceId || null, start: s.start, onCalendar: s.onCalendar,
        phases: s.phases, fields: s.fields.filter((f) => f.name.trim()),
      });
      close(project);
    };

    // ---- the gallery
    const gallery = () => {
      const card = (mark, title, sub, run) => el('button', { class: 'np-card sc-card', onclick: run },
        el('div', { class: 'np-card-mark', text: mark }), el('div', { class: 'np-card-title', text: title }), el('div', { class: 'sc-faint small', text: sub }));
      const pick = (kind, id) => async () => { if (await begin(kind, id)) draw(); };
      put(
        el('p', { class: 'sc-muted small', text: 'Start from nothing, or from a plan already shaped like this one. A template’s tasks, links, phases and fields come across; its dates and progress do not.' }),
        el('div', { class: 'np-gallery' },
          card('+', 'Create from scratch', 'An empty plan, with the phases and fields you name', pick('scratch')),
          ...shelf.map((t) => card('▤', t.name.replace(/\s*\(template\)\s*$/i, ''), `${t.tasks} task${t.tasks === 1 ? '' : 's'} · template`, pick('template', t.id))),
          card('◈', 'Website relaunch', 'The sample plan, as a template', pick('sample'))),
        shelf.length ? null : el('p', { class: 'sc-faint small', text: 'Your own templates show here: on Projects, a plan’s menu has “Mark as a template”.' }));
      footer.append(foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null))));
    };

    // ---- step 1
    const stepName = () => {
      const name = el('input', { class: 'sc-input np-name', type: 'text', value: s.name, placeholder: 'Project name', 'data-autofocus': '', oninput: (e) => { s.name = e.target.value; } });
      const where = el('select', { class: 'sc-select', onchange: (e) => { s.workspaceId = e.target.value; } },
        el('option', { value: '', text: 'No workspace — shows everywhere', selected: !s.workspaceId }),
        ...spaces.map((w) => el('option', { value: w.id, text: w.name, selected: s.workspaceId === w.id })));
      const startBtn = el('button', {
        class: 'sc-button np-date', text: formatDate(s.start, 'long'),
        onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          showPanel(r.left, r.bottom + 4, (shut) => datePanel({
            value: s.start, title: 'Start', clearable: false,
            quick: [{ label: 'Today', day: toDay(today()) }, { label: 'Next Monday', day: weekStart(toDay(today())) + 7 },
              { label: 'First of next month', day: addMonths(monthStart(toDay(today())), 1) }],
            onPick: (iso) => {
              shut();
              const lens = lengths(s.base, s.start, s.phases);
              s.start = iso;
              relay(s.base, s.start, s.phases, lens);
              draw();
            },
          }));
        },
      });
      put(
        el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Project name' }), name),
        el('label', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Workspace' }), where),
        el('div', { class: 'sc-field' }, el('span', { class: 'sc-label', text: 'Starts' }), startBtn),
        el('label', { class: 'np-check' },
          el('input', { class: 'sc-check', type: 'checkbox', checked: s.onCalendar, onchange: (e) => { s.onCalendar = e.target.checked; } }),
          el('span', { text: 'Put its tasks on the calendar' })),
        s.from ? el('p', { class: 'sc-faint small', text: `From “${s.from}”: ${s.base.tasks.length} tasks, ${s.phases.length} phase${s.phases.length === 1 ? '' : 's'}, ${s.fields.length} custom field${s.fields.length === 1 ? '' : 's'}.` }) : null);
      setTimeout(() => name.focus(), 0);
    };

    // ---- step 2
    const stepPhases = () => {
      const lens = lengths(s.base, s.start, s.phases);
      const endOfLast = [...s.phases].reverse().find((ph) => ph.deadline)?.deadline;
      const now = toDay(today());
      const quick = [
        { label: 'Project start', day: toDay(s.start) },
        endOfLast ? { label: 'End of the last phase', day: toDay(endOfLast) } : null,
        { label: '7 days from now', day: now + 7 },
        { label: 'End of this month', day: addMonths(monthStart(now), 1) - 1 },
      ].filter(Boolean);
      const rows = el('div', { class: 'np-phases' });
      s.phases.forEach((ph, k) => {
        const len = el('input', {
          class: 'sc-input np-len', type: 'number', min: 1, step: 1, value: lens[k] ?? '', placeholder: '—',
          title: k === 0 ? 'Working days from the project start' : 'Working days after the phase before it ends',
          onchange: (e) => {
            const n = Math.round(+e.target.value);
            if (!(n >= 1)) { draw(); return; }
            const next = lengths(s.base, s.start, s.phases);
            next[k] = n;
            relay(s.base, s.start, s.phases, next);
            draw();
          },
        });
        const due = el('button', {
          class: `sc-button sc-button--sm np-date${ph.deadline ? '' : ' is-empty'}`, text: ph.deadline ? formatDate(ph.deadline, 'day') : 'Set deadline',
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showPanel(r.left, r.bottom + 4, (shut) => datePanel({
              value: ph.deadline, title: 'No deadline', quick,
              marks: new Map(s.phases.filter((x) => x.deadline && x !== ph).map((x) => [toDay(x.deadline), 'var(--sc-accent)'])),
              onPick: (iso) => { shut(); ph.deadline = iso || null; draw(); },
            }));
          },
        });
        rows.append(el('div', { class: 'np-phase' },
          el('span', { class: 'np-phase-num sc-mono', text: String(k + 1) }),
          el('input', { class: 'sc-input', type: 'text', value: ph.name, placeholder: 'Phase name', oninput: (e) => { ph.name = e.target.value; } }),
          el('span', { class: 'np-len-wrap' }, len, el('span', { class: 'sc-faint small', text: 'working days' })),
          due,
          el('span', { class: 'sc-faint small np-count', text: ph.id && ph.count ? `${ph.count} task${ph.count === 1 ? '' : 's'}` : '' }),
          el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '↑', title: 'Earlier', disabled: k === 0, onclick: () => { [s.phases[k - 1], s.phases[k]] = [s.phases[k], s.phases[k - 1]]; draw(); } }),
          el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '×', title: ph.count ? 'Remove this phase — its tasks keep going, in no phase' : 'Remove this phase', onclick: () => { s.phases.splice(k, 1); draw(); } })));
      });
      const add = (name) => {
        const last = s.phases[s.phases.length - 1];
        const ph = { name, deadline: null, people: [], count: 0 };
        s.phases.push(ph);
        // A new phase gets a week after the one before it, as a start.
        if (!last || last.deadline) { const L = lengths(s.base, s.start, s.phases); L[L.length - 1] = 5; relay(s.base, s.start, s.phases, L); }
      };
      rows.append(el('div', { class: 'np-phase-add' },
        el('button', { class: 'sc-button sc-button--sm', text: '+ Add phase', onclick: () => { add(''); draw(); setTimeout(() => body.querySelector('.np-phase:last-of-type input[type=text]')?.focus(), 0); } }),
        s.phases.length ? null : el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: `Use ${SUGGESTED.join(' · ')}`, onclick: () => { for (const n of SUGGESTED) add(n); draw(); } })));
      put(
        el('p', { class: 'sc-muted small', text: 'The stages the project runs through, and when each is due. A phase’s deadline becomes the deadline of every task in it that has none, so the calendar works towards it.' }),
        el('div', { class: 'np-phase-head sc-faint small' }, el('span', { text: `Starts ${formatDate(s.start, 'day')}` })),
        rows);
    };

    // ---- step 3
    const stepPeople = () => {
      if (!s.phases.length) {
        put(el('p', { class: 'sc-muted small', text: 'There are no phases to hand out. Add some in Phases & dates, or skip this — people can be put on tasks later.' }));
        return;
      }
      const known = [
        ...people.map((p) => ({ personId: p.id, name: p.name, initials: p.initials || '' })),
        ...s.base.resources.filter((r) => r.type === 'work' && !people.some((p) => p.id === r.personId)).map((r) => ({ personId: r.personId, name: r.name, initials: r.initials })),
      ];
      const list = el('div', { class: 'np-people' });
      for (const ph of s.phases) {
        const chips = ph.people.map((person, j) => el('span', { class: 'np-chip' }, person.name,
          el('button', { class: 'np-chip-x', text: '×', title: `Take ${person.name} off`, onclick: () => { ph.people.splice(j, 1); draw(); } })));
        const addBtn = el('button', {
          class: 'sc-button sc-button--ghost sc-button--sm', text: '+ Person',
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const free = known.filter((k) => !ph.people.some((x) => x.name.toLowerCase() === k.name.toLowerCase()));
            showMenu(r.left, r.bottom + 4, [
              ...(free.length ? free.map((k) => ({ label: k.name, run: () => { ph.people.push({ ...k }); draw(); } })) : [{ note: 'Nobody in the directory yet' }]),
              '-',
              { label: 'Someone new…', run: async () => {
                const name = await promptText('Someone new', 'Their name. They join the people directory, shared by every plan.', '');
                if (name?.trim()) { const k = { personId: null, name: name.trim(), initials: '' }; known.push(k); ph.people.push({ ...k }); draw(); }
              } },
            ]);
          },
        });
        list.append(el('div', { class: 'np-person-row' },
          el('div', { class: 'np-person-phase' }, el('strong', { text: ph.name || 'Unnamed phase' }),
            el('span', { class: 'sc-faint small', text: ph.id && ph.count ? `${ph.count} task${ph.count === 1 ? '' : 's'}` : 'no tasks yet' })),
          el('div', { class: 'np-chips' }, ...chips, addBtn)));
      }
      put(
        el('p', { class: 'sc-muted small', text: 'Who does the work of each phase. They are put on every task in it that has nobody yet; tasks that already name someone keep them.' }),
        list);
    };

    // ---- step 4
    const stepFields = () => {
      put(
        el('p', { class: 'sc-muted small', text: 'Anything else worth recording about each task — a client, a budget, a link to the brief. Each shows on every task’s sheet, and can be changed later from Project ▸ Custom fields….' }),
        fieldsEditor(s.fields, draw));
    };

    const draw = () => {
      clear(body); clear(footer);
      out = body;
      if (!s.step) { gallery(); return; }
      const i = stepIndex();
      const rail = el('ol', { class: 'np-rail' }, ...STEPS.map((st, k) => el('li', {
        class: `${k === i ? 'is-on' : ''}${k < i ? ' is-past' : ''}`, onclick: () => go(st.id),
      }, el('span', { class: 'np-rail-num', text: k < i ? '✓' : String(k + 1) }), el('span', { text: st.label }))));
      const inner = el('div', { class: 'np-step' });
      body.append(el('div', { class: 'np-layout' }, rail, el('div', { class: 'np-pane' }, el('h3', { class: 'np-step-title', text: STEPS[i].label }), inner)));
      out = inner;
      ({ name: stepName, phases: stepPhases, people: stepPeople, fields: stepFields })[s.step]();
      footer.append(foot(
        button('Back', () => (i === 0 ? (s.step = null, draw()) : go(STEPS[i - 1].id))),
        el('span', { class: 'sc-spacer' }),
        button('Cancel', () => close(null)),
        i < STEPS.length - 1 ? button('Skip to create', () => { void create(); }) : null,
        i < STEPS.length - 1
          ? button('Next', () => go(STEPS[i + 1].id), 'sc-button--primary')
          : button('Create project', () => { void create(); }, 'sc-button--primary')));
    };

    draw();
    return [body, footer];
  }, { wide: true });

  if (!done) return;
  await sync.startPlan(done);
  set({ view: 'gantt' });
  act.hint(`“${done.name}” is ready${done.phases.length ? `, in ${done.phases.length} phase${done.phases.length === 1 ? '' : 's'}` : ''}.`);
  const { reloadPlans } = await import('./projects.js');
  void reloadPlans();
}
