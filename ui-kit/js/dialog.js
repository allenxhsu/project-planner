/**
 * <sc-dialog> — a modal on the kit's sc-overlay / sc-dialog markup.
 *
 *   <sc-dialog id="confirm" heading="Delete sheet?" buttons="cancel:Cancel:ghost,delete:Delete:danger">
 *     <p>This cannot be undone.</p>
 *   </sc-dialog>
 *
 *   const choice = await document.getElementById('confirm').open();   // 'delete' | 'cancel'
 *
 * The element's children are the body; the head (heading + ✕) and the foot
 * (buttons) are rendered around them and the element itself becomes the
 * dialog box, so nothing you put inside is moved. Buttons come from the
 * `buttons` attribute ("id:label:kind, …" with kind = primary | ghost |
 * danger | default) or the `.buttons` property ([{ id, label, kind }]);
 * the default is Cancel / OK.
 *
 * open() resolves with the id of the pressed button. Esc, the ✕ and a click on
 * the backdrop resolve 'cancel'; Enter inside a text input presses the primary
 * button; close(id) ends it from code. Focus moves to the first [autofocus]
 * element or the primary button, Tab stays inside, and focus returns to where
 * it was afterwards. 'sc-dialog-open' and 'sc-dialog-close' ({ id }) bubble.
 *
 * One-off dialogs with no markup:
 *
 *   const id = await ScDialog.open({ heading: 'Rename', body: '<label class="sc-field">…</label>',
 *                                    buttons: [{ id: 'cancel', label: 'Cancel', kind: 'ghost' }, { id: 'save', label: 'Save', kind: 'primary' }] });
 *
 * From React 18: render <sc-dialog ref={ref} heading="…">{children}</sc-dialog>
 * and call ref.current.open() from a handler, awaiting the id. React writes
 * attributes, not properties, on custom elements, so a dynamic button list is
 * set through the ref in an effect (ref.current.buttons = […]); a static list
 * can stay in the `buttons` attribute. Children stay React's, so state updates
 * keep working while the dialog is open. Listen with
 * ref.current.addEventListener('sc-dialog-close', …) when a promise is awkward.
 */

const KIND_CLASS = {
  primary: 'sc-button sc-button--primary',
  ghost: 'sc-button sc-button--ghost',
  danger: 'sc-button sc-button--danger',
  default: 'sc-button',
};
const DEFAULT_BUTTONS = [
  { id: 'cancel', label: 'Cancel', kind: 'ghost' },
  { id: 'ok', label: 'OK', kind: 'primary' },
];
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** "cancel:Cancel:ghost, save:Save:primary" → [{ id, label, kind }] */
export function parseButtons(text) {
  return String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label, kind] = s.split(':').map((x) => x.trim());
      return { id, label: label || id, kind: kind || 'default' };
    });
}

export class ScDialog extends HTMLElement {
  static get observedAttributes() {
    return ['heading', 'buttons'];
  }

  /** Builds a dialog, opens it, removes it again, and resolves the pressed button id. */
  static async open({ heading = '', body = '', buttons } = {}) {
    const el = document.createElement('sc-dialog');
    if (heading) el.setAttribute('heading', heading);
    if (buttons) el.buttons = buttons;
    if (body instanceof Node) el.append(body);
    else el.innerHTML = body;
    document.body.append(el);
    try {
      return await el.open();
    } finally {
      el.remove();
    }
  }

  constructor() {
    super();
    this._buttons = null;
    this._pending = null;
    this._resolve = null;
    this._backdrop = null;
    this._restore = null;
    this._head = null;
    this._foot = null;

    this._onClick = (e) => {
      const b = e.target.closest('[data-dialog-button]');
      if (b && this.contains(b)) this.close(b.dataset.dialogButton);
    };

    this._onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close('cancel');
        return;
      }
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && this.contains(e.target)) {
        const primary = this._foot.querySelector('.sc-button--primary');
        if (primary) {
          e.preventDefault();
          primary.click();
        }
        return;
      }
      if (e.key === 'Tab') {
        const items = [...this.querySelectorAll(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const outside = !this.contains(active);
        if (e.shiftKey && (active === first || outside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || outside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
  }

  /** The button list: the property when set, else the attribute, else Cancel / OK. */
  get buttons() {
    if (this._buttons) return this._buttons;
    const attr = this.getAttribute('buttons');
    return attr ? parseButtons(attr) : DEFAULT_BUTTONS;
  }

  set buttons(list) {
    this._buttons = Array.isArray(list) && list.length ? list : null;
    if (this._foot) this.renderChrome();
  }

  get isOpen() {
    return this._pending !== null;
  }

  connectedCallback() {
    this.setAttribute('role', 'dialog');
    this.setAttribute('aria-modal', 'true');
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '-1');
    this.renderChrome();
    this.addEventListener('click', this._onClick);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    if (this.isOpen) this.close('cancel');
  }

  attributeChangedCallback() {
    if (this._head) this.renderChrome();
  }

  /** Head and foot are rendered once and updated in place; the children between them are the body. */
  renderChrome() {
    if (!this._head) {
      this._head = document.createElement('div');
      this._head.className = 'sc-dialog-head';
      this.prepend(this._head);
    }
    if (!this._foot) {
      this._foot = document.createElement('div');
      this._foot.className = 'sc-dialog-foot';
      this.append(this._foot);
    }
    const heading = this.getAttribute('heading') || '';
    if (heading) this.setAttribute('aria-label', heading);
    this._head.innerHTML = `
      <span class="sc-label" style="color:var(--sc-text)">${escapeHtml(heading)}</span>
      <button type="button" class="sc-button sc-button--ghost sc-button--icon sc-button--sm" data-dialog-button="cancel" aria-label="Close">✕</button>`;
    this._foot.innerHTML = this.buttons
      .map(
        (b) =>
          `<button type="button" class="${KIND_CLASS[b.kind] || KIND_CLASS.default}" data-dialog-button="${escapeHtml(b.id)}">${escapeHtml(b.label ?? b.id)}</button>`,
      )
      .join('');
  }

  /** Opens the dialog; resolves with the id of the button that closed it. */
  open() {
    if (this._pending) return this._pending;
    this._pending = new Promise((resolve) => {
      this._resolve = resolve;
    });
    this._restore = document.activeElement;
    this._backdrop = document.createElement('div');
    this._backdrop.className = 'sc-overlay';
    this._backdrop.addEventListener('mousedown', () => this.close('cancel'));
    document.body.append(this._backdrop);
    this.setAttribute('open', '');
    document.addEventListener('keydown', this._onKey, true);
    this.dispatchEvent(new CustomEvent('sc-dialog-open', { bubbles: true }));
    const focusInside = () => {
      const target =
        this.querySelector('[autofocus]') || this._foot.querySelector('.sc-button--primary') || this._foot.querySelector('button');
      (target || this).focus();
    };
    // Now and again after paint, so the deploy animation can't swallow the focus.
    focusInside();
    requestAnimationFrame(focusInside);
    return this._pending;
  }

  /** Closes the dialog from code, resolving open() with `id`. */
  close(id = 'cancel') {
    if (!this._pending) return;
    const resolve = this._resolve;
    this._pending = null;
    this._resolve = null;
    this.removeAttribute('open');
    document.removeEventListener('keydown', this._onKey, true);
    this._backdrop?.remove();
    this._backdrop = null;
    const restore = this._restore;
    this._restore = null;
    if (restore && restore !== document.body && document.contains(restore)) restore.focus?.();
    this.dispatchEvent(new CustomEvent('sc-dialog-close', { bubbles: true, detail: { id } }));
    resolve(id);
  }
}

if (!customElements.get('sc-dialog')) customElements.define('sc-dialog', ScDialog);
