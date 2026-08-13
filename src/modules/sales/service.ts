import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { markLeadConverted } from '@/modules/crm/service';
import { createProject } from '@/modules/projects/service';

import {
  addProposalItemSchema,
  convertToProjectSchema,
  createOpportunitySchema,
  draftProposalSchema,
  recordProposalResponseSchema,
  sendProposalSchema,
  setOpportunityStageSchema,
  setProposalPricingSchema,
  submitProposalSchema,
  OPPORTUNITY_TRANSITIONS,
  type AddProposalItemInput,
  type ConvertToProjectInput,
  type CreateOpportunityInput,
  type DraftProposalInput,
  type OpportunityStage,
  type ProposalStatus,
  type RecordProposalResponseInput,
  type SendProposalInput,
  type SetOpportunityStageInput,
  type SetProposalPricingInput,
  type SubmitProposalInput,
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
  /**
   * Moving out of a terminal stage — the only way a deal reopens.
   *
   * `lost → discovery` is the one arc that reaches this today; `won` is
   * terminal in OPPORTUNITY_TRANSITIONS and the transition check above refuses
   * anything leaving it. Written against "terminal" rather than against `lost`
   * so that opening `won` later is a change to the map alone, which is where
   * that rule lives.
   */
  const reopening = (from === 'won' || from === 'lost') && !terminal;

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
      // Cleared on the way out as well as set on the way in — gap G-089, and
      // exactly the shape D13 fixed for `disqualified_reason` on a lead.
      //
      // Both columns were only ever written when moving *to* a terminal stage,
      // so a reopened deal read as `discovery` while still carrying the date it
      // closed and the reason it was lost. `opportunities_closed_at_set` only
      // requires the date when the stage is terminal, so nothing objected —
      // and anything reporting on closed deals or on why deals are lost
      // counted a live one.
      ...(reopening ? { closed_at: null, lost_reason: null } : {}),
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
    const converted = await markLeadConverted(opportunity.lead_id, context.userId);
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

// ── quotations ─────────────────────────────────────────────────────────────
//
// G-011, ADM-07: staff draft, the owner approves, then it is sent. Document 09
// §15–§18 and §22 are the specification.
//
// Every guarantee that matters is in Postgres — version allocation under the
// opportunity's lock, the totals summed from the lines, the freeze once a
// version leaves draft, the approval gate on sending, and the refusal to treat
// delivery as acceptance. These functions validate an input, check the
// capability the matrix already publishes, and turn an outcome into a sentence
// somebody can act on. They deliberately re-check nothing: a check here would
// run before the lock, and the answer could be stale by the time it mattered.

/** What `sales.draft_proposal` hands back. */
type DraftRow = {
  outcome: 'created' | 'not_found' | 'settled';
  proposal_id: string | null;
  version: number | null;
  superseded: string | null;
};

const single = <T>(data: unknown): T | undefined =>
  (Array.isArray(data) ? data[0] : data) as T | undefined;

/**
 * Drafts the next quotation version against a deal.
 *
 * §16: drafting v2 supersedes whichever version was live, and cancels its
 * pending approval, so the owner's queue never holds a quote that can no
 * longer be sent.
 */
export async function draftProposal(
  input: DraftProposalInput,
): Promise<Result<{ proposalId: string; version: number; supersededId: string | null }>> {
  const parsed = draftProposalSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid quotation.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to draft quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('draft_proposal', {
    p_opportunity_id: parsed.data.opportunityId,
    p_title: parsed.data.title,
    p_created_by: context.userId,
    ...(parsed.data.body ? { p_body: parsed.data.body } : {}),
    ...(parsed.data.validUntil ? { p_valid_until: parsed.data.validUntil } : {}),
    ...(parsed.data.requirementVersionId
      ? { p_requirement_version_id: parsed.data.requirementVersionId }
      : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'draftProposal', detail: error.message }));
    return err('INTERNAL', 'Could not draft the quotation.');
  }

  const row = single<DraftRow>(data);
  if (!row) return err('INTERNAL', 'Could not draft the quotation.');

  switch (row.outcome) {
    case 'created':
      if (!row.proposal_id || row.version === null) {
        return err('INTERNAL', 'Could not draft the quotation.');
      }
      return ok({
        proposalId: row.proposal_id,
        version: row.version,
        supersededId: row.superseded,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Opportunity not found.');

    case 'settled':
      return err('CONFLICT', 'This deal is closed. A settled deal takes no new quotations.');

    default:
      return err('INTERNAL', 'Could not draft the quotation.');
  }
}

type ItemRow = {
  outcome: 'added' | 'not_found' | 'not_draft';
  item_id: string | null;
  subtotal_minor: number | null;
  total_minor: number | null;
};

/** Adds a line to a draft quotation. The totals come back recomputed. */
export async function addProposalItem(
  input: AddProposalItemInput,
): Promise<Result<{ itemId: string; subtotalMinor: number; totalMinor: number }>> {
  const parsed = addProposalItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid line item.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to edit quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('add_proposal_item', {
    p_proposal_id: parsed.data.proposalId,
    p_description: parsed.data.description,
    p_quantity: parsed.data.quantity,
    p_unit_price_minor: parsed.data.unitPriceMinor,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addProposalItem', detail: error.message }));
    return err('INTERNAL', 'Could not add the line.');
  }

  const row = single<ItemRow>(data);
  if (!row) return err('INTERNAL', 'Could not add the line.');

  switch (row.outcome) {
    case 'added':
      if (!row.item_id) return err('INTERNAL', 'Could not add the line.');
      return ok({
        itemId: row.item_id,
        subtotalMinor: row.subtotal_minor ?? 0,
        totalMinor: row.total_minor ?? 0,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    // The freeze §16 requires. Said as what to do next rather than as a
    // refusal, because the answer is always the same one.
    case 'not_draft':
      return err(
        'CONFLICT',
        'This version is no longer a draft. Draft the next version to change what it says.',
      );

    default:
      return err('INTERNAL', 'Could not add the line.');
  }
}

type PricingRow = {
  outcome: 'priced' | 'not_found' | 'not_draft' | 'discount_exceeds_subtotal';
  subtotal_minor: number | null;
  discount_minor: number | null;
  tax_minor: number | null;
  total_minor: number | null;
};

/** Sets the discount and tax on a draft quotation (§15). */
export async function setProposalPricing(
  input: SetProposalPricingInput,
): Promise<Result<{ subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number }>> {
  const parsed = setProposalPricingSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid pricing.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to price quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('set_proposal_pricing', {
    p_proposal_id: parsed.data.proposalId,
    ...(parsed.data.discountMinor !== undefined ? { p_discount_minor: parsed.data.discountMinor } : {}),
    ...(parsed.data.taxMinor !== undefined ? { p_tax_minor: parsed.data.taxMinor } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProposalPricing', detail: error.message }));
    return err('INTERNAL', 'Could not price the quotation.');
  }

  const row = single<PricingRow>(data);
  if (!row) return err('INTERNAL', 'Could not price the quotation.');

  switch (row.outcome) {
    case 'priced':
      return ok({
        subtotalMinor: row.subtotal_minor ?? 0,
        discountMinor: row.discount_minor ?? 0,
        taxMinor: row.tax_minor ?? 0,
        totalMinor: row.total_minor ?? 0,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    case 'not_draft':
      return err(
        'CONFLICT',
        'This version is no longer a draft. Draft the next version to change its price.',
      );

    case 'discount_exceeds_subtotal':
      return err('VALIDATION', 'The discount is larger than the work it applies to.', {
        details: { discountMinor: ['A discount cannot exceed the subtotal.'] },
      });

    default:
      return err('INTERNAL', 'Could not price the quotation.');
  }
}

type SubmitRow = {
  outcome:
    | 'submitted'
    | 'already_pending'
    | 'not_found'
    | 'not_draft'
    | 'no_items'
    | 'no_amount'
    | 'no_policy';
  request_id: string | null;
  status: ProposalStatus | null;
};

/**
 * Puts a quotation in front of the owner (ADM-07).
 *
 * The amount travels with the request, so `approval_policies.min_amount_minor`
 * resolves the approver — §17's "high-value project → approval threshold if
 * configured", which is the whole reason the ladder exists.
 */
export async function submitProposal(
  input: SubmitProposalInput,
): Promise<Result<{ requestId: string; alreadyPending: boolean }>> {
  const parsed = submitProposalSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid submission.');

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to submit quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('submit_proposal', {
    p_proposal_id: parsed.data.proposalId,
    p_requested_by: context.userId,
    ...(parsed.data.summary ? { p_summary: parsed.data.summary } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'submitProposal', detail: error.message }));
    return err('INTERNAL', 'Could not submit the quotation.');
  }

  const row = single<SubmitRow>(data);
  if (!row) return err('INTERNAL', 'Could not submit the quotation.');

  switch (row.outcome) {
    case 'submitted':
    case 'already_pending':
      if (!row.request_id) return err('INTERNAL', 'Could not submit the quotation.');
      return ok({ requestId: row.request_id, alreadyPending: row.outcome === 'already_pending' });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    case 'not_draft':
      return err('CONFLICT', `This quotation is ${row.status ?? 'not a draft'}.`);

    case 'no_items':
      return err('VALIDATION', 'A quotation with no lines is not a quotation.');

    case 'no_amount':
      return err('VALIDATION', 'A quotation needs an amount before anybody can approve it.');

    // Not a default-open, and the same answer submitting a deliverable gives:
    // with no policy there is nobody named to approve, so the quote would sit
    // in a queue that rots.
    case 'no_policy':
      return err(
        'CONFLICT',
        'No approval policy covers quotations. An owner sets one before this can be approved.',
      );

    default:
      return err('INTERNAL', 'Could not submit the quotation.');
  }
}

/** Bring the owner's decision back onto the quotation after it is settled. */
export async function syncProposalDecision(
  proposalId: string,
): Promise<Result<{ status: string }>> {
  await requireInternal();

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .rpc('sync_proposal_decision', { p_proposal_id: proposalId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'syncProposalDecision', detail: error.message }));
    return err('INTERNAL', 'Could not read the decision.');
  }

  return ok({ status: String(data) });
}

type SendRow = {
  outcome: 'sent' | 'not_found' | 'not_approved' | 'already_sent';
  status: ProposalStatus | null;
  sent_at: string | null;
};

/**
 * Delivers an approved quotation to the client (§18).
 *
 * The gate is ADM-07's, and it is in Postgres under the row's lock: anything
 * the owner has not approved is refused here, not merely hidden in the UI.
 */
export async function sendProposal(
  input: SendProposalInput,
): Promise<Result<{ sentAt: string; alreadySent: boolean }>> {
  const parsed = sendProposalSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid send request.');

  const context = await requireInternal();
  if (!can(context.role, 'proposal.send')) {
    return err('FORBIDDEN', 'You do not have permission to send quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('send_proposal', {
    p_proposal_id: parsed.data.proposalId,
    ...(parsed.data.conversationId ? { p_conversation_id: parsed.data.conversationId } : {}),
    ...(parsed.data.messageRef ? { p_message_ref: parsed.data.messageRef } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendProposal', detail: error.message }));
    return err('INTERNAL', 'Could not send the quotation.');
  }

  const row = single<SendRow>(data);
  if (!row) return err('INTERNAL', 'Could not send the quotation.');

  switch (row.outcome) {
    case 'sent':
    case 'already_sent':
      if (!row.sent_at) return err('INTERNAL', 'Could not send the quotation.');
      return ok({ sentAt: row.sent_at, alreadySent: row.outcome === 'already_sent' });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    case 'not_approved':
      return err(
        'CONFLICT',
        row.status === 'pending_approval'
          ? 'The owner has not answered this quotation yet.'
          : 'A quotation reaches a client only after the owner approves it.',
      );

    default:
      return err('INTERNAL', 'Could not send the quotation.');
  }
}

type ResponseRow = {
  outcome: 'recorded' | 'not_found' | 'not_sent' | 'expired' | 'invalid_response';
  status: ProposalStatus | null;
  decided_at: string | null;
};

/**
 * Records what the client said about a quotation that was actually sent.
 *
 * §18: *"Do not mark accepted simply because quote was delivered."* Acceptance
 * is its own act, and the database will only take it from `sent`.
 *
 * Gated on `proposal.send` rather than a capability of its own: it is the same
 * role set, and finance's rule — a capability mapping to a role set that
 * already exists adds vocabulary without adding control — argues for reuse.
 * The quote's outward lifecycle is one job.
 */
export async function recordProposalResponse(
  input: RecordProposalResponseInput,
): Promise<Result<{ status: ProposalStatus; decidedAt: string }>> {
  const parsed = recordProposalResponseSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid response.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.send')) {
    return err('FORBIDDEN', 'You do not have permission to record quotation responses.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('record_proposal_response', {
    p_proposal_id: parsed.data.proposalId,
    p_response: parsed.data.response,
    ...(parsed.data.contactId ? { p_contact_id: parsed.data.contactId } : {}),
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordProposalResponse', detail: error.message }));
    return err('INTERNAL', 'Could not record the response.');
  }

  const row = single<ResponseRow>(data);
  if (!row) return err('INTERNAL', 'Could not record the response.');

  switch (row.outcome) {
    case 'recorded':
      if (!row.status || !row.decided_at) return err('INTERNAL', 'Could not record the response.');
      return ok({ status: row.status, decidedAt: row.decided_at });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    case 'not_sent':
      return err(
        'CONFLICT',
        row.status === 'sent'
          ? 'This quotation was already answered.'
          : 'A client can only answer a quotation that was actually sent to them.',
      );

    case 'expired':
      return err(
        'CONFLICT',
        'This quotation is past its validity date. Draft the next version to re-offer it.',
      );

    case 'invalid_response':
      return err('VALIDATION', 'A client either accepts or rejects.');

    default:
      return err('INTERNAL', 'Could not record the response.');
  }
}
