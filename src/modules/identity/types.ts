/**
 * Form state shared between actions.ts and the components that render it.
 *
 * Kept out of actions.ts because a `'use server'` module may only export async
 * functions — a plain object export there is a build error.
 */
export type FormState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export const IDLE_STATE: FormState = { status: 'idle' };
