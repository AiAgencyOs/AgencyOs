import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { attachBuiltPrototype, syncBuildForDeliverable, type P4uiAdmin, type P4uiOutcome } from './p4ui';
import type { HandlerResult, UnlockJob } from './handlers';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Deterministic (no model) reactions for the Phase 4 Prototype record, in the shape the other event handlers use. NOT YET WIRED: the parent registers them in
 * src/lib/events/catalog.ts HANDLERS and subscribes them (docs/phase-4-ui-prototype-gaps-log.md, "Wiring"):
 *
 *   project.prototype_build_ready              -> projects:attachP4uiBuild   handleP4uiAttachBuild  (the artifact is attached, self-checked, handed to QA)
 *   project.prototype_qa_reviewed,
 *   project.prototype_admin_decided,
 *   project.deliverable_submitted,
 *   project.deliverable_decided                -> projects:syncP4uiBuild     handleP4uiSyncBuild    (the build reflects the real gate; it never decides one)
 */
function result(outcome: P4uiOutcome): HandlerResult {
  if (outcome.status === 'failed') return { status: 'failed', permanent: false, detail: outcome.reason };
  if (outcome.status === 'skipped') return { status: 'succeeded', outcome: 'nothing_to_do', detail: outcome.reason };
  return { status: 'succeeded', outcome: 'done', detail: outcome.detail };
}

export async function handleP4uiAttachBuild(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const subjectId = job.payload?.subjectId;
  if (typeof subjectId !== 'string') return { status: 'failed', permanent: true, detail: 'the event names no prototype artifact' };
  return result(await attachBuiltPrototype(admin as unknown as P4uiAdmin, { organizationId: job.organization_id, prototypeArtifactId: subjectId }));
}

export async function handleP4uiSyncBuild(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const subjectId = job.payload?.subjectId;
  if (typeof subjectId !== 'string') return { status: 'failed', permanent: true, detail: 'the event names no subject' };
  const loose = admin as unknown as P4uiAdmin;
  if (job.payload?.eventType === 'project.prototype_qa_reviewed') {
    // the subject is the prototype artifact: resolve its deliverable first
    const { data, error } = await loose
      .schema('projects')
      .from('prototype_artifacts')
      .select('deliverable_id')
      .eq('id', subjectId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (error) return { status: 'failed', permanent: false, detail: `could not read the artifact: ${error.message}` };
    if (!data) return { status: 'succeeded', outcome: 'nothing_to_do', detail: 'the artifact no longer exists' };
    return result(await syncBuildForDeliverable(loose, { organizationId: job.organization_id, deliverableId: String(data.deliverable_id) }));
  }
  return result(await syncBuildForDeliverable(loose, { organizationId: job.organization_id, deliverableId: subjectId }));
}
