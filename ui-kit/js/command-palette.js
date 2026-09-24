/**
 * <sc-command-palette> — ⌘K for the apps without a bundler.
 *
 *   <sc-command-palette hotkey="k" placeholder="Search commands…"></sc-command-palette>
 *
 *   const palette = document.querySelector('sc-command-palette');
 *   palette.commands = [
 *     { id: 'new-sheet', label: 'New sheet', shortcut: '⌘N', group: 'Actions' },
 *     { id: 'go-settings', label: 'Go to settings', shortcut: 'g s', group: 'Navigate' },
 *   ];
 *   palette.addEventListener('sc-command', (e) => run(e.detail.id));
 *
 * Typing fuzzy-filters the labels: every typed character has to appear in
 * order, and consecutive, word-start and early hits rank higher. Keyboard as
 * in Hypermail's palette: ↓ / ↑ (also ⌃N / ⌃P) move without wrapping, Enter
 * runs the highlighted command, Esc closes. The pointer works too. `hotkey`
 * makes ⌘<key> (⌃<key> elsewhere) toggle it; open(), close() and toggle() do
 * the same from code. With no query, commands keep their order, grouped in
 * order of first appearance. 'sc-command' bubbles and carries { id, command };
 * the palette closes before it fires. Light DOM, kit classes, no dependencies.
 *
 * From React 18: React writes attributes, not properties, on custom elements,
 * so assign `commands` through a ref in an effect and subscribe with
 * addEventListener in the same effect:
 *
 *   const ref = useRef(null);
 *   useEffect(() => {
 *     const el = ref.current;
 *     el.commands = commands;
 *     const onCommand = (e) => run(e.detail.id);
 *     el.addEventListener('sc-command', onCommand);
 *     return () => el.removeEventListener('sc-command', onCommand);
 *   }, [commands]);
 *   <sc-command-palette ref={ref} hotkey="k" />
 *
 * Hypermail keeps its own React palette; this element is for the plain-ES apps.
 */

const MAX_RESULTS = 30;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Fuzzy match: every character of `query` must appear in `text` in order.
 * Returns { score, hits } (hits = matched indices) or null.
 */
export function fuzzy(query, text) {
  const q = String(query).toLowerCase();
  const t = String(text).toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const hits = [];
  let from = 0;
  let prev = -2;
  let score = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, from);
    if (idx === -1) return null;
    const wordStart = idx === 0 || /[\s\-_/:.()]/.test(t[idx - 1]);
    score += 10 + (idx === prev + 1 ? 8 : 0) + (wordStart ? 6 : 0) - Math.min(idx - from, 5);
    hits.push(idx);
    prev = idx;
    from = idx + 1;
  }
  // Shorter labels win ties.
  return { score: score - (t.length - q.length) * 0.1, hits };
}

function highlight(text, hits) {
  const set = new Set(hits);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    out += set.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return out;
}

export class ScCommandPalette extends HTMLElement {
  static get observedAttributes() {
    return ['hotkey', 'placeholder'];
  }

  constructor() {
    super();
    this._commands = [];
    this._results = [];
    this._query = '';
    this._sel = 0;
    this._restore = null;

    this._onHotkey = (e) => {
      const key = (this.getAttribute('hotkey') || '').toLowerCase();
      if (!key || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== key) return;
      e.preventDefault();
      this.toggle();
    };
    this._onEscape = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    };
    this._onKey = (e) => {
      const n = this._results.length;
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault();
        if (n) this.select(Math.min(n - 1, this._sel + 1));
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault();
        if (n) this.select(Math.max(0, this._sel - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.run(this._sel);
      }
    };
  }

  /** [{ id, label, shortcut?, group? }] */
  get commands() {
    return this._commands;
  }

  set commands(list) {
    this._commands = Array.isArray(list) ? list.filter((c) => c && c.id != null) : [];
    if (this.isOpen) this.filter();
  }

  get isOpen() {
    return this.hasAttribute('open');
  }

  connectedCallback() {
    window.addEventListener('keydown', this._onHotkey);
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this._onHotkey);
    this.close();
  }

  attributeChangedCallback(name, _old, value) {
    if (name === 'placeholder' && this.isOpen) this.querySelector('.sc-palette-input').placeholder = value || '';
  }

  open() {
    if (this.isOpen) return;
    this._restore = document.activeElement;
    this._query = '';
    this._sel = 0;
    this.innerHTML = `
      <div class="sc-overlay" data-backdrop>
        <div class="sc-dialog" role="dialog" aria-modal="true" aria-label="Commands">
          <input class="sc-palette-input" type="text" placeholder="${escapeHtml(this.getAttribute('placeholder') || 'Type a command…')}"
                 autocomplete="off" spellcheck="false" aria-label="Search commands">
          <div class="sc-palette-results" role="listbox"></div>
        </div>
      </div>`;
    this.setAttribute('open', '');

    const input = this.querySelector('.sc-palette-input');
    input.addEventListener('input', () => {
      this._query = input.value;
      this._sel = 0;
      this.filter();
    });
    input.addEventListener('keydown', this._onKey);
    this.querySelector('[data-backdrop]').addEventListener('mousedown', (e) => {
      if (e.target === e.currentTarget) this.close();
    });
    const results = this.querySelector('.sc-palette-results');
    results.addEventListener('mousemove', (e) => {
      const item = e.target.closest('.sc-palette-item');
      if (item && Number(item.dataset.index) !== this._sel) this.select(Number(item.dataset.index));
    });
    results.addEventListener('click', (e) => {
      const item = e.target.closest('.sc-palette-item');
      if (item) this.run(Number(item.dataset.index));
    });
    document.addEventListener('keydown', this._onEscape, true);

    this.filter();
    // Now and again after paint, so the overlay animation can't swallow the caret.
    input.focus();
    requestAnimationFrame(() => input.focus());
    this.dispatchEvent(new CustomEvent('sc-palette-open', { bubbles: true }));
  }

  close() {
    if (!this.isOpen) return;
    document.removeEventListener('keydown', this._onEscape, true);
    this.removeAttribute('open');
    this.innerHTML = '';
    this._results = [];
    const restore = this._restore;
    this._restore = null;
    if (restore && restore !== document.body && document.contains(restore)) restore.focus?.();
    this.dispatchEvent(new CustomEvent('sc-palette-close', { bubbles: true }));
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  filter() {
    const q = this._query.trim();
    const scored = [];
    this._commands.forEach((command, order) => {
      const m = fuzzy(q, command.label ?? command.id);
      if (m) scored.push({ command, hits: m.hits, score: m.score, order });
    });
    if (q) {
      scored.sort((a, b) => b.score - a.score || a.order - b.order);
    } else {
      // Keep the author's order, but cluster each group where it first appears.
      const first = new Map();
      scored.forEach(({ command }, i) => {
        const g = command.group ?? '';
        if (!first.has(g)) first.set(g, i);
      });
      scored.sort((a, b) => first.get(a.command.group ?? '') - first.get(b.command.group ?? '') || a.order - b.order);
    }
    this._results = scored.slice(0, MAX_RESULTS);
    this._sel = Math.min(this._sel, Math.max(0, this._results.length - 1));
    this.renderResults();
  }

  renderResults() {
    const box = this.querySelector('.sc-palette-results');
    if (!box) return;
    if (!this._results.length) {
      box.innerHTML = `<div class="sc-palette-empty">No matches for “${escapeHtml(this._query)}”</div>`;
      return;
    }
    let lastGroup = null;
    let html = '';
    this._results.forEach(({ command, hits }, i) => {
      const group = command.group ?? '';
      if (group !== lastGroup) {
        if (group) html += `<div class="sc-palette-group">${escapeHtml(group)}</div>`;
        lastGroup = group;
      }
      const active = i === this._sel;
      html += `
        <button type="button" class="sc-palette-item${active ? ' is-active' : ''}" role="option" aria-selected="${active}" data-index="${i}">
          <span class="sc-palette-label">${highlight(String(command.label ?? command.id), hits)}</span>
          ${command.shortcut ? `<span class="sc-kbd">${escapeHtml(command.shortcut)}</span>` : ''}
        </button>`;
    });
    box.innerHTML = html;
    this.scrollSelected();
  }

  select(index) {
    this._sel = index;
    this.querySelectorAll('.sc-palette-item').forEach((el) => {
      const on = Number(el.dataset.index) === index;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', String(on));
    });
    this.scrollSelected();
  }

  scrollSelected() {
    this.querySelector('.sc-palette-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  run(index) {
    const hit = this._results[index];
    if (!hit) return;
    this.close();
    this.dispatchEvent(
      new CustomEvent('sc-command', { bubbles: true, composed: true, detail: { id: hit.command.id, command: hit.command } }),
    );
  }
}

if (!customElements.get('sc-command-palette')) customElements.define('sc-command-palette', ScCommandPalette);
