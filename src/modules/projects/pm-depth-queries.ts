import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * PM5/PM6 depth for the Admin: the review shares made for the client, the revision rounds and the allowance, and escalations waiting for a
 * decision. Stored state is read as stored; the allowance and the timeline come from the database functions that derive them, never
 * recomputed here. A failed read is `unreadable` (G-054), never an empty section.
 */

export type ClientBuildShareRow = {
  id: string;
  deliverableId: string;
  version: number | null;
  commitRef: string;
  reviewPlatform: string;
  reviewUrl: string;
  deliveryState: string;
  deliveryNote: string | null;
  sharedAt: string;
};

export type RevisionRound = {
  revisionId: string;
  roundNumber: number;
  origin: string;
  fromVersion: number;
  toVersion: number;
  consumesAllowance: boolean;
  qaStatus: string | null;
  adminStatus: string | null;
  reason: string;
  createdAt: string;
};

export type RevisionAllowance = { roundsUsed: number; roundLimit: number; remaining: number; exceeded: boolean } | null;

export type RevisionEscalationRow = { id: string; roundsUsed: number; roundLimit: number; requestedReason: string; createdAt: string };

export type PmDepth = {
  shares: ClientBuildShareRow[];
  rounds: RevisionRound[];
  allowance: RevisionAllowance;
  openEscalations: RevisionEscalationRow[];
  builds: { id: string; version: number; title: string }[];
};

export async function readPmDepth(projectId: string): Promise<PmDepth> {
  const supabase = await createClient();

  const { data: shareRows, error: shareError } = await supabase
    .schema('projects')
    .from('client_build_shares' as never)
    .select('id, deliverable_id, commit_ref, review_platform, review_url, delivery_state, delivery_note, shared_at')
    .eq('project_id' as never, projectId as never)
    .order('shared_at' as never, { ascending: false })
    .limit(50);
  if (shareError) unreadable('readPmDepth.shares', shareError);

  const { data: buildRows, error: buildError } = await supabase
    .schema('projects')
    .from('deliverables')
    .select('id, version, title')
    .eq('project_id', projectId)
    .eq('kind', 'build')
    .order('version', { ascending: false })
    .limit(50);
  if (buildError) unreadable('readPmDepth.builds', buildError);
  const builds = (buildRows ?? []) as unknown as { id: string; version: number; title: string }[];
  const versionOf = new Map(builds.map((b) => [b.id, b.version]));

  const { data: timeline, error: timelineError } = await supabase.schema('projects').rpc('build_revision_timeline' as never, { p_project_id: projectId } as never);
  if (timelineError) unreadable('readPmDepth.timeline', timelineError);

  const { data: allowance, error: allowanceError } = await supabase.schema('projects').rpc('build_revision_allowance' as never, { p_project_id: projectId } as never);
  if (allowanceError) unreadable('readPmDepth.allowance', allowanceError);

  const { data: escalations, error: escalationError } = await supabase
    .schema('projects')
    .from('build_revision_escalations' as never)
    .select('id, rounds_used, round_limit, requested_reason, created_at')
    .eq('project_id' as never, projectId as never)
    .eq('status' as never, 'open' as never)
    .order('created_at' as never, { ascending: true })
    .limit(20);
  if (escalationError) unreadable('readPmDepth.escalations', escalationError);

  const shares = (
    (shareRows ?? []) as unknown as {
      id: string;
      deliverable_id: string;
      commit_ref: string;
      review_platform: string;
      review_url: string;
      delivery_state: string;
      delivery_note: string | null;
      shared_at: string;
    }[]
  ).map((r) => ({
    id: r.id,
    deliverableId: r.deliverable_id,
    version: versionOf.get(r.deliverable_id) ?? null,
    commitRef: r.commit_ref,
    reviewPlatform: r.review_platform,
    reviewUrl: r.review_url,
    deliveryState: r.delivery_state,
    deliveryNote: r.delivery_note,
    sharedAt: r.shared_at,
  }));
  const rounds = (
    (timeline ?? []) as unknown as {
      revision_id: string;
      round_number: number;
      origin: string;
      from_version: number;
      to_version: number;
      consumes_allowance: boolean;
      qa_status: string | null;
      admin_status: string | null;
      reason: string;
      created_at: string;
    }[]
  ).map((r) => ({
    revisionId: r.revision_id,
    roundNumber: r.round_number,
    origin: r.origin,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    consumesAllowance: r.consumes_allowance,
    qaStatus: r.qa_status,
    adminStatus: r.admin_status,
    reason: r.reason,
    createdAt: r.created_at,
  }));
  const a = (Array.isArray(allowance) ? allowance[0] : allowance) as { rounds_used: number; round_limit: number; remaining: number; exceeded: boolean } | undefined;
  const openEscalations = (
    (escalations ?? []) as unknown as { id: string; rounds_used: number; round_limit: number; requested_reason: string; created_at: string }[]
  ).map((e) => ({ id: e.id, roundsUsed: e.rounds_used, roundLimit: e.round_limit, requestedReason: e.requested_reason, createdAt: e.created_at }));
  return {
    shares,
    rounds,
    builds,
    allowance: a ? { roundsUsed: a.rounds_used, roundLimit: a.round_limit, remaining: a.remaining, exceeded: a.exceeded } : null,
    openEscalations,
  };
}
