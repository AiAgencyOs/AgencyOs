import { z } from 'zod';

/**
 * Automatic past-due reminders — owner decision 2026-09-29 (AGENT_BRIEF_D
 * decision 1). The pure half: the policy's shape, which thread a reminder
 * goes on, and the words it carries. The worker (reminder-worker.ts) and the
 * settings door (reminder-service.ts) both read from here, so a test can
 * pin the rule without a database.
 */

/** The template situation an approved reminder template is registered under. */
export const INVOICE_REMINDER_SITUATION_KEY = 'invoice_reminder';

export const REMINDER_INTERVAL_MIN_DAYS = 1;
export const REMINDER_INTERVAL_MAX_DAYS = 90;
export const REMINDER_INTERVAL_DEFAULT_DAYS = 7;

export const reminderPolicySchema = z.object({
  enabled: z.boolean(),
  intervalDays: z
    .number()
    .int('Whole days only.')
    .min(REMINDER_INTERVAL_MIN_DAYS, `At least ${REMINDER_INTERVAL_MIN_DAYS} day.`)
    .max(REMINDER_INTERVAL_MAX_DAYS, `At most ${REMINDER_INTERVAL_MAX_DAYS} days.`),
});
export type ReminderPolicyInput = z.infer<typeof reminderPolicySchema>;

export type ReminderThreadCandidate = {
  conversationId: string;
  kind: string;
  status: string;
  clientAccountId: string | null;
  projectId: string | null;
  updatedAt: string;
};

/**
 * Which thread a reminder goes on, given the threads that belong to the
 * invoice's client account or its project.
 *
 * The client-account thread first: it is the client's own channel with the
 * agency and outlives any one project. Then the project's group, where the
 * bill's work was discussed. Never a lead's pre-conversion thread — a bill is
 * not a sales conversation. Never an abandoned thread. Newest first within a
 * kind, so a re-linked group wins over the one it replaced.
 */
export function pickReminderThread(
  invoice: { clientAccountId: string; projectId: string | null },
  threads: readonly ReminderThreadCandidate[],
): ReminderThreadCandidate | null {
  const live = threads.filter((t) => t.status !== 'abandoned');
  const newest = (a: ReminderThreadCandidate, b: ReminderThreadCandidate) => b.updatedAt.localeCompare(a.updatedAt);

  const account = live
    .filter((t) => t.kind === 'client_account' && t.clientAccountId === invoice.clientAccountId)
    .sort(newest)[0];
  if (account) return account;

  if (invoice.projectId) {
    const group = live
      .filter((t) => t.kind === 'project_group' && t.projectId === invoice.projectId)
      .sort(newest)[0];
    if (group) return group;
  }

  return null;
}

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

/**
 * The reminder's words when the window is open and free text may go. Plain
 * and factual: the number, what is outstanding, when it was due. No
 * greeting by name — the name is a template variable's job, and a wrong one
 * is worse than none.
 */
export function reminderMessage(input: {
  agencyName: string;
  invoiceNumber: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  dueAt: string;
  timeZone: string;
}): string {
  const outstanding = Math.max(0, input.totalMinor - input.paidMinor);
  const due = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: input.timeZone }).format(new Date(input.dueAt));
  const lines = [
    `A reminder from ${input.agencyName}: invoice ${input.invoiceNumber} was due on ${due}.`,
    `Outstanding: ${money(outstanding, input.currency)}${input.paidMinor > 0 ? ` (of ${money(input.totalMinor, input.currency)}; ${money(input.paidMinor, input.currency)} received)` : ''}.`,
    'If you have already paid, please share the payment reference and we will match it. Thank you.',
  ];
  return lines.join('\n');
}
