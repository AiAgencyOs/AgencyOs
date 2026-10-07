/**
 * A29 Incidents / recovery queue (P1-BLUEPRINT-035): the runbook shown beside each kind of incident. These are the steps a person takes with the controls this
 * product already has; none of them is automated and none of them skips a human gate. The text names the screen or door that does the work, so a step can be
 * followed without knowing the code.
 *
 * `ai.p1s_incident_queue` assigns each row one of these keys; a key the database invents that is not here is shown as "no runbook written" rather than hidden.
 */
export type IncidentRunbook = { key: string; title: string; steps: readonly string[] };

export const INCIDENT_RUNBOOKS: readonly IncidentRunbook[] = [
  {
    key: 'uncertain_side_effect',
    title: 'A task may have had an effect we cannot see',
    steps: [
      'Do not retry yet. The last attempt may already have done its work (sent a message, booked a slot, created a record), and a retry would do it twice.',
      'Open the task and read the last failure and the blocker. Then check the real world: the WhatsApp thread, the calendar, the quotation list, whichever the task touches.',
      'Use "Reconcile" on the task (an Admin action): say whether the effect happened, with a note of what you checked. The note is kept on the task and the uncertainty is cleared. If the effect happened, do not retry; finish the work by hand or escalate. If it did not, a retry is now safe.',
      'If you cannot tell, escalate the task and leave it paused. Never mark an effect as not having happened without looking.',
    ],
  },
  {
    key: 'task_failed',
    title: 'A task failed for good',
    steps: [
      'Open the task. Read the last failure and the acceptance criteria it was held to.',
      'If the cause is outside the task (a provider was down, a record was missing), fix that first, then retry from the task board with a reason.',
      'If another agent could do it, reassign it with a reason. The new owner gets the same contract, the same idempotency key and the same acceptance criteria.',
      'If it cannot be done, escalate it to an Admin with what was tried. A person decides; the product never closes a failed task as done.',
    ],
  },
  {
    key: 'task_rejected',
    title: 'The receiving agent refused a task',
    steps: [
      'Open the task and read the refusal. A refusal is usually a policy, a missing permission or a missing input, not a fault.',
      'If an input is missing, supply it where it belongs (the lead, the requirement, the quotation) and re-queue the task with a reason.',
      'If the refusal is the policy working as intended, close the loop with the client or the owner yourself; do not route around the refusal.',
      'An urgent refused task also needs a person to tell the client or the owner that work is waiting.',
    ],
  },
  {
    key: 'security_incident',
    title: 'A security incident is open',
    steps: [
      'Open the incident on the Security screen and read the evidence recorded with it.',
      'Contain first: rotate the credential, revoke the session or switch the integration off with the kill switch on the Operations screen, whichever applies. Each of those is audited with a reason.',
      'Write what happened and what was done in the resolution note. Only an Admin can close an incident; a delivery lead can record evidence but not close it.',
      'If client data may have been exposed, tell the owner before anything else; telling the client is the owner\'s decision.',
    ],
  },
  {
    key: 'escalation',
    title: 'Someone escalated a matter to a role',
    steps: [
      'Open the escalation from the notifications inbox and read the reason it was raised.',
      'Acknowledge it so the person who raised it knows it was seen, then decide or hand it to the right person.',
      'Resolve it with a note of the decision. The note is what the next reader will rely on.',
    ],
  },
  {
    key: 'dead_job',
    title: 'A background job ran out of attempts',
    steps: [
      'Open the Operations screen and find the job under dead letters. Read the last error.',
      'If the error was transient (a provider outage that has passed), requeue the job with a reason. The job keeps its idempotency key, so a requeue cannot double-send.',
      'If the error will repeat, cancel the job with a reason and fix the cause; requeueing the same failure only fills the dead letters again.',
    ],
  },
  {
    key: 'provider_outage',
    title: 'A provider is unavailable',
    steps: [
      'The circuit for this provider is open: calls to it are being refused instead of retried, so work is not piling up against a dead service.',
      'Check the provider\'s own status page and your credential on the Integrations screen. An expired or revoked credential looks like an outage.',
      'Nothing is lost while the circuit is open: affected tasks wait or fail with a retry. When the provider is back, the circuit probes it and closes by itself, or an Admin can close it from Operations with a reason.',
      'Tell anyone waiting on a client-facing message that it is delayed; do not send it by another route that skips the consent and window checks.',
    ],
  },
];

export function runbookFor(key: string): IncidentRunbook | null {
  return INCIDENT_RUNBOOKS.find((r) => r.key === key) ?? null;
}
