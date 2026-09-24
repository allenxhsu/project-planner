/** <sc-command-palette>: ⌘K for the apps without a bundler. See command-palette.js. */
export interface Command {
  id: string;
  label: string;
  /** Shown as a key cap, e.g. '⌘N' or 'g s'. Display only; the palette binds nothing. */
  shortcut?: string;
  group?: string;
}

export interface FuzzyMatch {
  score: number;
  /** Indices of the matched characters in the text. */
  hits: number[];
}

/** Every character of `query` must appear in `text` in order; null when it does not. */
export function fuzzy(query: string, text: string): FuzzyMatch | null;

export class ScCommandPalette extends HTMLElement {
  commands: Command[];
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'sc-command-palette': ScCommandPalette;
  }
  interface HTMLElementEventMap {
    'sc-command': CustomEvent<{ id: string; command: Command }>;
    'sc-palette-open': CustomEvent<void>;
    'sc-palette-close': CustomEvent<void>;
  }
  namespace JSX {
    interface IntrinsicElements {
      'sc-command-palette': { [attribute: string]: unknown };
    }
  }
}
