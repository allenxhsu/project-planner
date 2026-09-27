// The character sheet on People: the day as a game.
//
// Tasks are quests. Health is how much of today's quests are done. Physical
// work drains stamina and mental work drains magic, from pools that grow with
// every level of physical or mental experience — a bigger pool is the measure
// of productivity. Doing things levels the skills they train (model/skills.js);
// for the person using the app, Planning (time in it) and Software (commits
// and prompts) level too. At work, home projects count for nothing (state/mode.js).

import { el } from '../util.js';
import { toDay, today, fromDay } from '../model/calendar.js';
import { agendaOf } from '../model/agenda.js';
import { identityOf } from '../model/model.js';
import { energyOf, skillOf, levelOf, poolOf, SOFTWARE_XP } from '../model/skills.js';
import { visibilityOf } from '../state/mode.js';
import { workspaceNow } from '../state/sync.js';

const mins = (m) => { const r = Math.round(m); return r < 60 ? `${r}m` : `${Math.floor(r / 60)}h${r % 60 ? ` ${r % 60}m` : ''}`; };

/** Planning and Software, summed over every device's stat record: { planning, software, today: {…} }. */
export function selfStats(records) {
  const todayIso = today();
  let planning = 0, software = 0;
  const now = { planning: 0, software: 0 };
  for (const r of records || []) {
    for (const [date, d] of Object.entries(r.days || {})) {
      const p = +d.planning || 0;
      const s = (+d.commits || 0) * SOFTWARE_XP.commit + (+d.features || 0) * SOFTWARE_XP.feature + (+d.prompts || 0) * SOFTWARE_XP.prompt;
      planning += p; software += s;
      if (date === todayIso) { now.planning += p; now.software += s; }
    }
  }
  return { planning, software, today: now };
}

/**
 * key → the character of everyone on the calendar's plans: today's health,
 * stamina and magic, their energy levels, and the skills they have trained.
 */
export function characterScores(layout) {
  const out = new Map();
  if (!layout) return out;
  const known = [...layout.entries, ...(layout.history || [])];
  const shown = (project) => visibilityOf(project.workspaceId) !== 'hide';
  const todayNum = toDay(today());
  const todayIso = today();
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const of = (key) => {
    if (!out.has(key)) out.set(key, { done: 0, left: 0, finished: 0, days: new Set(), streak: 0, spent: { physical: 0, mental: 0 }, xp: { physical: 0, mental: 0 }, skills: new Map() });
    return out.get(key);
  };
  const where = (project) => {
    const w = workspaceNow(project.workspaceId);
    return { workspaceName: w?.name || null, folderName: (w?.folders || []).find((f) => f.id === project.folderId)?.name || null };
  };
  // What the calendar had laid for each task today: the credit for a quest ticked off without clocking it.
  let laid = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem('project-planner:today-blocks') || 'null');
    if (saved?.day === todayNum) for (const b of saved.blocks || []) laid.set(`${b.planId}|${b.taskId}`, (laid.get(`${b.planId}|${b.taskId}`) || 0) + (b.end - b.start));
  } catch { laid = new Map(); }

  const earn = (s, skill, energy, minutes, isToday) => {
    s.xp[energy] += minutes;
    const k = s.skills.get(skill) || { minutes: 0, today: 0 };
    k.minutes += minutes;
    if (isToday) k.today += minutes;
    s.skills.set(skill, k);
  };

  // Today's quests still to do: the focus work the calendar has laid from now on.
  for (const b of layout.all.blocks) {
    if (b.day !== todayNum || b.background || b.worked) continue;
    const project = known.find((e) => e.project.id === b.planId)?.project;
    if (!project || !shown(project)) continue;
    for (const key of b.people || []) of(key).left += Math.max(0, b.end - Math.max(b.start, now));
  }

  for (const { project, schedule } of known) {
    if (!shown(project)) continue;
    const place = where(project);
    const whoOf = (t, resourceId = null) => (resourceId
      ? [project.resources.find((r) => r.id === resourceId)].filter(Boolean)
      : t.assignments.map((a) => project.resources.find((r) => r.id === a.resourceId)).filter(Boolean)).map(identityOf);
    // Experience: every stretch of clocked time, ever.
    const clocked = new Set();
    for (const x of project.timesheets || []) {
      const t = project.tasks.find((y) => y.id === x.taskId);
      if (!t) continue;
      const minutes = Math.round((+x.hours || 0) * 60);
      if (!minutes) continue;
      clocked.add(`${t.id}|${x.date}`);
      const energy = energyOf(project, t);
      for (const key of whoOf(t, x.resourceId)) {
        const s = of(key);
        earn(s, skillOf(project, t, place), energy, minutes, x.date === todayIso);
        if (x.date === todayIso && t.attention !== 'background') { s.done += minutes; s.spent[energy] += minutes; }
      }
    }
    // Quests ticked off without clocking: the time laid for them (today), else a chunk of them.
    for (const t of project.tasks) {
      if (!t.doneAt) continue;
      const day = t.doneAt.slice(0, 10);
      const energy = energyOf(project, t);
      const work = Math.round((schedule.tasks[t.id]?.work ?? t.work ?? 1) * 60);
      const credit = clocked.has(`${t.id}|${day}`) ? 0 : (day === todayIso ? laid.get(`${project.id}|${t.id}`) : null) ?? Math.min(work, Math.round(agendaOf(project, t).blockHours * 60));
      for (const key of whoOf(t)) {
        const s = of(key);
        s.days.add(day);
        if (credit) earn(s, skillOf(project, t, place), energy, credit, day === todayIso);
        if (day !== todayIso) continue;
        s.finished += 1;
        if (credit && t.attention !== 'background') { s.done += credit; s.spent[energy] += credit; }
      }
    }
  }
  for (const s of out.values()) {
    let d = s.days.has(todayIso) ? todayNum : todayNum - 1;
    while (s.days.has(fromDay(d))) { s.streak++; d--; }
  }
  return out;
}

const bar = (cls, label, pct, right, title = '') => el('div', { class: `cs-bar ${cls}`, title },
  el('div', { class: 'cs-bar-top' }, el('span', { class: 'cs-bar-label', text: label }), el('span', { class: 'sc-spacer' }), el('span', { class: 'cs-bar-num sc-mono', text: right })),
  el('div', { class: 'cs-track' }, el('div', { class: 'cs-fill', style: { width: `${Math.max(0, Math.min(100, pct))}%` } })));

/**
 * A person's sheet: level, health, stamina, magic, and their top skills.
 * `self` (the app's own user) adds Planning and Software.
 */
export function characterSheet(s, self = null) {
  s = s || { done: 0, left: 0, finished: 0, streak: 0, spent: { physical: 0, mental: 0 }, xp: { physical: 0, mental: 0 }, skills: new Map() };
  const skills = new Map(s.skills);
  if (self) {
    skills.set('Planning', { minutes: self.planning, today: self.today.planning, special: true });
    skills.set('Software', { minutes: self.software, today: self.today.software, special: true });
  }
  const total = [...skills.values()].reduce((n, k) => n + k.minutes, 0);
  const overall = levelOf(total / 3);
  const phys = levelOf(s.xp.physical);
  const ment = levelOf(s.xp.mental);
  const staminaPool = poolOf('physical', phys.level);
  const magicPool = poolOf('mental', ment.level);
  const stamina = Math.max(0, staminaPool - s.spent.physical);
  const magic = Math.max(0, magicPool - s.spent.mental);
  const dayTotal = s.done + s.left;
  const health = dayTotal ? Math.round((s.done / dayTotal) * 100) : (s.finished ? 100 : 0);
  const top = [...skills.entries()].filter(([, k]) => k.minutes > 0 || k.special).sort((a, b) => b[1].minutes - a[1].minutes).slice(0, self ? 6 : 4);
  return el('div', { class: 'cs' },
    el('div', { class: 'cs-head' },
      el('span', { class: 'cs-level', title: `${mins(total)} of experience across every skill` }, el('small', { text: 'Lv' }), String(overall.level)),
      el('span', { class: 'cs-quests', text: `${s.finished} quest${s.finished === 1 ? '' : 's'} done today` }),
      s.streak > 1 ? el('span', { class: 'cs-streak', title: `${s.streak} days in a row with a quest done`, text: `🔥 ${s.streak}` }) : null),
    bar(`is-health${health >= 100 ? ' is-full' : ''}`, health >= 100 && dayTotal ? '✦ Day cleared' : 'Health', health, `${mins(s.done)} / ${mins(dayTotal)}`, 'Today’s quests done, of today’s quests'),
    bar('is-stamina', `Stamina · Lv ${phys.level}`, (stamina / staminaPool) * 100, `${mins(stamina)} / ${mins(staminaPool)}`, `Physical work drains it. The pool grows with every physical level (${phys.pct}% to the next).`),
    bar('is-magic', `Magic · Lv ${ment.level}`, (magic / magicPool) * 100, `${mins(magic)} / ${mins(magicPool)}`, `Mental work drains it. The pool grows with every mental level (${ment.pct}% to the next).`),
    top.length ? el('div', { class: 'cs-skills' }, ...top.map(([name, k]) => {
      const l = levelOf(k.minutes);
      return el('div', { class: `cs-skill${k.special ? ' is-special' : ''}`, title: `${name}: ${mins(k.minutes)} of experience, ${l.pct}% to level ${l.level + 1}` },
        el('span', { class: 'cs-skill-name', text: name }),
        el('span', { class: 'cs-skill-lv sc-mono', text: `Lv ${l.level}` }),
        el('div', { class: 'cs-skill-track' }, el('div', { style: { width: `${l.pct}%` } })),
        el('span', { class: 'cs-skill-gain sc-mono', text: k.today ? `+${mins(k.today)}` : '' }));
    })) : null);
}
