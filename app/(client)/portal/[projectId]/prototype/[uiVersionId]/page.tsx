import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireClient } from '@/lib/auth/session';
import { IconArrowLeft } from '@/ui';
import { readClientProject, readClientPrototypeArtifact, readClientPrototypeNotice } from '@/modules/portal/queries';
import { PrototypeScreenView } from '@/ui/prototype-screen-view';

export const metadata: Metadata = { title: 'Prototype' };

/**
 * A prototype build, as its client sees it — the gap 3 of the 6 Phase 4 spec
 * audits flagged as the single most-cited remaining piece.
 *
 * `prototype_artifacts_select` (`20260923150000`) already admits a client
 * scoped to their own project's non-draft prototype deliverable; only this
 * page and `readClientPrototypeArtifact` were missing. QA findings (missing
 * screens, broken routes, secret-scan results) stay internal — this page
 * never reads or shows them, the same restraint the project page keeps by
 * never showing an approval action (ADM-08d: a client agrees over WhatsApp,
 * a staff member records it).
 *
 * `notFound()` on any RLS-miss, matching `PortalProjectPage`'s own reasoning:
 * to this session, a project or artifact RLS does not return does not exist.
 */
export default async function ClientPrototypePreviewPage({
  params,
}: {
  params: Promise<{ projectId: string; uiVersionId: string }>;
}) {
  await requireClient();
  const { projectId, uiVersionId } = await params;

  const project = await readClientProject(projectId);
  if (!project) notFound();

  const artifact = await readClientPrototypeArtifact(uiVersionId);
  if (!artifact || artifact.projectId !== projectId) notFound();

  // P4-PROTO-013/052: what this build is and is not, in the words the database keeps (null: nothing to show).
  const notice = await readClientPrototypeNotice(artifact.deliverableId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link
          href={`/portal/${projectId}`}
          className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground"
        >
          <IconArrowLeft size={14} />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Prototype</h1>
        <p className="text-sm text-muted">
          A review prototype, not the finished product — mock data throughout. Tell your project contact
          what you think; they will record your decision against this exact build.
        </p>
      </div>

      {notice ? (
        <section aria-label="About this prototype" className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
          <p className="font-medium">{notice.label}</p>
          {notice.limitations.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Known limitations</p>
              <ul className="list-disc pl-5 text-muted">
                {notice.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {notice.simulated.length > 0 ? (
            <p className="text-muted">Simulated in this preview: {notice.simulated.join(', ')}.</p>
          ) : null}
        </section>
      ) : null}

      {artifact.screens.length > 0 ? (
        <PrototypeScreenView screens={artifact.screens} />
      ) : (
        <p className="text-sm text-muted">This build has no screens.</p>
      )}
    </div>
  );
}
