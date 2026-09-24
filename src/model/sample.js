// The worked sample: a website relaunch. Row numbers in `preds` refer to the
// table below, one-based, exactly as the grid shows them.

import { createProject, newTask, newResource } from './model.js';

const T = (level, name, duration, preds = '', extra = {}) => ({ level, name, duration, preds, ...extra });

const ROWS = [
  T(1, 'Discovery', 0),
  T(2, 'Kick-off workshop', 1, '', { res: 'PM,DS,LD', percent: 100 }),
  T(2, 'Stakeholder interviews', 4, '2', { res: 'PM,UX', percent: 100 }),
  T(2, 'Content audit', 5, '2', { res: 'CW', percent: 80 }),
  T(2, 'Analytics review', 3, '2', { res: 'UX', percent: 100 }),
  T(2, 'Requirements signed off', 0, '3,4,5', { res: 'PM' }),
  T(1, 'Design', 0),
  T(2, 'Information architecture', 4, '6', { res: 'UX' }),
  T(2, 'Wireframes', 6, '8', { res: 'UX', notes: 'Desktop and mobile breakpoints.' }),
  T(2, 'Visual design', 8, '9SS+3d', { res: 'DS' }),
  T(2, 'Design review', 2, '9,10', { res: 'PM,DS,UX,LD' }),
  T(2, 'Design approved', 0, '11', { res: 'PM', deadline: true }),
  T(1, 'Build', 0),
  T(2, 'Environment set-up', 2, '6', { res: 'DV2' }),
  T(2, 'Component library', 7, '10SS+4d,14', { res: 'DV1' }),
  T(2, 'Page templates', 8, '15,12', { res: 'DV1,DV2' }),
  T(2, 'CMS integration', 6, '14,15', { res: 'DV2' }),
  T(2, 'Content migration', 6, '4,17SS+2d', { res: 'CW' }),
  T(2, 'QA and accessibility', 5, '16,17,18', { res: 'QA' }),
  T(2, 'Bug fixing', 4, '19SS+2d', { res: 'DV1,DV2' }),
  T(1, 'Launch', 0),
  T(2, 'Performance testing', 2, '20', { res: 'QA,DV2' }),
  T(2, 'Stakeholder sign-off', 1, '20,22', { res: 'PM,LD' }),
  T(2, 'Go live', 0, '23', { res: 'DV2' }),
  T(2, 'Post-launch support', 5, '24', { res: 'DV1' }),
];

const RESOURCES = [
  ['PM', 'Priya Malik', 'Project manager', 95],
  ['UX', 'Uma Chen', 'UX designer', 80],
  ['DS', 'Dan Sato', 'Visual designer', 80],
  ['DV1', 'Devi Rao', 'Front-end developer', 85],
  ['DV2', 'Diego Vega', 'Back-end developer', 85],
  ['CW', 'Cara Wells', 'Content writer', 60],
  ['QA', 'Quinn Adler', 'QA engineer', 70],
  ['LD', 'Lena Diaz', 'Sponsor', 0],
];

export function sampleProject() {
  const p = createProject('Website relaunch', '2026-09-21');
  // A fixed id, so the sample opened on two devices is one plan to sync, not two.
  p.id = 'plan_sample_website_relaunch';
  p.statusDate = null;
  p.calendar.holidays = ['2026-11-26', '2026-12-25', '2027-01-01'];
  const res = {};
  for (const [ini, name, group, rate] of RESOURCES) {
    const r = newResource({ id: `r_${ini.toLowerCase()}`, name, initials: ini, group, rate, maxUnits: 1 });
    res[ini] = r;
    p.resources.push(r);
  }
  const tasks = ROWS.map((r, i) => newTask({
    id: `t_${String(i + 1).padStart(2, '0')}`, name: r.name, level: r.level, duration: r.duration, milestone: r.duration === 0 && r.level === 2,
    percent: r.percent || 0, notes: r.notes || '',
    assignments: (r.res ? r.res.split(',') : []).map((ini) => ({ resourceId: res[ini].id, units: 1 })),
  }));
  tasks.forEach((t, i) => {
    const preds = ROWS[i].preds;
    if (!preds) return;
    t.predecessors = preds.split(',').map((s) => {
      const m = s.trim().match(/^(\d+)(FS|SS|FF|SF)?(?:([+-])(\d+)d)?$/);
      return { id: tasks[+m[1] - 1].id, type: m[2] || 'FS', lag: m[3] ? (m[3] === '-' ? -1 : 1) * +m[4] : 0 };
    });
  });
  tasks[11].deadline = '2026-11-13';
  tasks[23].deadline = '2027-01-15';
  // The kick-off is pinned to the day it happened.
  tasks[1].constraint = { type: 'SNET', date: '2026-09-21' };
  p.tasks = tasks;
  return p;
}
