/** <sc-theme-picker>: skin, palette and effects controls. Import the module for its side effect. */
export {};

declare global {
  interface HTMLElementTagNameMap {
    'sc-theme-picker': HTMLElement;
  }
  namespace JSX {
    interface IntrinsicElements {
      'sc-theme-picker': { [attribute: string]: unknown };
    }
  }
}
