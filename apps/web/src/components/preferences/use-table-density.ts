'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { TABLE_DENSITIES, type TableDensity } from '@/design/tokens';

const STORAGE_KEY = 'envvault:table-density';
const CHANGE_EVENT = 'envvault:table-density-change';
const DEFAULT_DENSITY: TableDensity = 'default';

function isDensity(value: unknown): value is TableDensity {
  return typeof value === 'string' && (TABLE_DENSITIES as readonly string[]).includes(value);
}

function read(): TableDensity {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isDensity(stored) ? stored : DEFAULT_DENSITY;
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
    return DEFAULT_DENSITY;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/**
 * Per-browser table density preference (a UI convenience, not account data).
 * Server render and first client render use the default to avoid hydration
 * mismatches; the stored value applies right after hydration.
 */
export function useTableDensity(): [TableDensity, (density: TableDensity) => void] {
  const density = useSyncExternalStore(subscribe, read, () => DEFAULT_DENSITY);
  const setDensity = useCallback((next: TableDensity) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore: the preference simply will not persist.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [density, setDensity];
}
