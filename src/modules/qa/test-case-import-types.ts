import type { FormState } from '@/modules/identity/types';

/**
 * SCR-045 — the import's client-safe shapes. No `server-only` here: the
 * preview form is a client component and renders these.
 */

export type TestCaseImportRow = {
  /** A scope item of the plan's baseline — its id, or its exact title. */
  requirement: string;
  /** One of `TEST_CATEGORIES`. */
  category: string;
  reason: string;
  criticalPath: boolean;
  preconditions?: string;
  steps?: string;
  expectedResult?: string;
  /** A task id on the plan's project, to link the case to. */
  task?: string;
};

/** `row` is 1-based over the data rows; 0 means the whole input. */
export type TestCaseImportIssue = { row: number; message: string };

export type TestCaseImportParse = {
  format: 'json' | 'csv' | 'empty';
  rows: TestCaseImportRow[];
  issues: TestCaseImportIssue[];
};

/** What the preview step hands back: parsed rows and errors, nothing written. */
export type TestCaseImportFormState = FormState & {
  preview?: TestCaseImportParse & { planId: string };
};

export const IMPORT_IDLE_STATE: TestCaseImportFormState = { status: 'idle' };
