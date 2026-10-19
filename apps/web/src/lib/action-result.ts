import { notify } from '@/components/feedback/toast';
import type { ActionResult } from '@/lib/form-state';

/**
 * Reports a button-style server action with a toast. Throws on failure so
 * callers such as ConfirmDialog stay open and show their error state.
 */
export async function reportAction<T extends ActionResult>(result: Promise<T>): Promise<T> {
  const outcome = await result;
  if (!outcome.ok) {
    notify.error(outcome.message);
    throw new Error(outcome.message);
  }
  if (outcome.message) notify.success(outcome.message);
  return outcome;
}
