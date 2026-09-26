// Taken from Heptabase (src/core/editor/inputRules.ts), compiled from TypeScript to plain JS so the
// planner's notes read and type the same way. Change it there first.

/**
 * Markdown shorthands that finish themselves when Space is pressed.
 *
 * A checkbox needs no rule: `[]` at the start of a line is the syntax, as
 * typed, and the renderer reads it as is. What is left is bullet spelling:
 * `*` and `+` are legal Markdown but read oddly next to `-` lists, so they
 * become `- `. The rule runs on the text before the caret, so it behaves the
 * same whether the marker was typed or pasted, and it only ever rewrites the
 * caret's own line.
 */
import { verbatimAt } from '../markdown.js';
/** Head of the caret's line → what replaces it (`$1` is leading whitespace). */
const RULES = [[/^(\s*)[*+]$/, '$1- ']];
/**
 * What Space should turn the caret's line into, or null to type the space.
 * The caret lands after the inserted text; whatever followed it stays.
 */
export function applyInputRule(value, caret) {
    const lineStart = caret <= 0 ? 0 : value.lastIndexOf('\n', caret - 1) + 1;
    const head = value.slice(lineStart, caret);
    for (const [re, replacement] of RULES) {
        if (!re.test(head))
            continue;
        // Inside a code fence `*` is code, and inside a maths block `+` is a
        // sign, not a bullet: the renderer shows both verbatim.
        const at = value.slice(0, lineStart).split('\n').length - 1;
        if (verbatimAt(value.split('\n'), at))
            return null;
        const next = head.replace(re, replacement);
        return { value: value.slice(0, lineStart) + next + value.slice(caret), caret: lineStart + next.length };
    }
    return null;
}
