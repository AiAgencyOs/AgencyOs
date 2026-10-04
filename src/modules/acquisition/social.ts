import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';

import type { SocialPlatform } from './social-vocabulary';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The Social engine's publishing side (20261019100000). Approval, versioning and the one-execution rule live in the database; this
 * is the worker that goes through them. The only way it reaches a provider is after `crm.begin_content_publish` says `proceed`, and
 * what it posts is read from the immutable version row - so the words that go out are the words that were approved.
 */

export type PublishInput = {
  platform: SocialPlatform;
  versionId: string;
  contentHash: string;
  body: string;
  cta: string | null;
  hashtags: string[];
  /** Storage references of the version's assets, in a stable order. */
  assets: { id: string; kind: string; storageRef: string; contentHash: string }[];
  signal: AbortSignal;
};

/**
 * What a provider adapter reports. `rejected` means the provider refused and NOTHING was posted (safe to retry within limits);
 * `unknown` means the request may have been accepted - it is reconciled, never blindly repeated.
 */
export type PublishResult =
  | { status: 'published'; externalRef: string; url?: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string };

export type SocialPublisher = {
  publish(input: PublishInput): Promise<PublishResult>;
  /** Confirm a post exists on the platform. Optional; without it a post stays EXECUTED, not VERIFIED. */
  verify?(input: { platform: SocialPlatform; externalRef: string; signal: AbortSignal }): Promise<boolean>;
};

const row = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export type PublishOutcome =
  | { outcome: 'published'; verified: boolean; externalRef: string }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'unknown'; reason: string }
  | { outcome: 'not_proceeding'; reason: string; why: string };

/**
 * Publish ONE scheduled version, if and only if the governed door lets it proceed. Never throws for a provider problem: an exception
 * from the adapter is treated as `unknown` (we cannot know whether the post went out), which parks it for reconciliation instead of
 * risking a second post.
 */
export async function publishContent(
  admin: Admin,
  input: { organizationId: string; versionId: string; publisher: SocialPublisher; correlationId?: string; timeoutMs?: number },
): Promise<PublishOutcome> {
  const { data: begun, error } = await admin.schema('crm').rpc('begin_content_publish', {
    p_organization_id: input.organizationId, p_version: input.versionId, p_correlation_id: input.correlationId,
  });
  if (error) throw new Error(`begin_content_publish failed: ${error.message}`);
  const b = row<{ outcome?: string; reason?: string | null; execution_id?: string | null }>(begun);
  if (b?.outcome !== 'proceed' || !b.execution_id) {
    return { outcome: 'not_proceeding', reason: b?.outcome ?? 'no_answer', why: b?.reason ?? '' };
  }
  const executionId = b.execution_id;

  const { data: v, error: vError } = await admin.schema('crm').from('content_versions')
    .select('body, cta, hashtags, asset_ids, content_hash, item_id').eq('id', input.versionId).eq('organization_id', input.organizationId).maybeSingle();
  if (vError || !v) {
    await record(admin, input, executionId, 'unknown', null, null, { error: 'could not read the approved version' });
    return { outcome: 'unknown', reason: 'could not read the approved version' };
  }
  const { data: item } = await admin.schema('crm').from('content_items').select('platform').eq('id', v.item_id).maybeSingle();
  const { data: assets } = v.asset_ids.length > 0
    ? await admin.schema('crm').from('content_assets').select('id, kind, storage_ref, content_hash').in('id', v.asset_ids).order('id')
    : { data: [] as { id: string; kind: string; storage_ref: string; content_hash: string }[] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
  let result: PublishResult;
  try {
    result = await input.publisher.publish({
      platform: (item?.platform ?? 'linkedin') as SocialPlatform, versionId: input.versionId, contentHash: v.content_hash, body: v.body, cta: v.cta,
      hashtags: v.hashtags, assets: (assets ?? []).map((a) => ({ id: a.id, kind: a.kind, storageRef: a.storage_ref, contentHash: a.content_hash })), signal: controller.signal,
    });
  } catch {
    // The request may or may not have reached the platform. Never retry blindly.
    result = { status: 'unknown', reason: 'the publisher did not return a result' };
  } finally {
    clearTimeout(timer);
  }

  if (result.status === 'published') {
    const recorded = await record(admin, input, executionId, 'executed', result.externalRef, result.url ?? null, {});
    if (recorded !== 'recorded') return { outcome: 'unknown', reason: `the post is live but could not be recorded (${recorded})` };
    let verified = false;
    if (input.publisher.verify) {
      const vc = new AbortController();
      const vt = setTimeout(() => vc.abort(), 15_000);
      try {
        verified = await input.publisher.verify({ platform: (item?.platform ?? 'linkedin') as SocialPlatform, externalRef: result.externalRef, signal: vc.signal });
      } catch {
        verified = false;
      } finally {
        clearTimeout(vt);
      }
      if (verified) await admin.schema('crm').rpc('verify_governed_execution', { p_organization_id: input.organizationId, p_execution: executionId, p_evidence: { confirmed_by: 'platform_lookup' } as unknown as Json });
    }
    return { outcome: 'published', verified, externalRef: result.externalRef };
  }
  if (result.status === 'rejected') {
    await record(admin, input, executionId, 'failed', null, null, { reason: result.reason });
    return { outcome: 'failed', reason: result.reason };
  }
  await record(admin, input, executionId, 'unknown', null, null, { reason: result.reason });
  return { outcome: 'unknown', reason: result.reason };
}

async function record(admin: Admin, input: { organizationId: string; versionId: string }, executionId: string, status: 'executed' | 'failed' | 'unknown', externalRef: string | null, url: string | null, evidence: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('record_publish', {
    p_organization_id: input.organizationId, p_version: input.versionId, p_execution: executionId, p_status: status,
    p_external_ref: (externalRef ?? '') as string, p_url: url as never, p_evidence: evidence as unknown as Json,
  });
  if (error) throw new Error(`record_publish failed: ${error.message}`);
  return row<{ outcome?: string }>(data)?.outcome ?? 'invalid';
}

export type PublishSweep = { due: number; published: number; failed: number; unknown: number; assisted: number; skipped: number };

/**
 * The cron sweep: publish what is due through whatever publisher exists, and TELL A PERSON about what cannot be published
 * automatically (no publisher for the platform: ASSISTED_ACTION_REQUIRED) or is stuck (an unknown outcome needing reconciliation).
 * Also moves rejected or lapsed approvals out of the review queue. Bounded per tick.
 */
export async function runSocialPublishing(admin: Admin, publishers: Partial<Record<SocialPlatform, SocialPublisher>>): Promise<PublishSweep> {
  const sweep: PublishSweep = { due: 0, published: 0, failed: 0, unknown: 0, assisted: 0, skipped: 0 };
  try {
    await admin.schema('crm').rpc('sync_content_approvals', { p_limit: 200 });
    const { data, error } = await admin.schema('crm').rpc('due_content', { p_limit: 25 });
    if (error) throw new Error(error.message);
    for (const d of (data ?? []) as { organization_id: string | null; version_id: string | null; platform: string | null }[]) {
      if (!d.organization_id || !d.version_id || !d.platform) continue;
      sweep.due += 1;
      const publisher = publishers[d.platform as SocialPlatform];
      if (!publisher) {
        sweep.assisted += 1;
        await admin.schema('core').rpc('raise_alert', {
          p_organization_id: d.organization_id, p_source: 'social_publishing', p_severity: 'warning',
          p_summary: `A scheduled ${d.platform} post is due and AgencyOS cannot publish to ${d.platform} yet: it needs to be posted by hand, then recorded.`,
          p_fingerprint: `social-assisted:${d.version_id}`,
        });
        continue;
      }
      const r = await publishContent(admin, { organizationId: d.organization_id, versionId: d.version_id, publisher });
      if (r.outcome === 'published') sweep.published += 1;
      else if (r.outcome === 'failed') sweep.failed += 1;
      else if (r.outcome === 'unknown') sweep.unknown += 1;
      else {
        sweep.skipped += 1;
        if (r.reason === 'needs_reconciliation') {
          await admin.schema('core').rpc('raise_alert', {
            p_organization_id: d.organization_id, p_source: 'social_publishing', p_severity: 'critical',
            p_summary: `A ${d.platform} post may have been published but its result is unknown. Check the platform before doing anything: AgencyOS will not post it again.`,
            p_fingerprint: `social-reconcile:${d.version_id}`,
          });
        }
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'runSocialPublishing', detail: e instanceof Error ? e.message : 'unknown' }));
  }
  return sweep;
}
