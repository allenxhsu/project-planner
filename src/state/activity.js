// Planning skill and software skill: what this device can tell about them.
//
// Planning: the minutes someone is actually using this app — a click, a key,
// a scroll in the last minute, with the window in front — counted a minute at
// a time into today's record (state/sync.js stats), never the what or where.
//
// Software: the Mac app counts, from files already on this Mac, the commits
// made in the ClaudWorkSpace repositories and the prompts written to Claude
// Code, a day at a time — numbers only, no text (macos SkillProbe.swift).

import { hosted, post } from '../host.js';
import { today } from '../model/calendar.js';

let lastInput = 0;
let started = false;

export function watchActivity() {
  if (started) return;
  started = true;
  const mark = () => { lastInput = Date.now(); };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, mark, { passive: true, capture: true });
  setInterval(async () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastInput > 60_000) return;
    const { updateStat } = await import('./sync.js');
    await updateStat(today(), (d) => { d.planning = (d.planning || 0) + 1; });
  }, 60_000);
  if (hosted) {
    window.addEventListener('host-skills', async (e) => {
      const days = e.detail?.days;
      if (!days || typeof days !== 'object') return;
      const { setStatDays } = await import('./sync.js');
      await setStatDays(days);
      window.dispatchEvent(new Event('planner-stats'));
    });
    const ask = () => post({ type: 'probeSkills' });
    setTimeout(ask, 5_000);
    setInterval(ask, 60 * 60_000);
  }
}
