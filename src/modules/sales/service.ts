import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { markLeadConverted } from '@/modules/crm/service';
import { createProject } from '@/modules/projects/service';

import {
  convertToProjectSchema,
  createOpportunitySchema,
  setOpportunityStageSchema,
  OPPORTUNITY_TRANSITIONS,
  type ConvertToProjectInput,
  type CreateOpportunityInput,
  type OpportunityStage,
  type SetOpportunityStageInput,
} from './schema';

/**
 * Writes for the sales module — its only public surface.
 *
 * This module owns the deal: opening it against a lead, moving it through the
 * stages, and the handoff to delivery when it is won. Cross-module work goes
 * through the other modules' service.ts (ARCHITECTURE.md §3.2) — this file
 * never touches crm or projects tables directly.
 *
 * Capabilities are reused, not invented: `lead.write` covers working a deal
 * that belongs to a lead, and `project.write` is additionally required to
 * convert, because conversion creates a project.
 */

/** Opens an opportunity against a qualified lead. */
export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<Result<{ opportunityId: string }>> {
  const parsed = createOpportunitySchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid opportunity.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to open opportunities.');
  }

  const supabase = await createClient();

  const { data: lead } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, organization_id, status')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!lead) return err('NOT_FOUND', 'Lead not found.');
  if (lead.status === 'disqualified') {
    return err('CONFLICT', 'A disqualified lead has no open deal. Reopen it first.');
  }

  const { data: existing } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id')
    .eq('lead_id', lead.id)
    .limit(1)
    .maybeSingle();

  if (existing) return ok({ opportunityId: existing.id });

  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .insert({
      organization_id: lead.organization_id,
      lead_id: lead.id,
      name: parsed.data.name,
      stage: 'discovery',
      value_minor: parsed.data.valueMinor,
      expected_close_on: parsed.data.expectedCloseOn ?? null,
      owner_id: context.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    // Losing `opportunities_lead_key` is not a failure — it means another
    // click opened a deal on this lead while this one was working, and the
    // pre-check above simply ran too early to see it (audit D21). The answer
    // is the deal that won, which is the same answer the pre-check gives when
    // it is not racing.
    //
    // Matched on the index name rather than on the code alone: a 23505 from
    // some other constraint added later is a genuine error and must not be
    // answered with a re-read that finds nothing.
    if (error?.code === '23505' && error.message.includes('opportunities_open_lead_key')) {
      const { data: winner, error: reReadError } = await supabase
        .schema('sales')
        .from('opportunities')
        .select('id')
        .eq('lead_id', lead.id)
        .limit(1)
        .maybeSingle();

      if (winner) return ok({ opportunityId: winner.id });

      // The index says a row exists and this cannot see it. Reporting success
      // would mean returning no id; reporting the conflict is the honest
      // answer, and it is retryable by hand.
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'createOpportunity',
          detail: `lost opportunities_open_lead_key but could not read the winner${
            reReadError ? `: ${reReadError.message}` : ''
          }`,
        }),
      );
      return err('CONFLICT', 'A deal was just opened on this lead. Reload to see it.');
    }

    console.error(
      JSON.stringify({ level: 'error', scope: 'createOpportunity', detail: error?.message }),
    );
    return err('INTERNAL', 'Could not open the opportunity.');
  }

  await recordAudit({
    organizationId: lead.organization_id,
    action: 'opportunity.created',
    subjectType: 'opportunity',
    subjectId: data.id,
    after: { leadId: lead.id, name: parsed.data.name, valueMinor: parsed.data.valueMinor },
  });

  return ok({ opportunityId: data.id });
}

/** Moves a deal through the sales stages, including to won or lost. */
export async function setOpportunityStage(
  input: SetOpportunityStageInput,
): Promise<Result<{ stage: OpportunityStage }>> {
  const parsed = setOpportunityStageSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid stage change.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to move deals.');
  }

  if (parsed.data.stage === 'lost' && !parsed.data.lostReason?.trim()) {
    return err('VALIDATION', 'A lost deal needs a reason.');
  }

  const supabase = await createClient();

  const { data: opportunity } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, stage, organization_id')
    .eq('id', parsed.data.opportunityId)
    .maybeSingle();

  if (!opportunity) return err('NOT_FOUND', 'Opportunity not found.');

  const from = opportunity.stage as OpportunityStage;
  const to = parsed.data.stage;

  if (from === to) return ok({ stage: to });
  if (!OPPORTUNITY_TRANSITIONS[from]?.includes(to)) {
    return err('CONFLICT', `A deal cannot move from ${from} to ${to}.`);
  }

  const terminal = to === 'won' || to === 'lost';

  // The predicate the decision was made against, restated in the write (audit
  // D10). Reading the state and then matching on the id alone means a
  // concurrent transition is silently overwritten — the same shape D1, D2 and
  // D4 fixed in finance, where the answer was a lock. Here a compare-and-swap
  // is enough: there is no ledger to sum, only a state to not clobber, and a
  // write that matches zero rows says the world moved.
  const { data: moved, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .update({
      stage: to,
      // The table requires closed_at whenever the stage is terminal.
      ...(terminal ? { closed_at: new Date().toISOString() } : {}),
      ...(to === 'lost' ? { lost_reason: parsed.data.lostReason ?? null } : {}),
    })
    .eq('id', opportunity.id)
    .eq('stage', from)
    .select('id')
    .maybeSingle();

  if (error) {
    // Reopening a settled deal — `lost → discovery`, or `won → discovery` —
    // can now collide with `opportunities_open_lead_key` (audit D21), because
    // the index counts open deals and reopening makes this one of them. That
    // is the index doing its job: the lead already has an open deal, and two
    // is the state D21 exists to prevent. Said in those words rather than as
    // "Could not move the deal", which tells the operator nothing they can act
    // on.
    if (error.code === '23505' && error.message.includes('opportunities_open_lead_key')) {
      return err(
        'CONFLICT',
        'This lead already has an open deal. Settle that one before reopening this.',
      );
    }
    console.error(
      JSON.stringify({ level: 'error', scope: 'setOpportunityStage', detail: error.message }),
    );
    return err('INTERNAL', 'Could not move the deal.');
  }

  if (!moved) {
    // The case that matters: a deal marked won, then overwritten as lost by a
    // caller that read it while it was still in negotiation.
    return err(
      'CONFLICT',
      'This deal was moved by somebody else while you were working. Reload and try again.',
    );
  }

  await recordAudit({
    organizationId: opportunity.organization_id,
    action: to === 'won' ? 'opportunity.won' : 'opportunity.stage_changed',
    subjectType: 'opportunity',
    subjectId: opportunity.id,
    before: { stage: from },
    after: { stage: to, lostReason: parsed.data.lostReason ?? null },
  });

  return ok({ stage: to });
}

/**
 * Turns a won deal into a client and a project — the LEAD → CLIENT WON →
 * PROJECT CREATION handoff.
 *
 * Only a won opportunity converts, and only once: the second call returns the
 * project that already exists rather than creating a duplicate, which matters
 * because a double-clicked button must not produce two projects for one deal.
 *
 * The client account is created here when the deal has none. core has no
 * module of its own to own that table (ARCHITECTURE.md §4.2 lists it under the
 * core *schema*, and §2 has no core module), and the won deal is the moment
 * the client first exists as a billable entity.
 */
export async function convertToProject(
  input: ConvertToProjectInput,
): Promise<Result<{ projectId: string; clientAccountId: string; created: boolean }>> {
  const parsed = convertToProjectSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid conversion request.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write') || !can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to convert deals into projects.');
  }

  const supabase = await createClient();

  const { data: opportunity } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, name, stage, organization_id, lead_id, client_account_id, value_minor, currency')
    .eq('id', parsed.data.opportunityId)
    .maybeSingle();

  if (!opportunity) return err('NOT_FOUND', 'Opportunity not found.');
  if (opportunity.stage !== 'won') {
    return err('CONFLICT', 'Only a won deal can be converted into a project.');
  }

  // Idempotency: one project per opportunity.
  const { data: alreadyConverted } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, client_account_id')
    .eq('opportunity_id', opportunity.id)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();

  if (alreadyConverted) {
    return ok({
      projectId: alreadyConverted.id,
      clientAccountId: alreadyConverted.client_account_id,
      created: false,
    });
  }

  // ── the client ──────────────────────────────────────────────────────────
  let clientAccountId = opportunity.client_account_id;

  if (!clientAccountId) {
    const { data: account, error: accountError } = await supabase
      .schema('core')
      .from('client_accounts')
      .insert({
        organization_id: opportunity.organization_id,
        name: parsed.data.clientAccountName ?? opportunity.name,
        currency: opportunity.currency,
      })
      .select('id')
      .single();

    if (accountError || !account) {
      console.error(
        JSON.stringify({ level: 'error', scope: 'convertToProject', detail: accountError?.message }),
      );
      return err('INTERNAL', 'Could not create the client account.');
    }

    clientAccountId = account.id;

    await supabase
      .schema('sales')
      .from('opportunities')
      .update({ client_account_id: clientAccountId })
      .eq('id', opportunity.id);

    await recordAudit({
      organizationId: opportunity.organization_id,
      action: 'client_account.created',
      subjectType: 'client_account',
      subjectId: clientAccountId,
      after: { name: parsed.data.clientAccountName ?? opportunity.name },
    });
  }

  // ── the project ─────────────────────────────────────────────────────────
  const project = await createProject({
    organizationId: opportunity.organization_id,
    clientAccountId,
    opportunityId: opportunity.id,
    name: parsed.data.projectName,
    budgetMinor: opportunity.value_minor,
    currency: opportunity.currency,
  });

  if (!project.ok) {
    // Losing the index is not a failure — it means another click converted
    // this deal while this one was working, and the answer is the project it
    // created (audit D9). The pre-check above catches the ordinary repeat;
    // projects_opportunity_key catches the concurrent one it cannot.
    if (project.error.code === 'CONFLICT' && project.error.message.includes('already been converted')) {
      const { data: raced } = await supabase
        .schema('projects')
        .from('projects')
        .select('id, client_account_id')
        .eq('opportunity_id', opportunity.id)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();

      if (raced) {
        return ok({
          projectId: raced.id,
          clientAccountId: raced.client_account_id,
          created: false,
        });
      }
    }
    return project;
  }

  // ── close the loop on the lead ──────────────────────────────────────────
  if (opportunity.lead_id) {
    const converted = await markLeadConverted(opportunity.lead_id);
    if (!converted.ok) {
      // The project exists and is the durable outcome; a lead left in
      // `qualified` is visibly wrong in the pipeline and can be re-run, which
      // is far better than rolling back a created project.
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'convertToProject',
          detail: `project ${project.data.projectId} created but lead ${opportunity.lead_id} not marked converted`,
        }),
      );
    }
  }

  return ok({ projectId: project.data.projectId, clientAccountId, created: true });
}
