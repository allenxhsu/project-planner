// Settings ▸ Task defaults: what a new task starts with, as Motion has it —
// priority, duration, minimum chunk, auto-scheduled or not, and a deadline
// relative to the day it is made. Kept on this device.

const KEY = 'project-planner:task-defaults';
export const DEADLINE_RULES = { none: 'No deadline', today: 'Today', tomorrow: 'Tomorrow', week: 'In a week', twoWeeks: 'In two weeks' };
const FALLBACK = { urgency: 'normal', minutes: 30, chunk: '', auto: true, deadline: 'none', hard: false };

export function taskDefaults() {
  try { return { ...FALLBACK, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch { return { ...FALLBACK }; }
}
export function setTaskDefaults(change) {
  const next = { ...taskDefaults(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
/** The deadline a new task gets from the rule, 'YYYY-MM-DD' or ''. */
export function defaultDeadline(rule = taskDefaults().deadline) {
  const add = { today: 0, tomorrow: 1, week: 7, twoWeeks: 14 }[rule];
  if (add === undefined) return '';
  const d = new Date();
  d.setDate(d.getDate() + add);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
