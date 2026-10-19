import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/** Defines a stub only when jsdom lacks the API (DOM typings claim it always exists). */
function stub(target: object, key: string, value: unknown): void {
  if (!(key in target)) {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }
}

// Browser APIs used by Radix primitives and next-themes that jsdom lacks.
stub(Element.prototype, 'hasPointerCapture', () => false);
stub(Element.prototype, 'setPointerCapture', () => undefined);
stub(Element.prototype, 'releasePointerCapture', () => undefined);
stub(Element.prototype, 'scrollIntoView', () => undefined);
stub(
  globalThis,
  'ResizeObserver',
  class {
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  },
);
stub(window, 'matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
