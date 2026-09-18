/**
 * <sc-theme-picker> — the same appearance controls in every app.
 *
 *   <script type="module" src="../ui-kit/js/theme-picker.js"></script>
 *   <sc-theme-picker></sc-theme-picker>
 *
 * Renders skin, race and effects controls, writes through theme.js, and stays
 * in sync if the preference changes elsewhere. Light DOM (no shadow root), so
 * it inherits the page's kit styles.
 */

import { RACES, RACE_LABELS, getTheme, onThemeChange, setEffects, setRace, setSkin } from './theme.js';

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
    const skinOn = t.skin === 'hud';
    this.innerHTML = `
      <div class="sc-field" style="margin-bottom:14px">
        <span>Interface</span>
        <div style="display:flex;gap:8px">
          <button type="button" class="sc-button ${skinOn ? 'sc-button--primary' : ''}" data-skin="hud">HUD</button>
          <button type="button" class="sc-button ${skinOn ? '' : 'sc-button--primary'}" data-skin="classic">Classic</button>
        </div>
      </div>
      <div class="sc-field" style="margin-bottom:14px;${skinOn ? '' : 'opacity:.45;pointer-events:none'}">
        <span>Palette</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${RACES.map(
            (r) =>
              `<button type="button" class="sc-button ${t.race === r ? 'sc-button--primary' : ''}" data-race="${r}">${RACE_LABELS[r]}</button>`,
          ).join('')}
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:10px;${skinOn ? '' : 'opacity:.45;pointer-events:none'}">
        <input type="checkbox" class="sc-check" data-effects ${t.effects === 'on' ? 'checked' : ''}>
        <span class="sc-muted">Scanlines and glow effects</span>
      </label>`;

    this.querySelectorAll('[data-skin]').forEach((b) => b.addEventListener('click', () => setSkin(b.dataset.skin)));
    this.querySelectorAll('button[data-race]').forEach((b) => b.addEventListener('click', () => setRace(b.dataset.race)));
    this.querySelector('[data-effects]')?.addEventListener('change', (e) => setEffects(e.target.checked));
  }
}

if (!customElements.get('sc-theme-picker')) customElements.define('sc-theme-picker', ThemePicker);
