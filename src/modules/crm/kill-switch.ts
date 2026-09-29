/**
 * The outbound kill switch, as the send callers see it — SCR-068,
 * `core.kill_switches` (20261001150000).
 *
 * The refusal itself is the database's: `crm.send_outbound_message` answers
 * `outbound_paused` before it records a row, so no caller can send while the
 * owner has the switch on. This file only gives the outcome one name and one
 * sentence, so the runner's handlers and the person-facing doors say the
 * same thing. A paused send is NOT permanent: the job retries on its
 * schedule and goes out once the owner releases the switch (or dies after
 * its attempts, where the dead-letters list and the alert say why).
 *
 * No `server-only`: the constants are strings a client form may show.
 */
export const OUTBOUND_PAUSED = 'outbound_paused' as const;

export const OUTBOUND_PAUSED_MESSAGE =
  'Outbound messaging is paused by the owner (emergency controls, Governance › Overrides). Nothing is sent until the switch is released.';

export function outboundPaused(): { status: 'failed'; permanent: false; detail: string } {
  return { status: 'failed', permanent: false, detail: OUTBOUND_PAUSED_MESSAGE };
}
