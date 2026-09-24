/** <sc-toast>: a toast region with a static show() API. See toast.js. */
export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  onSelect?: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Default 'info'. */
  tone?: ToastTone;
  /** Milliseconds; 0 keeps the toast until dismissed. Default 4000, or 8000 with an action. */
  duration?: number;
}

export interface ToastHandle {
  dismiss(): void;
}

export class ScToast extends HTMLElement {
  /** Shows a toast in the page's region, creating the region on first use. */
  static show(text: string, options?: ToastOptions): ToastHandle;
  /** Removes every toast at once. */
  static clear(): void;
  show(text: string, options?: ToastOptions): ToastHandle;
  dismiss(item: Element): void;
  clear(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'sc-toast': ScToast;
  }
  namespace JSX {
    interface IntrinsicElements {
      'sc-toast': { [attribute: string]: unknown };
    }
  }
}
