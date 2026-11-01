// The built-in routine: plan the next day's action items.
//
// One of a day's three maintenance slots is always this — half an hour at the
// end of the working day to write down what tomorrow is for. It is a routine
// like any other (model/routines.js): a weekday pattern whose occurrences are
// real tasks, logged and ticked off like anything else, so a day that skipped
// it shows it late. What is different is that nobody has to make it: a plan
// that lacks it gets it the first time routines come round, and the day's
// focus (model/focus.js) keeps a maintenance slot for it.

import { insertTask, spawnRoutines } from './model.js';
import { cleanRepeat } from './routines.js';

/** One fixed id, so the routine opened on two devices is one routine to sync, not two. */
export const PLANNING_ROUTINE_ID = 't_plan_tomorrow';
export const PLANNING_ROUTINE = {
  name: 'Plan the next day’s action items',
  /** The mark on the pattern and its occurrences; the roster reserves a slot for it. */
  builtin: 'plan-tomorrow',
  work: 0.5,
};

/**
 * Make the planning routine in a plan that lacks it, and its occurrences
 * from `todayIso` on. Returns the routine made, or null when the plan already
 * has it — asked every time routines come round, it makes nothing twice.
 */
export function ensurePlanningRoutine(p, todayIso) {
  if (p.tasks.some((t) => t.id === PLANNING_ROUTINE_ID)) return null;
  const r = insertTask(p, p.tasks.length, {
    id: PLANNING_ROUTINE_ID, name: PLANNING_ROUTINE.name, level: 1, duration: 1, work: PLANNING_ROUTINE.work,
    // Upkeep, not progress: it ranks as maintenance, and after the day's other routines.
    urgency: 'low', builtin: PLANNING_ROUTINE.builtin, endOfDay: true,
    repeat: cleanRepeat({ freq: 'weekdays', from: todayIso }),
    // The pattern is not on the calendar; its occurrences are, in one half-hour sitting.
    calendar: { show: false, timeBlockIds: [], blockHours: 0.5, whole: true },
  });
  r.activity = (r.activity || []).slice(0, 1);
  spawnRoutines(p, todayIso);
  return r;
}
