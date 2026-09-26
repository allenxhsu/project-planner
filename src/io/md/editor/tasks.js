// Taken from Heptabase (src/core/editor/tasks.ts), compiled from TypeScript to plain JS so the
// planner's notes read and type the same way. Change it there first.

/**
 * Ticking a task in rendered Markdown edits its source line, so the checkbox
 * on screen and the `[x]` in storage never disagree.
 */
import { parseTaskLine } from '../markdown.js';
/**
 * Flips (or sets) the checkbox on source line `line`. Any other line - or a
 * line that isn't a task - leaves the source untouched. Only the box changes:
 * the rest of the line, indent and bullet included, is kept byte for byte.
 */
export function toggleTask(source, line, checked) {
    const lines = source.split('\n');
    const task = lines[line] === undefined ? null : parseTaskLine(lines[line]);
    if (!task)
        return source;
    const next = checked ?? !task.checked;
    // An unticked box keeps the spelling of the form it sits in: `[ ]` inside a
    // list item (the GFM form the importer writes), `[]` when it stands alone.
    const box = next ? '[x]' : task.marker ? '[ ]' : '[]';
    const at = task.indent.length + task.marker.length;
    lines[line] = lines[line].slice(0, at) + box + lines[line].slice(at + task.box.length);
    return lines.join('\n');
}
