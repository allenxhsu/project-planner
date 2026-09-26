/**
 * <sc-theme-picker> — the same appearance controls in every app.
 *
 *   <script type="module" src="../ui-kit/js/theme-picker.js"></script>
 *   <sc-theme-picker></sc-theme-picker>
 *
 * Renders the interface choice (HUD or macOS), then the controls that apply
 * to it: the HUD's palette and effects, or the macOS skin's appearance (Auto,
 * Light, Dark). Writes through theme.js and stays in sync if the
 * preference changes elsewhere. Light DOM (no shadow root), so it inherits
 * the page's kit styles.
 */

import {
  APPEARANCES,
  APPEARANCE_LABELS,
  RACES,
  RACE_LABELS,
  SKINS,
  SKIN_LABELS,
  getTheme,
  onThemeChange,
  setAppearance,
  setEffects,
  setRace,
  setSkin,
} from './theme.js';

const buttons = (items, labels, current, attr) =>
  items
    .map((v) => `<button type="button" class="sc-button ${current === v ? 'sc-button--primary' : ''}" ${attr}="${v}">${labels[v]}</button>`)
    .join('');

class ThemePicker extends HTMLElement {
  connectedCallback() {
    this.render();
    this.off = onThemeChange(() => this.render());
  }

  disconnectedCallback() {
    this.off?.();
  }

  render() {
    const t = getTheme();
    const second =
      t.skin === 'mac'
        ? `<div class="sc-field" style="margin-bottom:14px">
            <span>Appearance</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${buttons(APPEARANCES, APPEARANCE_LABELS, t.appearance, 'data-appearance')}</div>
          </div>`
        : `<div class="sc-field" style="margin-bottom:14px">
            <span>Palette</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${buttons(RACES, RACE_LABELS, t.race, 'data-race')}</div>
          </div>
          <label style="display:flex;align-items:center;gap:10px">
            <input type="checkbox" class="sc-check" data-effects ${t.effects === 'on' ? 'checked' : ''}>
            <span class="sc-muted">Scanlines and glow effects</span>
          </label>`;
    this.innerHTML = `
      <div class="sc-field" style="margin-bottom:14px">
        <span>Interface</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${buttons(SKINS, SKIN_LABELS, t.skin, 'data-skin')}</div>
      </div>
      ${second}`;

    this.querySelectorAll('[data-skin]').forEach((b) => b.addEventListener('click', () => setSkin(b.dataset.skin)));
    this.querySelectorAll('button[data-race]').forEach((b) => b.addEventListener('click', () => setRace(b.dataset.race)));
    this.querySelectorAll('[data-appearance]').forEach((b) => b.addEventListener('click', () => setAppearance(b.dataset.appearance)));
    this.querySelector('[data-effects]')?.addEventListener('change', (e) => setEffects(e.target.checked));
  }
}

if (!customElements.get('sc-theme-picker')) customElements.define('sc-theme-picker', ThemePicker);
