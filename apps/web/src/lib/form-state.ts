/** Result of a form server action (used with `useActionState`). */
export interface FormState {
  status: 'idle' | 'error' | 'success';
  message?: string;
  fieldErrors?: Record<string, string>;
}

export const INITIAL_FORM_STATE: FormState = { status: 'idle' };

/** Result of a button-style server action (confirm dialogs, menus). */
export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };
