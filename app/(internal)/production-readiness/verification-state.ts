/** One line of a "Run verification" report: which check, whether it answered, and what it said. */
export type VerificationResult = { name: string; status: 'ok' | 'failed' | 'skipped'; message: string };

export type VerificationState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
  results?: VerificationResult[];
};

export const IDLE_VERIFICATION: VerificationState = { status: 'idle' };
