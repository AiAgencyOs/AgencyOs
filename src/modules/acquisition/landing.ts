import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';

import { judgeFetchedPage, renderLandingHtml, sha256Hex, type LandingContent } from './landing-render';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The landing page engine's worker side (20261021100000). Approval, versioning and the one-execution rule live in the database; this
 * is the code that goes through them. A host is only reached after `crm.begin_landing_deploy` says `proceed`, the page is rendered
 * from the immutable version row, and DEPLOYED is never reported as VERIFIED: that is a separate record of what was fetched from
 * the public address.
 */

export type DeployInput = { slug: string; publicUrl: string; html: string; htmlHash: string; signal: AbortSignal };
export type DeployResult =
  | { status: 'deployed'; deployedUrl: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string };
export type LandingDeployer = { deploy(input: DeployInput): Promise<DeployResult> };

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const row = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

type VersionRow = { id: string; content: unknown; whatsapp_number: string; public_url: string; content_hash: string; page_id: string };

async function readVersion(admin: Admin, organizationId: string, versionId: string): Promise<{ v: VersionRow; slug: string } | null> {
  const { data: v } = await admin.schema('crm').from('landing_page_versions').select('id, content, whatsapp_number, public_url, content_hash, page_id').eq('id', versionId).eq('organization_id', organizationId).maybeSingle();
  if (!v) return null;
  const { data: p } = await admin.schema('crm').from('landing_pages').select('slug').eq('id', v.page_id).maybeSingle();
  return p ? { v: v as VersionRow, slug: p.slug } : null;
}

/** The pages proof items link to are the agency's own portfolio items, read at render time. */
async function proofLinks(admin: Admin, organizationId: string, content: LandingContent): Promise<Record<string, { title: string; url: string }>> {
  const ids = (content.proof ?? []).map((p) => p.portfolio_item_id);
  if (ids.length === 0) return {};
  const { data } = await admin.schema('crm').from('portfolio_items').select('id, title, url').eq('organization_id', organizationId).eq('is_active', true).in('id', ids);
  return Object.fromEntries((data ?? []).map((i) => [i.id, { title: i.title, url: i.url }]));
}

export function renderVersion(version: VersionRow, links: Record<string, { title: string; url: string }>): { html: string; htmlHash: string } {
  const html = renderLandingHtml({ versionId: version.id, contentHash: version.content_hash, whatsappNumber: version.whatsapp_number, content: version.content as LandingContent, proofLinks: links });
  return { html, htmlHash: sha256Hex(html) };
}

export type DeployOutcome =
  | { outcome: 'deployed'; verified: boolean }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'unknown'; reason: string }
  | { outcome: 'not_proceeding'; reason: string; why: string };

/** Fetch the public address and record what was found. Never throws: a fetch that fails is a failed check, recorded as such. */
export async function verifyLandingVersion(admin: Admin, input: { organizationId: string; versionId: string; fetcher?: Fetcher; timeoutMs?: number }): Promise<'verified' | 'failed' | 'not_recorded'> {
  const found = await readVersion(admin, input.organizationId, input.versionId);
  if (!found) return 'not_recorded';
  const fetcher: Fetcher = input.fetcher ?? ((url, init) => fetch(url, { signal: init.signal, redirect: 'follow' }));
  let status = 0;
  let body = '';
  try {
    const res = await fetcher(found.v.public_url, { signal: AbortSignal.timeout(input.timeoutMs ?? 20_000) });
    status = res.status;
    body = await res.text();
  } catch {
    // Unreachable: status stays 0 and the body empty, so every check below fails honestly.
  }
  const checks = judgeFetchedPage({ status, body, contentHash: found.v.content_hash, whatsappNumber: found.v.whatsapp_number, versionId: found.v.id });
  const { data, error } = await admin.schema('crm').rpc('record_landing_verification', { p_organization_id: input.organizationId, p_version: input.versionId, p_checks: checks as unknown as Json });
  if (error) return 'not_recorded';
  const outcome = row<{ outcome?: string }>(data)?.outcome;
  return outcome === 'verified' ? 'verified' : outcome === 'failed' ? 'failed' : 'not_recorded';
}

/**
 * Deploy ONE approved version, if and only if the governed door lets it proceed, then check what is actually at the address. A host
 * that throws is `unknown` (the page may be up): reconciled, never redeployed blindly.
 */
export async function deployLandingVersion(
  admin: Admin,
  input: { organizationId: string; versionId: string; deployer: LandingDeployer; fetcher?: Fetcher; correlationId?: string; timeoutMs?: number },
): Promise<DeployOutcome> {
  const { data: begun, error } = await admin.schema('crm').rpc('begin_landing_deploy', { p_organization_id: input.organizationId, p_version: input.versionId, p_correlation_id: input.correlationId });
  if (error) throw new Error(`begin_landing_deploy failed: ${error.message}`);
  const b = row<{ outcome?: string; reason?: string | null; execution_id?: string | null }>(begun);
  if (b?.outcome !== 'proceed' || !b.execution_id) return { outcome: 'not_proceeding', reason: b?.outcome ?? 'no_answer', why: b?.reason ?? '' };
  const executionId = b.execution_id;

  const found = await readVersion(admin, input.organizationId, input.versionId);
  if (!found) {
    await record(admin, input, executionId, 'unknown', '', '0'.repeat(64), { error: 'could not read the approved version' });
    return { outcome: 'unknown', reason: 'could not read the approved version' };
  }
  const links = await proofLinks(admin, input.organizationId, found.v.content as LandingContent);
  const { html, htmlHash } = renderVersion(found.v, links);

  let result: DeployResult;
  try {
    result = await input.deployer.deploy({ slug: found.slug, publicUrl: found.v.public_url, html, htmlHash, signal: AbortSignal.timeout(input.timeoutMs ?? 60_000) });
  } catch {
    result = { status: 'unknown', reason: 'the host did not return a result' };
  }

  if (result.status === 'deployed') {
    const recorded = await record(admin, input, executionId, 'executed', result.deployedUrl, htmlHash, {});
    if (recorded !== 'recorded') return { outcome: 'unknown', reason: `the page is up but could not be recorded (${recorded})` };
    const verdict = await verifyLandingVersion(admin, { organizationId: input.organizationId, versionId: input.versionId, fetcher: input.fetcher });
    return { outcome: 'deployed', verified: verdict === 'verified' };
  }
  if (result.status === 'rejected') {
    await record(admin, input, executionId, 'failed', '', htmlHash, { reason: result.reason });
    return { outcome: 'failed', reason: result.reason };
  }
  await record(admin, input, executionId, 'unknown', '', htmlHash, { reason: result.reason });
  return { outcome: 'unknown', reason: result.reason };
}

async function record(admin: Admin, input: { organizationId: string; versionId: string }, executionId: string, status: 'executed' | 'failed' | 'unknown', url: string, htmlHash: string, evidence: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('record_landing_deploy', {
    p_organization_id: input.organizationId, p_version: input.versionId, p_execution: executionId, p_status: status,
    p_deployed_url: url, p_html_hash: htmlHash, p_evidence: evidence as unknown as Json,
  });
  if (error) throw new Error(`record_landing_deploy failed: ${error.message}`);
  return row<{ outcome?: string }>(data)?.outcome ?? 'invalid';
}

export type LandingSweep = { approvalsClosed: number; deployed: number; failed: number; unknown: number; assisted: number; reverified: number };

/**
 * The cron sweep: closes lapsed approvals, deploys what is approved through whatever deployer exists (or TELLS A PERSON there is
 * none), and re-checks pages that were deployed but are not VERIFIED. Bounded per tick.
 */
export async function runLandingOperations(admin: Admin, deployer: LandingDeployer | undefined, fetcher?: Fetcher): Promise<LandingSweep> {
  const sweep: LandingSweep = { approvalsClosed: 0, deployed: 0, failed: 0, unknown: 0, assisted: 0, reverified: 0 };
  try {
    const closed = await admin.schema('crm').rpc('sync_landing_approvals', { p_limit: 200 });
    sweep.approvalsClosed = typeof closed.data === 'number' ? closed.data : 0;

    const { data: waiting } = await admin.schema('crm').from('landing_page_versions')
      .select('id, organization_id, page_id, approval_request_id').in('state', ['ADMIN_REVIEW', 'DEPLOYING']).not('approval_request_id', 'is', null).order('state_changed_at').limit(25);
    for (const w of waiting ?? []) {
      const { data: req } = await admin.schema('approvals').from('approval_requests').select('state').eq('id', w.approval_request_id ?? '').maybeSingle();
      if (req?.state !== 'approved') continue;
      if (!deployer) {
        sweep.assisted += 1;
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: w.organization_id, p_source: 'landing_pages', p_severity: 'warning',
          p_summary: 'An approved landing page cannot be deployed automatically yet (no Hostinger deployer is built): upload exactly the approved page by hand, then re-check it here.',
          p_fingerprint: `landing-assisted:${w.id}`,
        });
        continue;
      }
      const r = await deployLandingVersion(admin, { organizationId: w.organization_id, versionId: w.id, deployer, fetcher });
      if (r.outcome === 'deployed') sweep.deployed += 1;
      else if (r.outcome === 'failed') sweep.failed += 1;
      else if (r.outcome === 'unknown') sweep.unknown += 1;
      else if (r.reason === 'needs_reconciliation') {
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: w.organization_id, p_source: 'landing_pages', p_severity: 'critical',
          p_summary: 'A landing page deploy may have gone through but its result is unknown. Check the host before doing anything: AgencyOS will not deploy it again.',
          p_fingerprint: `landing-reconcile:${w.id}`,
        });
      }
    }

    const { data: unverified } = await admin.schema('crm').from('landing_page_versions').select('id, organization_id').in('state', ['DEPLOYED', 'VERIFY_FAILED']).order('state_changed_at').limit(25);
    for (const u of unverified ?? []) {
      await verifyLandingVersion(admin, { organizationId: u.organization_id, versionId: u.id, fetcher });
      sweep.reverified += 1;
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'runLandingOperations', detail: e instanceof Error ? e.message : 'unknown' }));
  }
  return sweep;
}
