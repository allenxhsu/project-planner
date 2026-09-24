/**
 * <sc-toast> — a toast region with a static show() API.
 *
 *   import { ScToast } from '../ui-kit/js/toast.js';
 *   ScToast.show('Model exported', { tone: 'success' });
 *   ScToast.show('Card archived', { action: { label: 'Undo', onSelect: () => restore() } });
 *
 * One <sc-toast> element is the region, bottom-right. Put one in the page to
 * choose where it lives, or let show() append one to <body> on first use.
 * Each toast is an sc-alert, so the tones are the kit's status colours:
 * 'info' (default), 'success', 'warning', 'danger'. A toast with an action
 * stays 8 s, otherwise 4 s; `duration: 0` keeps it until dismissed; hovering
 * pauses the timer. show() returns { dismiss() }. Light DOM, no dependencies.
 *
 * From React 18: call ScToast.show() from any handler or effect; there is
 * nothing to render, and no ref is needed. Rendering <sc-toast /> yourself
 * only chooses where the region lives. Without an import, the class is
 * customElements.get('sc-toast').
 */

const DEFAULT_MS = 4000;
const ACTION_MS = 8000;
const MAX_VISIBLE = 4;
const TONES = ['info', 'success', 'warning', 'danger'];

function button(className, text, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  if (label) b.setAttribute('aria-label', label);
  return b;
}

export class ScToast extends HTMLElement {
  /** Shows a toast in the page's region, creating the region on first use. */
  static show(text, options) {
    let region = document.querySelector('sc-toast');
    if (!region) {
      region = document.createElement('sc-toast');
      document.body.append(region);
    }
    return region.show(text, options);
  }

  /** Removes every toast at once. */
  static clear() {
    document.querySelector('sc-toast')?.clear();
  }

  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
    if (!this.hasAttribute('aria-live')) this.setAttribute('aria-live', 'polite');
  }

  show(text, { action, tone = 'info', duration } = {}) {
    const item = document.createElement('div');
    const toneClass = TONES.includes(tone) && tone !== 'info' ? ` sc-alert--${tone}` : '';
    item.className = `sc-alert${toneClass} sc-toast-item`;

    const label = document.createElement('span');
    label.className = 'sc-toast-text';
    label.textContent = text;
    item.append(label);

    const handle = { dismiss: () => this.dismiss(item) };

    if (action && action.label) {
      const b = button('sc-button sc-button--ghost sc-button--sm', action.label);
      b.addEventListener('click', () => {
        handle.dismiss();
        action.onSelect?.();
      });
      item.append(b);
    }
    const close = button('sc-button sc-button--ghost sc-button--icon sc-button--sm', '✕', 'Dismiss');
    close.addEventListener('click', handle.dismiss);
    item.append(close);

    const ms = duration ?? (action ? ACTION_MS : DEFAULT_MS);
    if (ms > 0) {
      let left = ms;
      let started = Date.now();
      let timer = setTimeout(handle.dismiss, left);
      item.addEventListener('mouseenter', () => {
        clearTimeout(timer);
        left -= Date.now() - started;
      });
      item.addEventListener('mouseleave', () => {
        started = Date.now();
        timer = setTimeout(handle.dismiss, Math.max(left, 800));
      });
    }

    this.append(item);
    // Oldest toasts make room for new ones.
    let visible = this.querySelectorAll('.sc-toast-item:not(.is-leaving)');
    while (visible.length > MAX_VISIBLE) {
      this.dismiss(visible[0]);
      visible = this.querySelectorAll('.sc-toast-item:not(.is-leaving)');
    }
    return handle;
  }

  dismiss(item) {
    if (!item || item.parentNode !== this || item.classList.contains('is-leaving')) return;
    item.classList.add('is-leaving');
    const done = () => item.remove();
    item.addEventListener('animationend', done, { once: true });
    // With effects off or reduced motion there is no animation to end.
    setTimeout(done, 400);
  }

  clear() {
    for (const child of [...this.children]) child.remove();
  }
}

if (!customElements.get('sc-toast')) customElements.define('sc-toast', ScToast);
