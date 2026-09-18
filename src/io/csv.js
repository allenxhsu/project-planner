// Task list as CSV: what a spreadsheet or another planner reads.

import { toCsv, parseCsv } from '../util.js';
import { formatPredecessors, formatAssignments, createProject, newTask, parsePredecessors, parseAssignments, normalizeLevels } from '../model/model.js';
import { formatDuration, parseDuration, isoValid } from '../model/calendar.js';

export function exportCsv(p, sched) {
  const rows = [['ID', 'WBS', 'Level', 'Name', 'Duration', 'Start', 'Finish', 'Predecessors', 'Resources', '% Complete', 'Work (h)', 'Cost', 'Slack', 'Critical', 'Milestone', 'Deadline', 'Notes']];
  p.tasks.forEach((t, i) => {
    const s = sched.tasks[t.id];
    rows.push([i + 1, s.wbs, t.level, t.name, formatDuration(s.duration), s.startIso, s.finishIso, formatPredecessors(p, t), formatAssignments(p, t),
      s.percent, Math.round(s.work * 10) / 10, Math.round(s.cost * 100) / 100, s.summary ? '' : s.slack, s.critical ? 'Yes' : 'No', s.milestone ? 'Yes' : 'No', t.deadline || '', t.notes]);
  });
  return toCsv(rows);
}

/**
 * Read a CSV with at least a Name column. Recognised headers (case-insensitive):
 * Name, Level/Outline Level, Duration, Predecessors, Resources/Resource Names,
 * % Complete, Start, Deadline, Notes. Predecessors are row numbers.
 */
export function importCsv(text, name = 'Imported plan') {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The CSV has no task rows.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const cName = col('name', 'task name', 'task'), cLevel = col('level', 'outline level'), cDur = col('duration'), cPred = col('predecessors'),
    cRes = col('resources', 'resource names'), cPct = col('% complete', 'percent complete', 'percent'), cStart = col('start'), cDead = col('deadline'), cNotes = col('notes');
  if (cName < 0) throw new Error('The CSV needs a “Name” column.');
  const p = createProject(name);
  const preds = [];
  for (const r of rows.slice(1)) {
    const t = newTask({ name: r[cName] || 'Untitled task', level: cLevel >= 0 ? Math.max(1, parseInt(r[cLevel], 10) || 1) : 1 });
    try { if (cDur >= 0) t.duration = parseDuration(r[cDur] || '1d'); } catch { t.duration = 1; }
    t.milestone = t.duration === 0;
    if (cPct >= 0) t.percent = Math.max(0, Math.min(100, Math.round(parseFloat(r[cPct]) || 0)));
    if (cStart >= 0 && isoValid(r[cStart])) t.constraint = { type: 'SNET', date: r[cStart] };
    if (cDead >= 0 && isoValid(r[cDead])) t.deadline = r[cDead];
    if (cNotes >= 0) t.notes = r[cNotes] || '';
    if (cRes >= 0) t.assignments = parseAssignments(p, r[cRes]);
    preds.push(cPred >= 0 ? r[cPred] : '');
    p.tasks.push(t);
  }
  normalizeLevels(p);
  const skipped = [];
  p.tasks.forEach((t, i) => { try { t.predecessors = parsePredecessors(p, preds[i], t.id); } catch (err) { skipped.push(`Row ${i + 1}: ${err.message}`); } });
  // Anything with a start date and a level came from a planner; a plain list gets a chain.
  return { project: p, skipped };
}
