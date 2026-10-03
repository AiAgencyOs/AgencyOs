/**
 * The three switches and their words — client-safe, so the panel that shows
 * them (a client component) never pulls the server-only reader in.
 */
export const KILL_SWITCHES = ['agents_paused', 'outbound_paused', 'jobs_paused'] as const;
export type KillSwitch = (typeof KILL_SWITCHES)[number];

export const KILL_SWITCH_LABEL: Record<KillSwitch, string> = {
  agents_paused: 'Pause AI agents',
  outbound_paused: 'Pause outbound messaging',
  jobs_paused: 'Pause the job queue',
};

export const KILL_SWITCH_EFFECT: Record<KillSwitch, string> = {
  agents_paused: 'No agent job is claimed; a running agent stops at its next step and its job returns to the queue.',
  outbound_paused: 'Every WhatsApp send is refused at the chokepoint — quotations, reminders, announcements, follow-ups — until released.',
  jobs_paused: 'No job of any kind is claimed by the runner. Work waits; nothing is lost.',
};

export type KillSwitchRow = {
  switch: KillSwitch;
  active: boolean;
  reason: string | null;
  setAt: string | null;
  setByName: string | null;
};

