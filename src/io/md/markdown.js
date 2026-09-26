// Taken from Heptabase (src/core/markdown.ts), compiled from TypeScript to plain JS so the
// planner's notes read and type the same way. Change it there first.

/**
 * A small, dependency-free Markdown renderer.
 *
 * Hand-rolled rather than pulled from npm for two reasons: `[[wiki links]]`
 * need first-class support (they drive the whole backlink graph, so they can't
 * be a bolted-on post-pass), and card previews re-render constantly while
 * dragging, so the renderer needs to stay small and predictable.
 *
 * Output is an HTML string. Every piece of user text is escaped before it
 * reaches the output, and inline constructs are only ever built from already
 * escaped fragments.
 */
import { parseMentionHref } from './editor/mentions.js';
const ASSET_ID = /^[A-Za-z0-9._-]{1,128}$/;
export function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
/** Undoes escapeHtml, for comparing an escaped label with a raw title. */
const decodeHtml = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITY[e]);
// A link never spans a line break. Allowing newlines let a stray `[[` inside a
// code span swallow whole paragraphs up to the next `]]`, which produced
// nonsense link targets and polluted the derived graph. `\[[` is an escaped
// bracket, not a link.
export const WIKILINK = /(?<!\\)\[\[([^\]\n]+)\]\]/g;
/*
 * The inline grammar, shared with the live editor (core/editor/live.ts) so the
 * page it draws while editing is the page the renderer draws. Every pattern
 * runs over HTML-escaped text, one rule after another, as inline() applies them.
 */
/**
 * Backslash escapes, code spans and inline maths, read in one left-to-right
 * pass. `>` and friends arrive HTML-escaped, hence the entity forms. No space
 * just inside the dollars, so prices like "$5 and $10" aren't a formula.
 */
export const INLINE_LEAD = /\\(&gt;|&lt;|&amp;|&quot;|&#39;|[\\*~=#+.)|▸`$[\]!-])|`([^`]+)`|(^|[^\w$\\])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?![\w$])/g;
/** A label never contains a bracket or a line break, which keeps the scan linear. */
export const IMAGE = /!\[([^[\]\n]*)\]\(([^)\s]+)\)/g;
export const LINK = /\[([^[\]\n]+)\]\(([^)\s]+)\)/g;
export const BARE_URL = /(^|[\s(])(https?:\/\/[^\s<>&)\0]+)/g;
/** A tag must start a word; without the guard `&#39;` would hold one. */
export const TAG = /(^|[\s(])#([a-zA-Z0-9_\-/]+)/g;
export const BOLD = /\*\*([^*]+)\*\*/g;
export const ITALIC = /(^|[^*])\*([^*\n]+)\*/g;
export const STRIKE = /~~([^~]+)~~/g;
export const HIGHLIGHT = /==([^=]+)==/g;
export function linkKind(url) {
    if (url.startsWith('heptabase://')) {
        const target = parseMentionHref(url);
        if (!target)
            return null;
        return target.kind === 'card' ? 'card' : 'mention';
    }
    if (url.startsWith('asset:'))
        return ASSET_ID.test(url.slice(6)) ? 'attachment' : null;
    return /^(https?:|mailto:)/i.test(url) ? 'extlink' : null;
}
export function imageKind(alt, src) {
    if (src.startsWith('asset:')) {
        if (!ASSET_ID.test(src.slice(6)))
            return null;
        return alt.startsWith('video:') ? 'video' : alt.startsWith('audio:') ? 'audio' : 'image';
    }
    if (alt.startsWith('video:') && /^https?:/i.test(src)) {
        if (videoEmbedUrl(src))
            return 'player';
        return /\.(mp4|webm|ogv|mov|m4v)(\?|$)/i.test(src) ? 'video' : 'link';
    }
    return /^(https?:|data:image\/)/i.test(src) ? 'image' : null;
}
/**
 * Characters a backslash makes literal, as in CommonMark. `\*` is a star, not
 * emphasis; `\#` is not a tag; `\-` at a line start is not a bullet. This is
 * the raw-text form; inline() works on HTML-escaped text and has its own.
 */
const ESCAPABLE = /\\([\\*~=#>+.)|▸`$[\]!'"&<-])/g;
/**
 * Where code lives in a body: fenced blocks and inline spans, as [start, end)
 * offsets. Links and tags found inside are documentation of the syntax, not
 * uses of it.
 */
function codeRanges(content) {
    const ranges = [];
    for (const m of content.matchAll(/```[\s\S]*?```/g))
        ranges.push([m.index, m.index + m[0].length]);
    for (const m of content.matchAll(/`[^`\n]*`/g)) {
        if (!ranges.some(([a, b]) => m.index >= a && m.index < b))
            ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
}
const inRanges = (ranges, at) => ranges.some(([a, b]) => at >= a && at < b);
/** Blanks out code so its contents are never scanned for tags. */
function stripCode(content) {
    return content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}
/**
 * Every `[[link]]` in a body, in order, de-duplicated. The label is the exact
 * text between the brackets, backticks and all, so it names the same card the
 * renderer links to. A `[[` preceded by an odd number of backslashes is
 * escaped; an even number is a literal backslash followed by a link, which is
 * how the renderer reads it too.
 */
export function extractLinks(content) {
    const out = [];
    const seen = new Set();
    for (const label of scanOutsideCode(content, /(\\*)\[\[([^\]\n]+)\]\]/g)) {
        const key = label.trim().toLowerCase();
        if (key && !seen.has(key)) {
            seen.add(key);
            out.push(label.trim());
        }
    }
    return out;
}
/** Ids of cards referenced as `[label](heptabase://card/<id>)`, de-duplicated. */
export function extractCardMentions(content) {
    return [...new Set(scanOutsideCode(content, /(\\*)\[[^[\]\n]*\]\(heptabase:\/\/card\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\)/g))];
}
/**
 * Every capture of `re` (group 2, with group 1 the run of backslashes before
 * it) whose opening lies outside code and is not escaped. A match that opens
 * inside a code span is not skipped wholesale - that could hide a real link
 * later on the line - the scan simply resumes just past its opening.
 */
function scanOutsideCode(content, re) {
    const code = codeRanges(content);
    const out = [];
    let m;
    while ((m = re.exec(content))) {
        const at = m.index + m[1].length;
        if (m[1].length % 2 === 1 || inRanges(code, at)) {
            re.lastIndex = at + 1;
            continue;
        }
        out.push(m[2]);
    }
    return out;
}
/**
 * Every `#tag` in a body, wherever the renderer would show a chip: a `#`
 * starting a word after whitespace or `(`, including inside a heading's text
 * (the heading's own `#` markers are not tags). Escaped `\#` is not a tag.
 */
export function extractTags(content) {
    const out = new Set();
    for (const line of stripCode(content).split('\n')) {
        const text = line.replace(/^\s*#{1,6}\s+/, '');
        for (const m of text.matchAll(/(?:^|[\s(])#([a-zA-Z0-9_\-/]+)/g))
            out.add(m[1]);
    }
    return [...out];
}
/**
 * Video hosts that may be embedded as a player. Anything else is a plain link,
 * so a card can never frame an arbitrary site.
 */
function videoEmbedUrl(url) {
    const yt = url.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&amp;)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/);
    if (yt)
        return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
    const vimeo = url.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d{4,})/);
    if (vimeo)
        return `https://player.vimeo.com/video/${vimeo[1]}`;
    return null;
}
/**
 * Inline formatting. Input must already be HTML-escaped.
 *
 * Every rule runs over the whole string in turn, so HTML emitted by an early
 * rule would be visible to later ones: a `#` inside a link's `data-wikilink`
 * attribute would become a tag chip, a `*` in an image's alt text an `<em>`.
 * Emitted HTML is therefore parked in numbered slots and only put back at the
 * end. NUL delimits a slot, and NUL is stripped from the input first, so no
 * user text can forge one.
 *
 * Each slot also remembers the plain text it stands for. Anything that goes
 * into an attribute (a link's label, an image's alt, a file name) or into a
 * title lookup is built from that plain form, never from the HTML, so a code
 * span in a card title can't break out of the attribute or turn the link
 * "broken".
 */
function inline(escaped, known) {
    let s = escaped.replace(/\0/g, '');
    const slots = [];
    const plain = [];
    const keep = (html, text) => {
        slots.push(html);
        plain.push(text);
        return `\0${slots.length - 1}\0`;
    };
    const SLOT = /\0(\d+)\0/g;
    /** The text form of a fragment: every slot replaced by what it stands for. */
    const flat = (fragment) => {
        while (SLOT.test(fragment))
            fragment = fragment.replace(SLOT, (_, i) => plain[Number(i)]);
        return fragment;
    };
    // Backslash escapes, code spans and inline maths in one left-to-right pass,
    // so an escaped backtick or dollar can never open a span, and the body of
    // a span or formula is kept verbatim - `\|` and `\\` inside `$…$` are TeX,
    // not escapes.
    s = s.replace(INLINE_LEAD, (m, esc, code, pre, math) => {
        if (esc !== undefined)
            return keep(esc, esc);
        if (code !== undefined)
            return keep(`<code>${code}</code>`, m);
        return `${pre}${keep(`<span class="math">${math}</span>`, `$${math}$`)}`;
    });
    // An embed only makes sense on its own line (handled as a block). Mid-sentence
    // it degrades to an ordinary link rather than rendering a stray "!".
    s = s.replace(/!\[\[/g, '[[');
    // [[wiki link]] -> internal link. Marked broken when no such card exists.
    s = s.replace(WIKILINK, (m, rawLabel) => {
        const label = flat(rawLabel).trim();
        const exists = !known || known.has(decodeHtml(label).toLowerCase());
        const cls = exists ? 'wikilink' : 'wikilink broken';
        return keep(`<a class="${cls}" data-wikilink="${label}" href="#">${rawLabel.trim()}</a>`, m);
    });
    // ![alt](src) images. `asset:<id>` refers to a blob in local storage and is
    // resolved to a real URL after mount; remote images keep their href.
    s = s.replace(IMAGE, (whole, rawAlt, rawSrc) => {
        const alt = flat(rawAlt);
        const src = flat(rawSrc);
        const text = flat(whole);
        const id = src.slice(6);
        // A hosted video is named after the `video:` prefix.
        const name = alt.slice(6);
        switch (imageKind(alt, src)) {
            case null:
                return whole;
            // `![video:name](asset:id)` and `![audio:name](asset:id)` play inline.
            case 'video':
                return src.startsWith('asset:')
                    ? keep(`<video class="md-media" data-asset="${id}" controls preload="metadata" title="${name}"></video>`, text)
                    : keep(`<video class="md-media" src="${src}" controls preload="metadata" title="${name}"></video>`, text);
            case 'audio':
                return keep(`<span class="md-audio"><span class="md-audio-name">${name}</span><audio data-asset="${id}" controls preload="metadata"></audio></span>`, text);
            // A hosted video: a player for known hosts, otherwise a plain link.
            case 'player':
                return keep(`<iframe class="md-embed" src="${videoEmbedUrl(src)}" title="${name}" loading="lazy" allowfullscreen referrerpolicy="no-referrer" ` +
                    `sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"></iframe>`, text);
            case 'link':
                return keep(`<a class="extlink" href="${src}" target="_blank" rel="noreferrer noopener">${name || src}</a>`, text);
            case 'image':
                return src.startsWith('asset:')
                    ? keep(`<img class="md-image" data-asset="${id}" alt="${alt}" loading="lazy" />`, text)
                    : keep(`<img class="md-image" src="${src}" alt="${alt}" loading="lazy" />`, text);
        }
    });
    // [text](url) - only http(s) and mailto, so a card cannot smuggle javascript:
    s = s.replace(LINK, (whole, rawText, rawUrl) => {
        const url = flat(rawUrl);
        switch (linkKind(url)) {
            case null:
                return whole;
            // Card, whiteboard, section and journal mentions. A card referenced by
            // id looks like any other card link.
            case 'card':
                return keep(`<a class="wikilink" data-mention="${url}" href="#">${rawText}</a>`, flat(whole));
            case 'mention':
                return keep(`<a class="mention mention-${parseMentionHref(url)?.kind}" data-mention="${url}" href="#">${rawText}</a>`, flat(whole));
            // Attached files: `[name](asset:id)`, or `[pdf:name](asset:id)` for PDFs.
            case 'attachment': {
                const text = flat(rawText);
                const pdf = text.startsWith('pdf:');
                const name = pdf ? text.slice(4) : text;
                return keep(`<a class="attachment${pdf ? ' attachment-pdf' : ''}" data-asset-link="${url.slice(6)}" data-name="${name}" href="#">${name}</a>`, flat(whole));
            }
            case 'extlink': {
                // Only the tag is parked, so the link text keeps its emphasis. A URL
                // written out inside the label is part of the label, not a second link.
                const label = rawText.replace(/https?:\/\/[^\s<>&)]+/g, (u) => keep(u, u));
                return `${keep(`<a class="extlink" href="${url}" target="_blank" rel="noreferrer noopener">`, '')}${label}</a>`;
            }
        }
    });
    s = s.replace(BARE_URL, (_, pre, url) => pre + keep(`<a class="extlink" href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`, url));
    s = s.replace(TAG, '$1<span class="tag-chip" data-tag="$2">#$2</span>');
    s = s.replace(BOLD, '<strong>$1</strong>');
    s = s.replace(ITALIC, '$1<em>$2</em>');
    s = s.replace(STRIKE, '<del>$1</del>');
    s = s.replace(HIGHLIGHT, '<mark>$1</mark>');
    // Slots nest (a code span inside a link label), so restore until none remain.
    while (SLOT.test(s))
        s = s.replace(SLOT, (_, i) => slots[Number(i)]);
    return s;
}
/** Leading whitespace of a line, in columns, with a tab counting as two. */
export const indentOf = (line) => (line.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '  ').length;
/**
 * Removes `columns` of leading whitespace from a line, tabs counting as two.
 * Whitespace beyond that is returned untouched, so a tab that belongs to the
 * content (a Makefile recipe inside a toggle) survives.
 */
function dedent(line, columns) {
    let i = 0;
    let col = 0;
    while (i < line.length && col < columns && (line[i] === ' ' || line[i] === '\t')) {
        col += line[i] === '\t' ? 2 : 1;
        i++;
    }
    return line.slice(i);
}
/**
 * The one definition of a task line, shared by the renderer, the checkbox
 * toggle and the editor's list handling so they can never disagree on what
 * a checkbox is. `[]` at the start of a line is a checkbox exactly as typed -
 * no bullet needed, no space inside; `[x]` is a ticked one. The GFM form
 * `- [ ] text` is read too, since the importer writes it. At least one space
 * must follow the box: `[]` alone is a paragraph, `[](url)` a (broken) link,
 * `[] ` an empty task.
 */
export function parseTaskLine(line) {
    // Imported content can carry CRLF endings. The renderer normalises them
    // before splitting but toggleTask reads the raw source, so the `\r` is
    // dropped here to keep both reading the same line the same way.
    const m = line.replace(/\r$/, '').match(/^(\s*)([-*+]\s+)?\[( |x|X|)\]\s+(.*)$/);
    if (!m)
        return null;
    return { indent: m[1], marker: m[2] ?? '', checked: m[3].toLowerCase() === 'x', text: m[4], box: `[${m[3]}]` };
}
const MATH_FENCE = /^\s*\$\$\s*$/;
const CODE_FENCE = /^\s*```/;
/** A fence opens with an optional language after the backticks; only a bare one closes it. */
const FENCE_OPEN = /^\s*```(\w*)\s*$/;
export const FENCE_CLOSE = /^\s*```\s*$/;
/*
 * The line grammar of the block loop below. The patterns a reader outside
 * needs to agree with it - a toggle's marker, a closing fence, a media line -
 * are exported; the rest are read through blockMap().
 */
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const QUOTE_LINE = /^\s*>\s?(.*)$/;
const BULLET_LINE = /^\s*[-*+]\s+(.*)$/;
const NUMBERED_LINE = /^\s*(\d+)[.)]\s+(.*)$/;
export const TOGGLE_LINE = /^(\s*)▸(#{1,3})?(?:\s+(.*)|\s*)$/;
const EMBED_LINE = /^\s*!\[\[([^\]\n]+)\]\]\s*$/;
/** A line that starts a block of its own inside a list: item, task, toggle, fence, quote. */
const ITEM_START = /^\s*(?:[-*+]\s|\d+[.)]\s|\[[ xX]?\]\s|▸|```|>)/;
export function renderMarkdown(src, opts = {}) {
    return render(src, opts, null);
}
/**
 * Which verbatim block, if any, source line `at` sits inside: the body or
 * closing line of a code fence, or of a `$$` maths block. Read with the block
 * loop's own grammar - a fence needs a bare ``` to close and otherwise runs
 * to the end, `$$` only pairs up with a closing `$$` that no fence interrupts -
 * so an editor guard never disagrees with what the renderer shows. The
 * opening line itself is not inside: nothing typed on it is content yet.
 */
export function verbatimAt(lines, at) {
    let i = 0;
    while (i < at) {
        if (FENCE_OPEN.test(lines[i])) {
            let end = i + 1;
            while (end < lines.length && !FENCE_CLOSE.test(lines[end]))
                end++;
            if (at <= end)
                return 'code';
            i = end + 1;
            continue;
        }
        if (MATH_FENCE.test(lines[i])) {
            let end = i + 1;
            while (end < lines.length && !MATH_FENCE.test(lines[end]) && !CODE_FENCE.test(lines[end]))
                end++;
            if (end < lines.length && MATH_FENCE.test(lines[end])) {
                if (at <= end)
                    return 'math';
                i = end + 1;
                continue;
            }
        }
        i++;
    }
    return null;
}
/**
 * Every block of a document as the renderer reads it, in document order. Read
 * off the renderer's own loop, so an editor that styles lines by this map
 * never disagrees with the page: a line is a heading, an item or code exactly
 * when the rendered page draws it as one.
 */
export function blockMap(src) {
    const blocks = [];
    render(src, {}, blocks);
    return blocks;
}
/**
 * `blocks`, when given, receives every block the loop reads, the blocks of a
 * toggle's body included. `base` is the document line that `src` starts on: a
 * toggle body is rendered from its own lines, but a checkbox inside it must
 * still name the line of the document it will flip, and its blocks the lines
 * they sit on.
 */
function render(src, opts, blocks, base = 0) {
    const known = opts.known;
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const note = (kind, start, end) => blocks?.push({ kind, start: base + start, end: base + end });
    let i = 0;
    // Tracks which list wrapper is currently open, so other block types can
    // close it correctly instead of leaking an unbalanced tag.
    let listTag = null;
    const closeList = () => {
        if (listTag) {
            out.push(`</${listTag}>`);
            listTag = null;
        }
    };
    const openList = (tag, cls = '', start = 1) => {
        if (listTag !== tag) {
            closeList();
            const attrs = (cls ? ` class="${cls}"` : '') + (start !== 1 ? ` start="${start}"` : '');
            out.push(`<${tag}${attrs}>`);
            listTag = tag;
        }
    };
    // Indented lines after a list item continue that item, as in CommonMark.
    // Nested items, toggles, fences and quotes are excluded: they are blocks of
    // their own.
    const itemText = (kind, start, first) => {
        const parts = [first];
        while (i < lines.length && /^[ \t]+\S/.test(lines[i]) && !ITEM_START.test(lines[i]))
            parts.push(lines[i++].trim());
        note(kind, start, i);
        return inline(escapeHtml(parts.join('\n')), known).replace(/\n/g, '<br />');
    };
    while (i < lines.length) {
        const line = lines[i];
        const start = i;
        // Fenced code block - consumed verbatim, never inline-parsed.
        const fence = line.match(FENCE_OPEN);
        if (fence) {
            closeList();
            const lang = fence[1];
            const body = [];
            i++;
            while (i < lines.length && !FENCE_CLOSE.test(lines[i]))
                body.push(lines[i++]);
            i++; // closing fence
            const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
            // An unclosed fence runs to the end of input; `i` has stepped past it.
            note('code', start, Math.min(i, lines.length));
            out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
            continue;
        }
        if (/^\s*$/.test(line)) {
            closeList();
            i++;
            continue;
        }
        if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
            closeList();
            note('rule', start, start + 1);
            out.push('<hr />');
            i++;
            continue;
        }
        // Pipe table: a header row followed by a |---|---| separator.
        if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            closeList();
            const header = splitRow(line);
            i += 2; // header + separator
            const body = [];
            while (i < lines.length && /^\s*\|/.test(lines[i]))
                body.push(splitRow(lines[i++]));
            const cell = (text, tag) => `<${tag}>${inline(escapeHtml(text), known)}</${tag}>`;
            note('table', start, i);
            out.push('<div class="table-wrap"><table>' +
                `<thead><tr>${header.map((c) => cell(c, 'th')).join('')}</tr></thead>` +
                `<tbody>${body
                    .map((row) => `<tr>${row.map((c) => cell(c, 'td')).join('')}</tr>`)
                    .join('')}</tbody>` +
                '</table></div>');
            continue;
        }
        // ![[Card]] on its own line embeds that card's content (filled in after mount).
        const embed = line.match(EMBED_LINE);
        if (embed) {
            closeList();
            const title = escapeHtml(embed[1].trim());
            note('embed', start, start + 1);
            out.push(`<div class="card-embed" data-embed="${title}"><div class="card-embed-head">` +
                `<a class="wikilink" data-wikilink="${title}" href="#">${title}</a></div>` +
                `<div class="card-embed-body"></div></div>`);
            i++;
            continue;
        }
        // $$ maths block $$. Without a closing fence - or with a code block in
        // between - the line is ordinary text, so a `$$` typed on its own never
        // swallows the rest of the card.
        if (MATH_FENCE.test(line)) {
            let end = i + 1;
            while (end < lines.length && !MATH_FENCE.test(lines[end]) && !CODE_FENCE.test(lines[end]))
                end++;
            if (end < lines.length && MATH_FENCE.test(lines[end])) {
                closeList();
                note('math', start, end + 1);
                out.push(`<div class="math-block">${escapeHtml(lines.slice(i + 1, end).join('\n'))}</div>`);
                i = end + 1;
                continue;
            }
        }
        // ▸ Toggle, or ▸# / ▸## / ▸### toggle heading. The body is the following
        // lines indented at least two columns past the marker, rendered recursively.
        const toggle = line.match(TOGGLE_LINE);
        if (toggle) {
            closeList();
            const depth = indentOf(line) + 2;
            const body = [];
            i++;
            while (i < lines.length) {
                if (lines[i].trim() === '') {
                    // Blank lines stay in the body only when indented content follows.
                    let next = i;
                    while (next < lines.length && lines[next].trim() === '')
                        next++;
                    if (next < lines.length && indentOf(lines[next]) >= depth) {
                        while (i < next)
                            body.push(lines[i++]);
                        continue;
                    }
                    break;
                }
                if (indentOf(lines[i]) < depth)
                    break;
                body.push(dedent(lines[i], depth));
                i++;
            }
            const level = toggle[2]?.length ?? 0;
            const summary = inline(escapeHtml(toggle[3] ?? ''), known);
            const head = level ? `<h${level}>${summary}</h${level}>` : `<span>${summary}</span>`;
            // The body holds one entry per document line (blank ones included), so
            // its tasks and blocks are offset to the line below the marker.
            note('toggle', start, i);
            out.push(`<details class="toggle${level ? ' toggle-heading' : ''}"><summary>${head}</summary>` +
                `<div class="toggle-body">${render(body.join('\n'), opts, blocks, base + start + 1)}</div></details>`);
            continue;
        }
        const heading = line.match(HEADING_LINE);
        if (heading) {
            closeList();
            const level = heading[1].length;
            note('heading', start, start + 1);
            out.push(`<h${level}>${inline(escapeHtml(heading[2]), known)}</h${level}>`);
            i++;
            continue;
        }
        const quote = line.match(QUOTE_LINE);
        if (quote) {
            closeList();
            const body = [quote[1]];
            i++;
            while (i < lines.length) {
                const next = lines[i].match(QUOTE_LINE);
                if (!next)
                    break;
                body.push(next[1]);
                i++;
            }
            note('quote', start, i);
            out.push(`<blockquote>${inline(escapeHtml(body.join(' ')), known)}</blockquote>`);
            continue;
        }
        // Checklists are matched before plain bullets, since `- [ ] x` is also a bullet.
        const task = parseTaskLine(line);
        if (task) {
            openList('ul', 'task-list');
            const { checked } = task;
            i++;
            const box = opts.liveTasks ? `${checked ? ' checked' : ''} data-task-line="${base + start}"` : ` disabled${checked ? ' checked' : ''}`;
            out.push(`<li class="task${checked ? ' done' : ''}"><input type="checkbox"${box} /><span>${itemText('task', start, task.text)}</span></li>`);
            continue;
        }
        const bullet = line.match(BULLET_LINE);
        if (bullet) {
            openList('ul');
            i++;
            out.push(`<li>${itemText('bullet', start, bullet[1])}</li>`);
            continue;
        }
        const numbered = line.match(NUMBERED_LINE);
        if (numbered) {
            // The first number sets where the list starts, so "3." after an image
            // keeps counting instead of restarting at 1.
            openList('ol', '', Number(numbered[1]));
            i++;
            out.push(`<li>${itemText('numbered', start, numbered[2])}</li>`);
            continue;
        }
        // Paragraph: gather until a blank line or the start of another block.
        closeList();
        const para = [line];
        i++;
        while (i < lines.length && !isBlockStart(lines[i]))
            para.push(lines[i++]);
        note('paragraph', start, i);
        out.push(`<p>${inline(escapeHtml(para.join('\n')), known).replace(/\n/g, '<br />')}</p>`);
    }
    closeList();
    return out.join('\n');
}
function isBlockStart(line) {
    return (/^\s*$/.test(line) ||
        CODE_FENCE.test(line) ||
        /^#{1,6}\s/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*[-*+]\s/.test(line) ||
        /^\s*\[[ xX]?\]\s/.test(line) ||
        /^\s*\d+[.)]\s/.test(line) ||
        /^\s*\|/.test(line) ||
        /^\s*▸/.test(line) ||
        MATH_FENCE.test(line) ||
        /^\s*!\[\[[^\]\n]+\]\]\s*$/.test(line) ||
        /^\s*(---|\*\*\*|___)\s*$/.test(line));
}
/** Splits a `| a | b |` row, honouring \| escapes inside cells. */
function splitRow(line) {
    const cells = [];
    let current = '';
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
            current += '|';
            i++;
        }
        else if (trimmed[i] === '|') {
            cells.push(current.trim());
            current = '';
        }
        else {
            current += trimmed[i];
        }
    }
    cells.push(current.trim());
    return cells;
}
/** A media line: an image, video or audio block with nothing else on it. */
export const MEDIA_LINE = /^\s*!\[[^[\]\n]*\]\([^)\n]*\)\s*$/;
/**
 * Inline markup reduced to the words a person would read: code keeps its
 * text, paired emphasis and highlights drop their markers, a tag chip keeps
 * its word, links keep their label. Anything the renderer would show as-is
 * (a lone `*`, `C#`, `5 * 3`) is left alone, and escapes are undone last.
 */
function stripInline(text) {
    return text
        .replace(/!\[\[/g, '[[')
        .replace(/(?<!\\)!?\[([^[\]\n]*)\]\([^)\n]*\)/g, '$1') // links, mentions, attachments: keep the label
        .replace(WIKILINK, '$1')
        .replace(/(?<!\\)`([^`\n]+)`/g, '$1')
        .replace(/(?<!\\)\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/(^|[^*\\])\*([^*\n]+)\*/g, '$1$2')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/==([^=]+)==/g, '$1')
        .replace(/(^|[\s(])#([a-zA-Z0-9_\-/]+)/g, '$1$2')
        .replace(ESCAPABLE, '$1');
}
/** A line of Markdown reduced to the words a person would read in it. */
function plainWords(line) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    // A list, checklist or quote marker is structure, not part of the words.
    const words = parseTaskLine(line)?.text ?? (h ? h[1] : line).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/, '');
    return stripInline(words)
        .replace(/\s+/g, ' ')
        .trim();
}
/** Structural lines that carry no words to title a card with. */
const STRUCTURAL = /^(-{3,}|\*{3,}|_{3,}|\${2}|`{3,}.*|\|[\s|:-]*\|)$/;
/** First heading or first non-empty line - used to auto-title untitled cards. */
export function deriveTitle(content) {
    // A table's cells are a last resort: prose elsewhere in the card reads better.
    let tableRow = '';
    for (const raw of content.split('\n')) {
        // A toggle is a heading or paragraph behind a marker; read through it.
        const line = raw.replace(/^\s*▸#{0,3}(?=\s|$)/, '').trim();
        // A picture at the top of a card is not its name.
        if (!line || STRUCTURAL.test(line) || MEDIA_LINE.test(line))
            continue;
        if (/^\|.*\|$/.test(line)) {
            if (!tableRow)
                tableRow = plainWords(splitRow(line).join(' '));
            continue;
        }
        const text = plainWords(line);
        if (text)
            return text.slice(0, 120);
    }
    return tableRow.slice(0, 120);
}
/** Short plain-text preview for list rows and collapsed cards. */
export function plainPreview(content, max = 180) {
    const text = stripInline(content
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^\s*\$\$\s*$/gm, ' ')
        .replace(/^\s*\|[\s|:-]*\|\s*$/gm, ' ') // table separator rows
        .replace(/^\s*\|(.*)\|\s*$/gm, (_, cells) => cells.replace(/(?<!\\)\|/g, ' '))
        .replace(/(?<!\\)!\[[^[\]\n]*\]\([^)\n]*\)/g, ' ')
        .replace(/^\s*▸#{0,3}(?=\s|$)\s*/gm, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*>\s?/gm, ''))
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
