import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import type { B2bPlatform } from './b2b-vocabulary';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The B2B engine's worker side (20261022100000). Approval, versioning and the one-execution rule live in the database. Almost every
 * marketplace forbids automation, so the default - and the only thing that exists - is ASSISTED: this sweep closes lapsed approvals
 * and TELLS A PERSON that an approved proposal is waiting for them to send it on the platform and record it. A connector, when one is
 * built for a platform the owner has marked automated, is the only thing that may call `begin_b2b_submit`.
 */

export type ProposalSendInput = {
  platform: B2bPlatform;
  versionId: string;
  contentHash: string;
  externalRef: string;
  body: string;
  priceMinor: number;
  currency: string;
  timelineDays: number | null;
  connectsCost: number;
  signal: AbortSignal;
};
export type ProposalSendResult = { status: 'sent'; externalRef: string } | { status: 'rejected'; reason: string } | { status: 'unknown'; reason: string };
export type B2bConnector = { send(input: ProposalSendInput): Promise<ProposalSendResult> };

export type B2bSweep = { approvalsClosed: number; waitingForAPerson: number; sent: number };

const row = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

/** Send ONE approved proposal through a connector, if and only if the governed door lets the engine proceed. */
export async function sendB2bProposal(
  admin: Admin,
  input: { organizationId: string; versionId: string; connector: B2bConnector; timeoutMs?: number },
): Promise<{ outcome: 'sent' | 'failed' | 'unknown' | 'not_proceeding'; reason?: string }> {
  const { data: begun, error } = await admin.schema('crm').rpc('begin_b2b_submit', { p_organization_id: input.organizationId, p_version: input.versionId });
  if (error) throw new Error(`begin_b2b_submit failed: ${error.message}`);
  const b = row<{ outcome?: string; reason?: string | null; execution_id?: string | null }>(begun);
  if (b?.outcome !== 'proceed' || !b.execution_id) return { outcome: 'not_proceeding', reason: `${b?.outcome ?? 'no_answer'}${b?.reason ? `:${b.reason}` : ''}` };

  const { data: v } = await admin.schema('crm').from('b2b_proposal_versions').select('opportunity_id, body, price_minor, currency, timeline_days, connects_cost, content_hash')
    .eq('id', input.versionId).eq('organization_id', input.organizationId).maybeSingle();
  const { data: o } = v ? await admin.schema('crm').from('b2b_opportunities').select('platform, external_ref').eq('id', v.opportunity_id).maybeSingle() : { data: null };
  if (!v || !o || v.price_minor === null) {
    await record(admin, input, b.execution_id, 'unknown', '', { error: 'could not read the approved version' });
    return { outcome: 'unknown', reason: 'could not read the approved version' };
  }
  let result: ProposalSendResult;
  try {
    result = await input.connector.send({
      platform: o.platform as B2bPlatform, versionId: input.versionId, contentHash: v.content_hash, externalRef: o.external_ref, body: v.body,
      priceMinor: v.price_minor, currency: v.currency, timelineDays: v.timeline_days, connectsCost: v.connects_cost, signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    });
  } catch {
    result = { status: 'unknown', reason: 'the connector did not return a result' };
  }
  if (result.status === 'sent') {
    const recorded = await record(admin, input, b.execution_id, 'executed', result.externalRef, {});
    return recorded === 'recorded' ? { outcome: 'sent' } : { outcome: 'unknown', reason: `it was sent but could not be recorded (${recorded})` };
  }
  if (result.status === 'rejected') {
    await record(admin, input, b.execution_id, 'failed', '', { reason: result.reason });
    return { outcome: 'failed', reason: result.reason };
  }
  await record(admin, input, b.execution_id, 'unknown', '', { reason: result.reason });
  return { outcome: 'unknown', reason: result.reason };
}

async function record(admin: Admin, input: { organizationId: string; versionId: string }, executionId: string, status: 'executed' | 'failed' | 'unknown', externalRef: string, evidence: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('record_b2b_submit', {
    p_organization_id: input.organizationId, p_version: input.versionId, p_execution: executionId, p_status: status, p_external_ref: externalRef,
    p_evidence: evidence as never,
  });
  if (error) throw new Error(`record_b2b_submit failed: ${error.message}`);
  return row<{ outcome?: string }>(data)?.outcome ?? 'invalid';
}

/** The cron sweep. With no connector (today), an approved proposal raises one alert per version: it is waiting for a person. Bounded per tick. */
export async function runB2bOperations(admin: Admin, connectors: Partial<Record<B2bPlatform, B2bConnector>>): Promise<B2bSweep> {
  const sweep: B2bSweep = { approvalsClosed: 0, waitingForAPerson: 0, sent: 0 };
  try {
    const closed = await admin.schema('crm').rpc('sync_b2b_approvals', { p_limit: 200 });
    if (closed.error) throw new Error(`could not close lapsed approvals: ${closed.error.message}`);
    sweep.approvalsClosed = typeof closed.data === 'number' ? closed.data : 0;
    const { data: waiting, error: waitingError } = await admin.schema('crm').from('b2b_proposal_versions').select('id, organization_id, opportunity_id, approval_request_id').in('state', ['ADMIN_REVIEW', 'SUBMITTING']).not('approval_request_id', 'is', null).order('state_changed_at').limit(25);
    if (waitingError) throw new Error(`could not read waiting: ${waitingError.message}`);
    for (const w of waiting ?? []) {
      const { data: req, error: reqError } = await admin.schema('approvals').from('approval_requests').select('state').eq('id', w.approval_request_id ?? '').maybeSingle();
      if (reqError) throw new Error(`could not read req: ${reqError.message}`);
      if (req?.state !== 'approved') continue;
      const { data: o } = await admin.schema('crm').from('b2b_opportunities').select('platform, title').eq('id', w.opportunity_id).maybeSingle();
      const connector = o ? connectors[o.platform as B2bPlatform] : undefined;
      if (!connector || !o) {
        sweep.waitingForAPerson += 1;
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: w.organization_id, p_source: 'b2b_operations', p_severity: 'warning',
          p_summary: `An approved ${o?.platform ?? 'marketplace'} proposal ("${o?.title ?? 'a job'}") is waiting for a person to send it on the platform exactly as approved, then record it in AgencyOS.`,
          p_fingerprint: `b2b-waiting:${w.id}`,
        });
        continue;
      }
      const r = await sendB2bProposal(admin, { organizationId: w.organization_id, versionId: w.id, connector });
      if (r.outcome === 'sent') sweep.sent += 1;
      else if (r.outcome === 'unknown' || r.reason?.startsWith('needs_reconciliation')) {
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: w.organization_id, p_source: 'b2b_operations', p_severity: 'critical',
          p_summary: 'A marketplace proposal may have been sent but its result is unknown. Check the platform before doing anything: AgencyOS will not send it again.',
          p_fingerprint: `b2b-reconcile:${w.id}`,
        });
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'runB2bOperations', detail: e instanceof Error ? e.message : 'unknown' }));
  }
  return sweep;
}
