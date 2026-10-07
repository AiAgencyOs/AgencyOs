import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireClient } from '@/lib/auth/session';
import { readClientProject } from '@/modules/portal/queries';
import { readClientReviewBuilds } from '@/modules/portal/review-build-queries';
import { IconArrowLeft } from '@/ui';

export const metadata: Metadata = { title: 'Builds to test' };

/**
 * The development builds your project contact has sent you to test. Each is labelled as a review build, not the finished product. There is no
 * approve button here, by design (ADM-08d): tell your project contact what you found and they record it against the exact build.
 */
export default async function PortalReviewBuildsPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requireClient();
  const clock = await agencyClock();
  const { projectId } = await params;
  const project = await readClientProject(projectId);
  if (!project) notFound();
  const builds = await readClientReviewBuilds(projectId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={`/portal/${projectId}`} className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
          <IconArrowLeft size={14} />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Builds to test</h1>
        <p className="text-sm text-muted">
          Review builds, not the finished product. Tell your project contact what you find; they will record it against the exact build.
        </p>
      </div>
      {builds.length === 0 ? (
        <p className="text-sm text-muted">Nothing has been sent to you to test yet.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {builds.map((b) => (
            <li key={`${b.buildVersion}-${b.sharedAt}`} className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[15px] font-medium">Build {b.buildVersion}</h2>
                <span className="text-[12px] text-muted">{clock.date(b.sharedAt)}</span>
              </div>
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{b.label}</p>
              <p className="text-sm">Test it on: {b.reviewPlatform}</p>
              <a href={b.reviewUrl} className="w-fit text-sm underline" rel="noreferrer noopener" target="_blank">
                Open the build
              </a>
              <p className="whitespace-pre-wrap text-sm">{b.testingInstructions}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
