// Taken from Heptabase (src/core/editor/triggers.ts), compiled from TypeScript to plain JS so the
// planner's notes read and type the same way. Change it there first.

/**
 * Detects an in-progress editor command from the text before the caret.
 *
 * Three triggers, matching Heptabase:
 *   `[[`  mention a card (closes with `]]`)
 *   `@`   mention a card, whiteboard, section or date
 *   `/`   insert a block
 *
 * Working from the value and caret position, not from keystrokes, means it
 * behaves the same for typing, pasting, undo, and clicking back into the
 * middle of an unfinished command.
 */
/** Longest query we keep a menu open for; anything longer is prose, not a lookup. */
const MAX_QUERY = 80;
export function detectTrigger(value, caret) {
    const before = value.slice(0, caret);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart);
    const lineEndRaw = value.indexOf('\n', caret);
    const after = value.slice(caret, lineEndRaw === -1 ? value.length : lineEndRaw);
    // [[ — the nearest unclosed pair on this line. A caret dropped inside a
    // link that is already closed (`[[Al|con]]`) is editing that link's text,
    // not asking for a card, so nothing opens there.
    const wikiAt = line.lastIndexOf('[[');
    if (wikiAt !== -1) {
        const query = line.slice(wikiAt + 2);
        const close = after.indexOf(']]');
        const open = after.indexOf('[[');
        const insideClosed = close !== -1 && (open === -1 || close < open);
        if (!query.includes(']]') && !query.includes('[[') && query.length <= MAX_QUERY && !insideClosed) {
            return { kind: 'wiki', start: lineStart + wikiAt, query };
        }
    }
    // Commands are typed at the end of a word. A caret dropped into the middle
    // of `/usr/local` or `@alice` is editing prose; picking a command there
    // would replace the text before the caret and leave the rest behind.
    if (after !== '' && !/^\s/.test(after))
        return null;
    // @ and / must start a word, so e-mail addresses and paths like
    // `and/or` or `https://` never open a menu.
    const at = findWordStartTrigger(line, '@');
    const slash = findWordStartTrigger(line, '/');
    const pick = [at, slash].filter((t) => !!t).sort((a, b) => b.index - a.index)[0];
    if (!pick)
        return null;
    const query = line.slice(pick.index + 1);
    if (query.length > MAX_QUERY)
        return null;
    if (pick.char === '/') {
        // Block commands are single words; a space ends the command.
        if (/\s/.test(query))
            return null;
        return { kind: 'slash', start: lineStart + pick.index, query };
    }
    // Titles contain spaces, so @ allows them, but a double space or a leading
    // space means the person has moved on.
    if (query.startsWith(' ') || query.includes('  '))
        return null;
    return { kind: 'at', start: lineStart + pick.index, query };
}
function findWordStartTrigger(line, char) {
    for (let i = line.length - 1; i >= 0; i--) {
        if (line[i] !== char)
            continue;
        const prev = i === 0 ? '' : line[i - 1];
        if (prev === '' || /\s/.test(prev))
            return { index: i, char };
        return null;
    }
    return null;
}
/**
 * Replaces the trigger and its query with `text`, placing the caret at
 * `caretOffset` inside the inserted text (default: its end).
 */
export function applyInsertion(value, trigger, caret, text, caretOffset = text.length) {
    // A `[[` mention may already have its closing brackets after the caret, when
    // the editor auto-closed them or the person typed inside an existing link.
    let end = caret;
    if (trigger.kind === 'wiki' && value.slice(caret, caret + 2) === ']]')
        end += 2;
    return {
        value: value.slice(0, trigger.start) + text + value.slice(end),
        caret: trigger.start + caretOffset,
    };
}
/**
 * Index of the first character of the line containing `pos`. (A plain
 * `lastIndexOf('\n', pos - 1)` is wrong at 0: a negative index searches from 0
 * and finds a newline that starts the *next* line.)
 */
const lineStartAt = (value, pos) => (pos <= 0 ? 0 : value.lastIndexOf('\n', pos - 1) + 1);
/** Prefix for the line the caret is on, replacing any existing block marker. */
export function setLinePrefix(value, caret, prefix) {
    const lineStart = lineStartAt(value, caret);
    const lineEndRaw = value.indexOf('\n', caret);
    const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;
    const line = value.slice(lineStart, lineEnd);
    const indent = line.match(/^\s*/)?.[0] ?? '';
    const marker = line.slice(indent.length).match(BLOCK_MARKER)?.[0] ?? '';
    const body = line.slice(indent.length + marker.length);
    const next = `${indent}${prefix}${body}`;
    // Keep the caret the same distance from the end of the line, so it stays on
    // the word it was on; if it sat inside the old marker, put it after the new one.
    const fromEnd = lineEnd - caret;
    const floor = lineStart + indent.length + prefix.length;
    return {
        value: value.slice(0, lineStart) + next + value.slice(lineEnd),
        caret: Math.max(floor, lineStart + next.length - Math.min(fromEnd, body.length)),
    };
}
const BLOCK_MARKER = /^(#{1,6}\s+|[-*+]\s+\[[ xX]?\]\s+|\[[ xX]?\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?|▸#{0,3}\s+)/;
/**
 * What Enter should do on a list line, or null to let a plain newline happen.
 *
 * On `[x] done`, Enter starts `[] ` (a fresh, unchecked item) and on `- [x] done`
 * it starts `- [ ] `; an unticked box keeps the spelling it was typed with, so
 * `[ ] a` continues as `[ ] `. On a numbered item Enter starts the next number;
 * on an item that is only a marker it removes the marker, which is how you leave
 * a list. On a `▸ Toggle` line it starts the toggle's body (an indented line),
 * and an indented line keeps its indent, so a body can be written without
 * reaching for Tab on every line.
 */
export function continueList(value, caret) {
    const lineStart = lineStartAt(value, caret);
    const lineEndRaw = value.indexOf('\n', caret);
    const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;
    const line = value.slice(lineStart, lineEnd);
    const m = line.match(/^(\s*)([-*+]\s+\[[ xX]?\]|\[[ xX]?\]|[-*+]|\d+[.)]|>|▸#{0,3})(\s+)/);
    if (!m) {
        const indent = line.match(/^[ \t]*/)?.[0] ?? '';
        // Only indented lines get special treatment, and only past the indent.
        if (!indent || caret - lineStart < indent.length)
            return null;
        if (line.trim() === '') {
            // An empty indented line: Enter steps out one level.
            const less = indent.replace(/( {1,2}|\t)$/, '');
            return { value: value.slice(0, lineStart) + less + value.slice(lineEnd), caret: lineStart + less.length };
        }
        const insert = `\n${indent}`;
        return { value: value.slice(0, caret) + insert + value.slice(caret), caret: caret + insert.length };
    }
    // Only continue when the caret is past the marker; Enter before it is a plain newline.
    if (caret - lineStart < m[0].length)
        return null;
    const [whole, indent, marker, gap] = m;
    if (line.trim() === marker.trim() || line.slice(whole.length).trim() === '') {
        // Empty item: leave the list by clearing its marker.
        return { value: value.slice(0, lineStart) + indent + value.slice(lineEnd), caret: lineStart + indent.length };
    }
    let insert;
    if (marker.startsWith('▸')) {
        // The body of a toggle is what follows its title.
        insert = `\n${indent}  `;
    }
    else {
        let next = marker;
        // A ticked box resets to the empty spelling of its own form: `[ ]` after a
        // bullet (the GFM form), `[]` when the box stands alone.
        if (/\[[xX]\]$/.test(marker))
            next = marker.replace(/\[[xX]\]$/, marker.startsWith('[') ? '[]' : '[ ]');
        const num = marker.match(/^(\d+)([.)])$/);
        if (num)
            next = `${Number(num[1]) + 1}${num[2]}`;
        insert = `\n${indent}${next}${gap}`;
    }
    return { value: value.slice(0, caret) + insert + value.slice(caret), caret: caret + insert.length };
}
/**
 * Tab / Shift+Tab: indents or outdents every line the selection touches by
 * one level (two spaces). This is how a line joins a toggle's body or a
 * nested list. Blank lines inside a multi-line selection are left alone so
 * they never gain trailing spaces; the caret's own line is always indented,
 * blank or not, so a fresh line can be nested before anything is typed.
 *
 * Any extra positions in `track` (say, where a dismissed command starts) are
 * mapped the same way and returned as `tracked`.
 */
export function indentLines(value, start, end, direction, track = []) {
    const from = lineStartAt(value, start);
    // A selection ending just after a newline doesn't include the next line.
    const lastChar = end > start ? end - 1 : end;
    const toRaw = value.indexOf('\n', lastChar);
    const to = toRaw === -1 ? value.length : toRaw;
    const src = value.slice(from, to).split('\n');
    const single = src.length === 1;
    const spans = [];
    let offset = from;
    const lines = src.map((line) => {
        const next = direction === 'in' ? (line === '' && !single ? line : `  ${line}`) : line.replace(/^( {1,2}|\t)/, '');
        spans.push({ start: offset, length: line.length, delta: next.length - line.length });
        offset += line.length + 1;
        return next;
    });
    // Where a position ends up: it moves with its text, except that a caret
    // sitting inside removed indentation lands at the start of its line.
    const map = (pos) => {
        if (pos < from)
            return pos;
        let moved = 0;
        for (const span of spans) {
            if (pos <= span.start + span.length) {
                const column = pos - span.start;
                if (span.delta < 0 && column < -span.delta)
                    return span.start + moved;
                return pos + moved + span.delta;
            }
            moved += span.delta;
        }
        return pos + moved;
    };
    const newStart = map(start);
    return {
        value: value.slice(0, from) + lines.join('\n') + value.slice(to),
        start: newStart,
        end: Math.max(newStart, map(end)),
        tracked: track.map(map),
    };
}
