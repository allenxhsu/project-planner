// Notes written in markdown, the way Heptabase reads and types it.
//
// Read: the notes drawn by Heptabase's renderer (io/md/markdown.js) —
// headings in their colours, lists, checkboxes you can tick, quotes, code,
// links. Click anywhere that is not a link or a checkbox to write.
//
// Write: the markdown itself, with Heptabase's keys (io/md/editor/*):
// Enter carries a list on (a ticked box starts a fresh one; an empty item
// ends the list), Tab and ⇧Tab indent, "* " becomes "- ", "/" at the start
// of a line offers blocks, ⌘B and ⌘I wrap the selection. Escape or leaving
// the field shows it drawn again.

import { el } from '../util.js';
import { renderMarkdown, parseTaskLine, verbatimAt } from '../io/md/markdown.js';
import { continueList, indentLines, setLinePrefix } from '../io/md/editor/triggers.js';
import { applyInputRule } from '../io/md/editor/inputRules.js';
import { toggleTask } from '../io/md/editor/tasks.js';
import { showMenu } from './dialog.js';

/** "/" blocks, as Heptabase's slash menu has them: a line prefix, or a block to insert. */
const BLOCKS = [
  ['Text', ''], ['Heading 1', '# '], ['Heading 2', '## '], ['Heading 3', '### '],
  ['To-do list', '[] '], ['Bullet list', '- '], ['Numbered list', '1. '], ['Toggle list', '▸ '], ['Quote', '> '],
  ['Code block', { block: '```\n\n```', caret: 4 }], ['Divider', { block: '---\n', caret: 4 }],
];

/** The source line of the n-th checkbox the renderer drew (code and maths blocks hold none). */
function taskLineOf(source, n) {
  const lines = source.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (verbatimAt(lines, i)) continue;
    if (parseTaskLine(lines[i]) && ++seen === n) return i;
  }
  return -1;
}

/**
 * @param {{ value?: string, placeholder?: string, rows?: number, onchange?: (text: string) => void }} opts
 * @returns {{ node: HTMLElement, get: () => string }}
 */
export function markdownNotes({ value = '', placeholder = 'Notes', rows = 8, onchange = null } = {}) {
  let text = value || '';
  const view = el('div', { class: 'markdown md-view', tabindex: '0', title: 'Click to write' });
  const area = el('textarea', { class: 'sc-textarea md-edit', rows, placeholder, spellcheck: true });
  const node = el('div', { class: 'md-notes' }, view, area);
  const changed = () => onchange?.(text);

  const draw = () => {
    view.innerHTML = text.trim() ? renderMarkdown(text) : '';
    if (!text.trim()) view.append(el('span', { class: 'md-placeholder', text: placeholder }));
    // The renderer draws checkboxes read-only; here they tick.
    view.querySelectorAll('li.task input[type=checkbox]').forEach((box, n) => {
      box.disabled = false;
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        const line = taskLineOf(text, n);
        if (line < 0) return;
        text = toggleTask(text, line, box.checked);
        changed();
        draw();
      });
    });
  };
  const edit = (atEnd = true) => {
    node.classList.add('is-editing');
    area.value = text;
    area.style.height = `${Math.max(view.offsetHeight, rows * 20)}px`;
    area.focus();
    if (atEnd) area.setSelectionRange(text.length, text.length);
  };
  const read = () => { node.classList.remove('is-editing'); draw(); };
  const put = (next) => { area.value = next.value; area.setSelectionRange(next.caret ?? next.start, next.caret ?? next.end ?? next.start); sync(); };
  const sync = () => { if (area.value !== text) { text = area.value; changed(); } };

  view.addEventListener('click', (e) => { if (!e.target.closest('a, input')) edit(); });
  view.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); edit(); } });
  area.addEventListener('input', sync);
  area.addEventListener('blur', () => { sync(); setTimeout(() => { if (document.activeElement !== area && !document.querySelector('.pop-menu')) read(); }, 120); });

  const wrap = (mark) => {
    const { selectionStart: a, selectionEnd: b, value: v } = area;
    area.value = `${v.slice(0, a)}${mark}${v.slice(a, b)}${mark}${v.slice(b)}`;
    area.setSelectionRange(a + mark.length, b + mark.length);
    sync();
  };
  const slash = () => {
    const r = area.getBoundingClientRect();
    const line = area.value.slice(0, area.selectionStart).split('\n').length;
    const y = Math.min(r.bottom - 10, r.top + 8 + line * 20 - area.scrollTop);
    const caret = area.selectionStart;
    showMenu(r.left + 16, y, [{ note: 'Blocks' }, ...BLOCKS.map(([label, what]) => ({
      label,
      run: () => {
        area.focus();
        if (typeof what === 'string') put(setLinePrefix(area.value, caret, what));
        else {
          const v = area.value;
          const start = v.lastIndexOf('\n', caret - 1) + 1;
          put({ value: v.slice(0, start) + what.block + v.slice(caret), caret: start + what.caret });
        }
      },
    }))]);
  };

  area.addEventListener('keydown', (e) => {
    e.stopPropagation();    // the planner's own keys (Delete, Insert…) stay out of the notes
    const caret = area.selectionStart;
    if (e.key === 'Escape') { e.preventDefault(); area.blur(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); wrap(e.key === 'b' ? '**' : '*'); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && caret === area.selectionEnd) {
      const next = continueList(area.value, caret);
      if (next) { e.preventDefault(); put(next); }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      put(indentLines(area.value, caret, area.selectionEnd, e.shiftKey ? 'out' : 'in'));
      return;
    }
    if (e.key === ' ' && caret === area.selectionEnd) {
      const next = applyInputRule(area.value, caret);
      if (next) { e.preventDefault(); put(next); }
      return;
    }
    if (e.key === '/' && caret === area.selectionEnd && /(^|\n)\s*$/.test(area.value.slice(0, caret))) {
      e.preventDefault();
      slash();
    }
  });

  draw();
  return { node, get: () => (node.classList.contains('is-editing') ? area.value : text) };
}
