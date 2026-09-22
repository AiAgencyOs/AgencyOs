import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, readDesignMessages, readDesignTrail } from '@/modules/projects/queries';
import { Badge, PageHeader } from '@/ui';

import { ProjectSubNav } from '../../project-subnav';
import { DesignSubNav } from '../design-subnav';
import {
  LockDirectionForm,
  OpenRevisionForm,
  RecordClientReplyForm,
  RecordShareForm,
} from '../design-forms';
import { DECISION_LABEL, Nothing, ORIGIN_LABEL, Section, when } from '../design-shared';

export const metadata: Metadata = { title: 'Final selection' };

/**
 * Final selection — the client loop and the completion gate, split out of
 * the original design page's client-facing sections (Master §8, §10).
 *
 * Every form here RECORDS; none of them sends. There is no channel
 * (BLK-003, BLK-007) — a button labelled "send" over a door that only writes
 * a row would be the most expensive lie this surface could tell.
 *
 * The lock button carries no argument about what to lock. The door reads the
 * client's `final_confirmed` decision to learn that; a picker here could lock
 * something the client never confirmed.
 */
export default async function ProjectFinalSelectionPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design/final`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const trail = await readDesignTrail(projectId);
  const { phase } = trail;
  const mayDecide = can(context.role, 'project.write');

  if (!phase) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Final selection" description={`${project.name} — Phase 3.`} />
        <ProjectSubNav projectId={projectId} />
        <DesignSubNav projectId={projectId} />
        <Nothing>
          Phase 3 has not started for this project.{' '}
          <Link href={`/projects/${projectId}/design`} className="underline hover:text-fg">
            Back to Design
          </Link>
          .
        </Nothing>
      </div>
    );
  }

  // Straight from the stored gate status — the door refuses anything else as
  // `not_approved`, and this only decides what to offer.
  const approvedOptions = trail.themes
    .filter((t) => t.adminStatus === 'approved')
    .map((t) => ({ id: t.id, name: t.name, optionIndex: t.optionIndex }));

  // Which client decisions already opened a round. The door's idempotency key
  // is the decision itself, so offering the form again would only ever return
  // `exists` — true, but it reads as if nothing happened.
  const revisedDecisions = new Set(
    trail.revisions.map((r) => r.clientDecisionId).filter((id): id is string => Boolean(id)),
  );

  const themeName = (id: string | null) =>
    trail.themes.find((t) => t.id === id)?.name ?? (id ? 'an option not in this phase' : null);

  // A round's own snapshot, with each direction's palettes attached, so the
  // reply pickers offer exactly what that client was shown.
  const shownIn = (sharedOptions: unknown[]) =>
    (sharedOptions as { themeOptionId?: string; name?: string }[])
      .filter((o): o is { themeOptionId: string; name?: string } => Boolean(o.themeOptionId))
      .map((o) => ({
        themeOptionId: o.themeOptionId,
        name: o.name ?? themeName(o.themeOptionId) ?? 'an option',
        colors: trail.themes.find((t) => t.id === o.themeOptionId)?.colors.map((c) => ({
          id: c.id,
          paletteName: c.paletteName,
        })) ?? [],
      }));

  // The confirmation the door will read: the newest `final_confirmed`. Read
  // here only to label the button and to warn about a missing Figma reference
  // — the door reads it again and wins if they ever disagree.
  const confirmation = trail.clientDecisions.find((c) => c.decision === 'final_confirmed') ?? null;
  const lockedTheme = trail.handoff ? trail.themes.find((t) => t.id === trail.handoff?.themeOptionId) : undefined;

  const messages = await readDesignMessages(phase.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Final selection"
        description={`${project.name} — what was sent to the client, what they said, and the locked direction.`}
      />

      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      {/* §8 — Client Shares. The row §8 marks *very important*. */}
      <Section
        title="What was sent to the client"
        hint="Exactly which options were sent, and when — without reading WhatsApp. Each round is a frozen snapshot, so revising an option later does not rewrite what the client saw."
      >
        {mayDecide ? <RecordShareForm projectId={projectId} options={approvedOptions} /> : null}
        {trail.shares.length === 0 ? (
          <Nothing>Nothing has been sent to the client.</Nothing>
        ) : (
          <ul className="flex flex-col gap-2">
            {trail.shares.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Round {s.shareNumber}</span>
                  <span className="text-muted">
                    {s.optionCount} option{s.optionCount === 1 ? '' : 's'} · {s.channel} · {when(s.createdAt)}
                  </span>
                </div>
                <p className="text-muted">
                  evidence <code className="text-fg">{s.evidenceRef}</code>
                </p>
                <ul className="flex flex-wrap gap-2">
                  {(s.sharedOptions as { themeOptionId?: string; name?: string }[]).map((o, i) => (
                    <li key={`${s.id}-${o.themeOptionId ?? i}`} className="rounded-sm border border-line px-2 py-0.5">
                      {o.name ?? 'an option'}
                    </li>
                  ))}
                </ul>
                {/*
                  Only on the newest round, and the pickers come from THAT
                  round's frozen snapshot rather than the options as they stand
                  now — which is the same rule the door enforces as
                  `not_shown`. Offering anything else would build a form whose
                  normal outcome is a refusal.
                */}
                {mayDecide && s.id === trail.shares[0]?.id ? (
                  <RecordClientReplyForm
                    projectId={projectId}
                    shareId={s.id}
                    shown={shownIn(s.sharedOptions)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* PM §10, §11 — the wording, and why a step is not available yet. */}
      <Section
        title="What to send the client"
        hint="The wording for each step, filled from this project's actual state. A step that would claim something that has not happened is not offered — §10 forbids the claim, not just the mistake."
      >
        {messages.map((m) => (
          <div key={m.stepKey} className="flex flex-col gap-1 rounded-md border border-line p-3">
            <span className="text-[13px] font-semibold">{m.label}</span>
            {m.body ? (
              <>
                <p className="max-w-2xl whitespace-pre-wrap text-[13px]">{m.body}</p>
                <p className="text-xs text-muted">
                  Copy this and send it yourself — AgencyOS has no channel configured. Record what
                  you sent above.
                </p>
              </>
            ) : (
              <p className="max-w-2xl text-[13px] text-muted">{m.blockedReason}</p>
            )}
          </div>
        ))}
      </Section>

      {/* §8 — Client Feedback */}
      <Section
        title="What the client said"
        hint="Their own words on every classification, kept as written. An interpretation nobody can see the source of is this system's opinion about a client."
      >
        {trail.clientDecisions.length === 0 ? (
          <Nothing>The client has not replied.</Nothing>
        ) : (
          <ul className="flex flex-col gap-2">
            {trail.clientDecisions.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={c.decision === 'final_confirmed' ? 'success' : c.decision === 'possible_scope_change' ? 'danger' : 'info'}>
                    {DECISION_LABEL[c.decision] ?? c.decision}
                  </Badge>
                  <span className="text-muted">{when(c.createdAt)}</span>
                  {c.selectedThemeOptionId ? (
                    <span className="text-muted">· {themeName(c.selectedThemeOptionId)}</span>
                  ) : null}
                </div>
                <p className="max-w-2xl">“{c.clientWords}”</p>
                {mayDecide
                && c.decision === 'design_change_request'
                && c.selectedThemeOptionId
                && !revisedDecisions.has(c.id) ? (
                  <OpenRevisionForm
                    projectId={projectId}
                    themeOptionId={c.selectedThemeOptionId}
                    clientDecisionId={c.id}
                    clientWords={c.clientWords}
                  />
                ) : null}
                {c.evidenceRef ? (
                  <p className="text-muted">
                    evidence <code className="text-fg">{c.evidenceRef}</code>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* §8 — Revision History */}
      <Section
        title="Revision history"
        hint="Origin, round and what was asked. Only client rounds count against the limit — an Admin edit is the agency correcting its own work before the client saw it."
      >
        {trail.revisions.length === 0 ? (
          <Nothing>No revision has been opened.</Nothing>
        ) : (
          <ul className="flex flex-col gap-2">
            {trail.revisions.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.origin === 'client_revision' ? 'warning' : 'neutral'}>
                    {ORIGIN_LABEL[r.origin] ?? r.origin}
                  </Badge>
                  {r.roundNumber !== null ? (
                    <span className="font-semibold">Round {r.roundNumber}</span>
                  ) : (
                    <span className="text-muted">does not count against the client limit</span>
                  )}
                  <span className="text-muted">· {r.status} · {when(r.createdAt)}</span>
                </div>
                <p className="max-w-2xl">{r.requestedChanges}</p>
                <p className="text-muted">
                  {themeName(r.fromThemeOptionId)}
                  {r.toThemeOptionId ? ` → ${themeName(r.toThemeOptionId)}` : ' → not delivered yet'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* §8 — Final Selection and Phase Handoff */}
      <Section
        title="Final direction and Phase 4 handoff"
        hint="The locked theme, palette and Figma version, and whether Phase 4 has everything it needs."
      >
        {!trail.handoff ? (
          confirmation && mayDecide ? (
            <LockDirectionForm
              projectId={projectId}
              phaseThreeId={phase.id}
              confirmedWords={confirmation.clientWords}
              hasFigma={Boolean(
                trail.themes.find((t) => t.id === confirmation.selectedThemeOptionId)?.figmaNodeId,
              )}
            />
          ) : (
            <Nothing>
              Nothing is locked. The direction locks when the client confirms an exact theme and
              colour.
            </Nothing>
          )
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={trail.handoff.phaseFourReady ? 'success' : 'warning'}>
                {trail.handoff.phaseFourReady ? 'Phase 4 ready' : 'not Phase 4 ready'}
              </Badge>
              <span className="text-muted">locked {when(trail.handoff.lockedAt)}</span>
            </div>
            <p>{lockedTheme ? lockedTheme.name : 'the locked direction'}</p>
            <p className="text-muted">
              {trail.handoff.figmaNodeId ? (
                <>
                  Figma node <code className="text-fg">{trail.handoff.figmaNodeId}</code>
                  {trail.handoff.figmaVersion ? ` · version ${trail.handoff.figmaVersion}` : ''}
                </>
              ) : (
                'No Figma reference.'
              )}
            </p>
            {trail.handoff.readinessNote ? (
              <p className="max-w-2xl rounded-md border border-line bg-surface px-3 py-2">
                {trail.handoff.readinessNote}
              </p>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
