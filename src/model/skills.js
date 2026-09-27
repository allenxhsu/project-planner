// The character sheet: what a day of work costs, and what doing things teaches.
//
// Energy. Physical work — cleaning, moving boxes — drains stamina; mental
// work — study, design, writing — drains magic. Each refills by the next day.
// A task is one or the other: its own say, else its project's, else mental.
//
// Skills. Doing a thing makes you better at it. Every task trains a skill:
// its own, else its project's, else the project's folder or workspace
// ("Cooking", "ISEN Courses", "Personal"). Time spent on it — clocked, or a
// task ticked off — is experience in that skill, levelled like a game.
// Two skills come from elsewhere: Planning, from time spent in this app, and
// Software, from commits and prompts (the Mac app counts them).

export const ENERGY = { mental: 'Mental', physical: 'Physical' };
/**
 * How much a day's reserve holds, in minutes of work. It starts at four hours
 * of physical work for stamina and six of mental for magic, and grows a
 * quarter hour with every level of physical or mental experience — the more of
 * it someone has done, the more a day of it holds. That is the measure of
 * productivity: a bigger pool, not a fuller one.
 */
export const RESERVE_MIN = { physical: 4 * 60, mental: 6 * 60 };
export const POOL_PER_LEVEL = 15;
export const poolOf = (energy, level) => RESERVE_MIN[energy] + POOL_PER_LEVEL * Math.max(0, level - 1);

/** 'physical' or 'mental': the task's own, else its project's, else mental. */
export function energyOf(project, task) {
  if (task?.energy === 'physical' || task?.energy === 'mental') return task.energy;
  return project?.energy === 'physical' ? 'physical' : 'mental';
}

/**
 * The skill a task trains: the task's own, else the project's, else where
 * the project is filed — its folder, else its workspace — else the project.
 */
export function skillOf(project, task, { folderName = null, workspaceName = null } = {}) {
  const pick = [task?.skill, project?.skill, folderName, workspaceName, project?.name].find((x) => typeof x === 'string' && x.trim());
  return (pick || 'General').trim();
}

/** How much a Software point is worth, in minutes of experience. */
export const SOFTWARE_XP = { commit: 20, feature: 30, prompt: 3 };

/**
 * A level from minutes of experience. Each level asks for more than the last:
 * level n is reached at n·(n−1)·60 minutes — 2 h for level 2, 6 h for 3, 12 h
 * for 4, 100+ hours for 10 — so a first week moves fast and a year keeps moving.
 */
export function levelOf(minutes) {
  const m = Math.max(0, minutes || 0);
  let level = 1;
  while (m >= (level + 1) * level * 60) level++;
  const floor = level * (level - 1) * 60;
  const next = (level + 1) * level * 60;
  return { level, into: m - floor, need: next - floor, pct: Math.round(((m - floor) / (next - floor)) * 100) };
}
