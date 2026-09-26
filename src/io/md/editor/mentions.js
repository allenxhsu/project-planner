// Taken from Heptabase (src/core/editor/mentions.ts), compiled from TypeScript to plain JS so the
// planner's notes read and type the same way. Change it there first.

/**
 * Mention syntax.
 *
 * Cards are mentioned as `[[Title]]`: that form feeds backlinks and the graph,
 * and it is what imported Heptabase card references already use.
 *
 * Whiteboards, sections and journal days use ordinary Markdown links with a
 * `heptabase://` URL. Those are referenced by id rather than by name, because
 * their names aren't unique ("Section 1" exists on several whiteboards), and
 * they still read sensibly as plain text.
 */
const SCHEME = 'heptabase://';
export function mentionHref(target) {
    switch (target.kind) {
        // Cards are normally `[[Title]]`; an id link is for titles that aren't
        // unique, where a name alone would open the wrong card.
        case 'card':
            return `${SCHEME}card/${target.cardId}`;
        case 'board':
            return `${SCHEME}board/${target.boardId}`;
        case 'section':
            return `${SCHEME}section/${target.boardId}/${target.sectionId}`;
        case 'journal':
            return `${SCHEME}journal/${target.date}`;
    }
}
/** Brackets in a label would break the link, so they're dropped. */
export const mentionLink = (label, target) => `[${label.replace(/[[\]]/g, '')}](${mentionHref(target)})`;
export const cardMention = (title) => `[[${title.replace(/\]\]/g, '')}]]`;
export const cardEmbed = (title) => `![[${title.replace(/\]\]/g, '')}]]`;
export function parseMentionHref(href) {
    if (!href.startsWith(SCHEME))
        return null;
    const parts = href.slice(SCHEME.length).split('/');
    // Ids are uuids or similar: no dots-only segments, and exactly the expected
    // number of parts, so nothing path-like ever passes as an id.
    const safe = (s) => !!s && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes('..');
    if (parts[0] === 'card' && parts.length === 2 && safe(parts[1]))
        return { kind: 'card', cardId: parts[1] };
    if (parts[0] === 'board' && parts.length === 2 && safe(parts[1]))
        return { kind: 'board', boardId: parts[1] };
    if (parts[0] === 'section' && parts.length === 3 && safe(parts[1]) && safe(parts[2])) {
        return { kind: 'section', boardId: parts[1], sectionId: parts[2] };
    }
    if (parts[0] === 'journal' && parts.length === 2 && isCalendarDay(parts[1])) {
        return { kind: 'journal', date: parts[1] };
    }
    return null;
}
/** `YYYY-MM-DD` naming a day that exists: 2026-02-31 is not a journal page. */
function isCalendarDay(key) {
    const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m)
        return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}
