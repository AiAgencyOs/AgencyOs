import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireClient } from '@/lib/auth/session';
import { IconArrowLeft, StatusBadge } from '@/ui';
import { readClientProject } from '@/modules/portal/queries';

export const metadata: Metadata = { title: 'Project' };

/**
 * One project, as its client sees it — gap G-057.
 *
 * Three things are shown and one is deliberately absent.
 *
 * Shown: the pieces the project is built from and how far along each is; every
 * version put in front of them, with its changelog, its known issues and how
 * to get into it; and the handover once it has been delivered.
 *
 * Absent: any way to approve. ADM-08d decided that a client agrees over
 * WhatsApp and a staff member records that decision with the message as
 * evidence — so a button here would either be a lie about who decided, or a
 * second decision path the audit trail cannot reconcile with the first. The
 * page says who to tell instead, which is what actually happens.
 *
 * `notFound()` rather than a message: to this session, a project that RLS does
 * not return does not exist, and saying "you may not see this" would confirm
 * that it does.
 */
export default async function PortalProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requireClient();
  const clock = await agencyClock();
  const { projectId } = await params;

  const project = await readClientProject(projectId);
  if (!project) notFound();

  const inReview = project.deliverables.filter((d) => d.status === 'in_review');

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link
          href="/portal"
          className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground"
        >
          <IconArrowLeft size={14} />
          Your projects
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{project.name}</h1>
        <div className="mt-1">
          <StatusBadge status={project.status} />
        </div>
      </div>

      {inReview.length > 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          {inReview.length === 1 ? 'One version is' : `${inReview.length} versions are`} waiting on your
          feedback. Tell your project contact what you think — they will record your decision against the
          exact version below.
        </p>
      ) : null}

      {project.modules.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Progress</h2>
          <ul className="flex flex-col gap-1">
            {project.modules.map((m) => (
              <li
                key={m.id}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-2 text-sm"
              >
                <span>{m.name}</span>
                <span className="text-xs text-muted">{m.status.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Shared with you</h2>

        {project.deliverables.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been shared on this project yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {project.deliverables.map((d) => (
              <li key={d.id} className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {d.kind} v{d.version} — {d.title}
                  </span>
                  <span className="text-xs text-muted">
                    {d.status.replace('_', ' ')} · {clock.date(d.created_at)}
                  </span>
                </div>

                {d.changelog ? <p className="mt-1 text-muted">{d.changelog}</p> : null}

                {d.artifact_url ? (
                  <a
                    href={d.artifact_url}
                    className="mt-1 inline-block break-all text-xs underline"
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    Open it
                  </a>
                ) : null}

                {d.test_access_method ? (
                  <p className="mt-1 text-xs text-muted">Getting in: {d.test_access_method}</p>
                ) : null}

                {/*
                  Known issues travel with the version rather than being
                  discovered by the client — directive §17. Saying what is
                  wrong before they find it is the difference between a
                  limitation and a nasty surprise.
                */}
                {d.known_issues ? (
                  <p className="mt-1 text-xs text-muted">Known limitations: {d.known_issues}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {project.handover ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Handover</h2>
          <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
            <p>{project.handover.summary ?? 'Final delivery'}</p>
            <p className="mt-1 text-xs text-muted">
              {project.handover.accepted_at
                ? `Accepted ${clock.date(project.handover.accepted_at)}`
                : project.handover.delivered_at
                  ? `Delivered ${clock.date(project.handover.delivered_at)} — your team will confirm you have everything`
                  : project.handover.status}
            </p>
          </div>
        </section>
      ) : null}
    </div>
  );
}
