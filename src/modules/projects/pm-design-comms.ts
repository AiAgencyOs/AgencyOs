import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { sendSystemText, type SystemTextResult } from '@/modules/crm/system-message';

import type { HandlerResult } from './handlers';
import { loadContext, settle, type PmContext, type PmCommsJob } from './pm-client-comms';
import type { PmLanguage } from './pm-messages';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * What the project manager says to the client during Phase 3 (UI theme and colour
 * finalization) - Phase 3 PM spec §10-§11, Master §7.1 and §16.
 *
 * The wording is `projects.design_message_templates` (an organisation's own) or the
 * shipped default (`projects.default_design_message`, §11 verbatim); the PM spec says
 * these are configurable examples, so nothing here hard-codes a sentence. The Hinglish
 * row is used for a Hinglish or Hindi client; there is no Devanagari variant of the
 * design templates yet, so a Hindi client reads English rather than a machine
 * translation of a message that asks for a decision.
 *
 * Three sends happen here, each at most once under a stable reference:
 *   1. Phase 3 starts            -> the announcement (§7.1)
 *   2. a theme and colour chosen -> the request for final confirmation (§15)
 *   3. options shared            -> `shareDesignWithClient` (called from the share action,
 *                                   because a share is a PERSON releasing what Admin approved)
 * None of them states a price, a date or an approval the system does not hold, and none
 * names a provider or a model (the template trigger refuses that at the row).
 */

export type DesignStep = 'phase_three_start' | 'theme_review' | 'revision_ready' | 'final_confirmation';

const templateLanguage = (language: PmLanguage): 'en' | 'hinglish' => (language === 'hinglish' ? 'hinglish' : 'en');

/** The wording for a step: the organisation's row, else the shipped default. Variables are filled from the caller's facts. */
export async function designMessageText(
  admin: Admin,
  args: { organizationId: string; step: DesignStep; language: PmLanguage; clientName: string; projectName: string; optionNames?: string; optionCount?: number; round?: number },
): Promise<string | null> {
  const lang = templateLanguage(args.language);
  const { data: own } = await admin
    .schema('projects')
    .from('design_message_templates')
    .select('body')
    .eq('organization_id', args.organizationId)
    .eq('step_key', args.step)
    .eq('language', lang)
    .maybeSingle();
  let body: string | null = own?.body ?? null;
  if (!body) {
    const { data } = await admin.schema('projects').rpc('default_design_message', { p_step_key: args.step });
    body = typeof data === 'string' ? data : null;
  }
  if (!body) return null;
  return body
    .replaceAll('{{client_name}}', args.clientName)
    .replaceAll('{{project_name}}', args.projectName)
    .replaceAll('{{option_names}}', args.optionNames ?? '')
    .replaceAll('{{option_count}}', String(args.optionCount ?? 0))
    .replaceAll('{{round_number}}', String(args.round ?? 0));
}

async function clientNameOf(admin: Admin, ctx: PmContext): Promise<string> {
  if (!ctx.clientAccountId) return 'there';
  const { data } = await admin.schema('core').from('client_accounts').select('name').eq('id', ctx.clientAccountId).maybeSingle();
  return data?.name ?? 'there';
}

async function noThread(admin: Admin, ctx: PmContext, what: string): Promise<HandlerResult> {
  await admin.schema('core').rpc('raise_alert', {
    p_organization_id: ctx.organizationId,
    p_source: 'design',
    p_severity: 'info',
    p_summary: `${ctx.projectName}: ${what} was not sent - the client has no WhatsApp thread, so a person must tell them.`,
    p_fingerprint: `pm-design-no-thread:${ctx.projectId}:${what}`,
  });
  return { status: 'succeeded', outcome: 'no_thread', detail: what };
}

const subjectOf = (job: PmCommsJob): string | null => (typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null);

// ── 1. Phase 3 starts -> the announcement ─────────────────────────────────────

/** `project.phase_three_started` (subject: the phase_three row) -> say the UI finalization stage has begun. */
export async function handleAnnouncePhaseThree(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const phaseId = subjectOf(job);
  if (!phaseId) return { status: 'failed', permanent: true, detail: 'the event named no phase' };

  // Row authority: the project comes from the phase row, never from the payload.
  const { data: phase, error } = await admin
    .schema('projects')
    .from('phase_three')
    .select('id, project_id')
    .eq('id', phaseId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the phase: ${error.message}` };
  if (!phase) return { status: 'succeeded', outcome: 'gone', detail: 'the phase no longer exists' };

  const ctx = await loadContext(admin, job.organization_id, phase.project_id);
  if (ctx === 'unreadable') return { status: 'failed', permanent: false, detail: 'could not read the project' };
  if (ctx === 'gone') return { status: 'succeeded', outcome: 'gone', detail: 'the project no longer exists' };
  if (!ctx.conversationId) return noThread(admin, ctx, 'The Phase 3 announcement');

  const body = await designMessageText(admin, {
    organizationId: ctx.organizationId,
    step: 'phase_three_start',
    language: ctx.language,
    clientName: await clientNameOf(admin, ctx),
    projectName: ctx.projectName,
  });
  if (!body) return { status: 'failed', permanent: true, detail: 'no wording exists for the Phase 3 announcement' };

  return settle([
    {
      label: 'phase 3 announcement',
      result: await sendSystemText(admin as never, { organizationId: ctx.organizationId, conversationId: ctx.conversationId, body, ref: `pm:phase3-start:${phase.id}` }),
    },
  ]);
}

// ── 2. a theme and colour chosen -> ask for the final confirmation ──────────

/**
 * `project.client_design_selected` (subject: the decision) -> "please confirm the selected
 * theme and colour" (§15 FINAL CONFIRMATION). The confirmation itself is recorded by a
 * person from the client's own words; this only asks.
 */
export async function handleAskFinalConfirmation(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const decisionId = subjectOf(job);
  if (!decisionId) return { status: 'failed', permanent: true, detail: 'the event named no decision' };

  const { data: decision, error } = await admin
    .schema('projects')
    .from('client_design_decisions')
    .select('id, project_id, decision, phase_three_id')
    .eq('id', decisionId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the decision: ${error.message}` };
  if (!decision) return { status: 'succeeded', outcome: 'gone', detail: 'the decision no longer exists' };
  if (decision.decision !== 'client_selected') return { status: 'succeeded', outcome: 'not_a_selection', detail: `a ${decision.decision} is not asked to confirm` };

  // Already confirmed (a person recorded it before this job ran) -> nothing to ask.
  const { data: confirmed } = await admin
    .schema('projects')
    .from('client_design_decisions')
    .select('id')
    .eq('phase_three_id', decision.phase_three_id)
    .eq('decision', 'final_confirmed')
    .limit(1);
  if ((confirmed ?? []).length > 0) return { status: 'succeeded', outcome: 'already_confirmed', detail: 'the client has already confirmed' };

  const ctx = await loadContext(admin, job.organization_id, decision.project_id);
  if (ctx === 'unreadable') return { status: 'failed', permanent: false, detail: 'could not read the project' };
  if (ctx === 'gone') return { status: 'succeeded', outcome: 'gone', detail: 'the project no longer exists' };
  if (!ctx.conversationId) return noThread(admin, ctx, 'The final-confirmation request');

  const body = await designMessageText(admin, {
    organizationId: ctx.organizationId,
    step: 'final_confirmation',
    language: ctx.language,
    clientName: await clientNameOf(admin, ctx),
    projectName: ctx.projectName,
  });
  if (!body) return { status: 'failed', permanent: true, detail: 'no wording exists for the final confirmation' };

  return settle([
    {
      label: 'final confirmation request',
      result: await sendSystemText(admin as never, { organizationId: ctx.organizationId, conversationId: ctx.conversationId, body, ref: `pm:design-final-ask:${decision.id}` }),
    },
  ]);
}

// ── 3. sharing the Admin-approved options ────────────────────────────────────

export type SharedOptionLine = { optionIndex: number; name: string; figmaUrl: string | null; previewUrl: string | null };

export const figmaViewUrl = (fileKey: string | null, nodeId: string | null): string | null =>
  fileKey ? `https://www.figma.com/design/${fileKey}${nodeId ? `?node-id=${encodeURIComponent(nodeId.replace(':', '-'))}` : ''}` : null;

/** The list a client reads under the template: each option's name and where to look. Pure, so it can be tested without a thread. */
export function optionLines(lines: SharedOptionLine[]): string {
  return lines
    .slice()
    .sort((a, b) => a.optionIndex - b.optionIndex)
    .map((l) => `${l.optionIndex}. ${l.name}${l.figmaUrl ?? l.previewUrl ? ` - ${l.figmaUrl ?? l.previewUrl}` : ''}`)
    .join('\n');
}

export type SendShareResult = { result: SystemTextResult; body: string; conversationId: string; ref: string };

/**
 * Build and send the "here are the options" message for the options a person ticked.
 * The caller records the share (`record_design_share`) with this send's message id as
 * its evidence, so the Admin Panel can answer "which samples did this client get?"
 * from a message this system holds rather than from a pasted reference.
 *
 * Which template: `revision_ready` when a revised option has been delivered AND passed
 * Admin (the render door's own rule, repeated here by reading the same facts), else
 * `theme_review`.
 */
export async function sendDesignOptions(
  admin: Admin,
  args: { organizationId: string; projectId: string; phaseThreeId: string; shareNumber: number; themeOptionIds: string[]; revised: boolean },
): Promise<SendShareResult | { error: string }> {
  const ctx = await loadContext(admin, args.organizationId, args.projectId);
  if (ctx === 'unreadable') return { error: 'Could not read the project.' };
  if (ctx === 'gone') return { error: 'The project no longer exists.' };
  if (!ctx.conversationId) return { error: 'This client has no WhatsApp thread, so AgencyOS cannot send. Send it yourself and record the reference.' };

  const { data: options, error } = await admin
    .schema('projects')
    .from('theme_options')
    .select('id, name, option_index, admin_status, figma_file_key, figma_node_id, preview_asset_url')
    .in('id', args.themeOptionIds)
    .eq('phase_three_id', args.phaseThreeId)
    .eq('organization_id', args.organizationId);
  if (error) return { error: 'Could not read the options.' };
  const rows = options ?? [];
  if (rows.length === 0 || rows.length !== new Set(args.themeOptionIds).size) return { error: 'One of those options does not belong to this project.' };
  const unapproved = rows.filter((o) => o.admin_status !== 'approved');
  if (unapproved.length > 0) return { error: `Admin has not approved ${unapproved.map((o) => o.name).join(', ')}. Only approved options may reach a client.` };

  const lines = optionLines(
    rows.map((o) => ({ optionIndex: o.option_index, name: o.name, figmaUrl: figmaViewUrl(o.figma_file_key, o.figma_node_id), previewUrl: o.preview_asset_url })),
  );
  const step: DesignStep = args.revised ? 'revision_ready' : 'theme_review';
  const intro = await designMessageText(admin, {
    organizationId: ctx.organizationId,
    step,
    language: ctx.language,
    clientName: await clientNameOf(admin, ctx),
    projectName: ctx.projectName,
    optionNames: rows.map((o) => o.name).join(', '),
    optionCount: rows.length,
  });
  if (!intro) return { error: 'No wording exists for this message.' };

  const body = `${intro}\n\n${lines}`;
  const ref = `pm:design-share:${args.phaseThreeId}:${args.shareNumber}`;
  const result = await sendSystemText(admin as never, { organizationId: ctx.organizationId, conversationId: ctx.conversationId, body, ref });
  return { result, body, conversationId: ctx.conversationId, ref };
}
