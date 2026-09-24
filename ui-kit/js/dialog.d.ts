/** <sc-dialog>: a modal on the kit's sc-overlay / sc-dialog markup. See dialog.js. */
export type DialogButtonKind = 'primary' | 'ghost' | 'danger' | 'default';

export interface DialogButton {
  id: string;
  label?: string;
  kind?: DialogButtonKind;
}

export interface DialogSpec {
  heading?: string;
  /** HTML string or a node for the body. */
  body?: string | Node;
  buttons?: DialogButton[];
}

/** "cancel:Cancel:ghost, save:Save:primary" → [{ id, label, kind }] */
export function parseButtons(text: string): DialogButton[];

export class ScDialog extends HTMLElement {
  /** Builds a dialog, opens it, removes it again, and resolves the pressed button id. */
  static open(spec?: DialogSpec): Promise<string>;
  /** The button list: the property when set, else the `buttons` attribute, else Cancel / OK. */
  buttons: DialogButton[];
  readonly isOpen: boolean;
  /** Opens the dialog; resolves with the id of the button that closed it ('cancel' for Esc, ✕ and the backdrop). */
  open(): Promise<string>;
  /** Closes the dialog from code, resolving open() with `id`. */
  close(id?: string): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'sc-dialog': ScDialog;
  }
  interface HTMLElementEventMap {
    'sc-dialog-open': CustomEvent<void>;
    'sc-dialog-close': CustomEvent<{ id: string }>;
  }
  namespace JSX {
    interface IntrinsicElements {
      'sc-dialog': { [attribute: string]: unknown };
    }
  }
}
