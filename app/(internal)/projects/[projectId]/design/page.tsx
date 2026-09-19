import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listInternalRoster, readDesignTrail } from '@/modules/projects/queries';
import { Badge, PageHeader, type Tone } from '@/ui';

import {
  AdminDecisionForm,
  AssignReviewerForm,
  InternalReviewForm,
  LockDirectionForm,
  OpenRevisionForm,
  RecordClientReplyForm,
  RecordShareForm,
} from './design-forms';

export const metadata: Metadata = { title: 'Design direction' };

/**
 * Phase 3 in the Admin Panel — Master §8, §10; Designer §22; PM §13; G-286.
 *
 * G-277 through G-285 built eleven tables, nine doors and the whole
 * designer → internal → Admin → PM → client order — and rendered **none of
 * it**. Every table is internal-only with no write policy, so the entire phase
 * was visible to somebody with a database client and to nobody else. That is
 * the dominant defect class in this repository, and this is the largest
 * instance of it so far.
 *
 * §8 states the requirement and then states what it is for:
 *
 *   *"Admin must be able to inspect not only the final selected UI, but the
 *   **complete decision trail**."*
 *
 * and marks one row *very important*: *"Which UI samples were sent to this
 * client?"* — **without reading WhatsApp manually.** G-282 froze the share as
 * a snapshot precisely so that question would have an answer here. This page
 * is where it gets asked.
 *
 * ── the two queues, and only those two ────────────────────────────────
 *
 * G-287 added §10's internal review and Admin approval queues here rather than
 * as separate pages. A reviewer deciding on an option wants the direction, its
 * palette and what the last round said in front of them; a queue on its own
 * page would have been a list of names to click away from.
 *
 * G-288 then added the client loop — recording a share, recording the reply,
 * and opening the round a change request asks for. G-289 added the lock, and
 * it sits with the handoff rather than beside the conversation: it is the
 * completion gate, not another message.
 *
 * **The lock button carries no argument about what to lock.** The door reads
 * the client's confirmation to learn that. A picker here could lock something
 * the client never confirmed, and §16's no-silent-overwrite rule would be held
 * by whoever last touched it.
 *
 * ── every client-loop form RECORDS; none of them sends ────────────────
 *
 * There is no channel here (BLK-003, BLK-007). A button labelled "send" over
 * a door that only writes a row would be the most expensive lie this surface
 * could tell.
 *
 * ── a form appears from the STORED status, never from a re-derivation ─
 *
 * `internal_review_status` and `admin_status` decide what is offered, and the
 * door checks again — including the two rules no capability can express: the
 * internal gate wants the assigned reviewer specifically, and the Admin gate
 * refuses an option internal review has not passed.
 *
 * ── it does not recompute anything ────────────────────────────────────
 *
 * The revision count, the gate statuses and the handoff readiness are read as
 * stored. A page that re-derived "this looks approved" from the rows would be
 * a second opinion on a rule the database already holds, and the two would
 * disagree the first time either changed.
 */

const PHASE_TONE: Record<string, Tone> = {
  context_loading: 'info',
  screen_baseline: 'info',
  drafting: 'info',
  figma_sync: 'info',
  internal_review: 'info',
  admin_review: 'warning',
  client_review: 'warning',
  waiting_client: 'warning',
  revision: 'warning',
  final_confirmation: 'info',
  locked: 'success',
  completed: 'success',
  blocked_requirement: 'danger',
  scope_escalation: 'danger',
  revision_limit_escalation: 'danger',
};

const GATE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  not_submitted: 'neutral',
  not_shared: 'neutral',
  in_review: 'info',
  changes_required: 'danger',
  edit_requested: 'danger',
  change_requested: 'danger',
  passed: 'success',
  approved: 'success',
  shared: 'info',
  selected: 'success',
  locked: 'success',
};

const DECISION_LABEL: Record<string, string> = {
  client_selected: 'Selected a direction',
  design_change_request: 'Asked for a change',
  client_reference: 'Sent a reference',
  possible_scope_change: 'Possible scope change',
  clarification_required: 'Unclear — needs clarification',
  final_confirmed: 'Confirmed the final direction',
};

const ORIGIN_LABEL: Record<string, string> = {
  internal_review: 'Internal review',
  admin_edit: 'Admin edit',
  client_revision: 'Client',
};

const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
      {hint ? <p className="max-w-2xl text-[13px] text-muted">{hint}</p> : null}
      {children}
    </section>
  );
}

function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted">{children}</p>;
}

export default async function ProjectDesignPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const [trail, roster] = await Promise.all([readDesignTrail(projectId), listInternalRoster()]);
  const { phase } = trail;
  // Phase 3 is project work, so it takes the capability that changes a
  // project. The doors check the finer rules again — this only decides what
  // to render.
  const mayDecide = can(context.role, 'project.write');

  if (!phase) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Design direction" description={`${project.name} — Phase 3.`} />
        <Nothing>
          Phase 3 has not started for this project. It opens when Phase 2 completes and the plan is
          active.{' '}
          <Link href={`/projects/${projectId}`} className="underline hover:text-fg">
            Back to the project
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

  const themeName = (id: string | null) =>
    trail.themes.find((t) => t.id === id)?.name ?? (id ? 'an option not in this phase' : null);
  const lockedTheme = trail.handoff ? trail.themes.find((t) => t.id === trail.handoff?.themeOptionId) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Design direction"
        description={`${project.name} — the Phase 3 decision trail.`}
      />

      <p className="max-w-2xl text-[13px] text-muted">
        Everything Phase 3 decided and who decided it. The internal review and Admin approval gates
        are here; sharing with the client, recording their reply and locking the direction are PM
        and system work with their own preconditions.{' '}
        <Link href={`/projects/${projectId}`} className="underline hover:text-fg">
          Back to the project
        </Link>
        .
      </p>

      {/* §8 — Phase 3 Overview */}
      <Section title="Overview">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={PHASE_TONE[phase.state] ?? 'neutral'}>{phase.state.replace(/_/g, ' ')}</Badge>
          <span className="text-[13px] text-muted">
            started {when(phase.startedAt)}
            {phase.completedAt ? ` · completed ${when(phase.completedAt)}` : ''}
          </span>
          <span className="text-[13px] text-muted">
            · {phase.revisionCount} of {phase.revisionLimit} client revision rounds used
          </span>
        </div>
        {phase.blockedReason ? (
          <p className="max-w-2xl rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
            {phase.blockedReason}
          </p>
        ) : null}
        {!phase.reviewerUserId ? (
          <Nothing>
            No internal design reviewer is assigned. The internal gate refuses until somebody holds
            it, and nothing reaches Admin until it passes.
          </Nothing>
        ) : null}
        {mayDecide ? (
          <AssignReviewerForm projectId={projectId} roster={roster} current={phase.reviewerUserId} />
        ) : null}
      </Section>

      {/* §8 — Screen List and Screen Content */}
      <Section
        title="Screen baseline"
        hint="The screen list and its content baseline, as finalized. A later change is a new version."
      >
        {!trail.baseline ? (
          <Nothing>No screen baseline has been drafted.</Nothing>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={trail.baseline.status === 'finalized' ? 'success' : 'neutral'}>
              v{trail.baseline.version} · {trail.baseline.status}
            </Badge>
            <span className="text-[13px] text-muted">{trail.baseline.screenCount} screens</span>
            <Link
              href={`/projects/${projectId}/plan`}
              className="text-[13px] underline hover:text-fg"
            >
              the plan it was built from
            </Link>
          </div>
        )}
      </Section>

      {/* §8 — Theme Options and Color Options */}
      <Section
        title="Theme and colour options"
        hint="Every option generated, its Figma reference and where it stands at each of the three gates."
      >
        {trail.themes.length === 0 ? (
          <Nothing>No theme options have been generated.</Nothing>
        ) : (
          <div className="flex flex-col gap-3">
            {trail.themes.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">
                    {t.optionIndex}. {t.name}
                  </span>
                  <span className="text-xs text-muted">v{t.version} · {t.origin.replace(/_/g, ' ')}</span>
                </div>
                <p className="max-w-2xl text-[13px] text-muted">{t.directionSummary}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={GATE_TONE[t.internalReviewStatus] ?? 'neutral'}>
                    internal: {t.internalReviewStatus.replace(/_/g, ' ')}
                  </Badge>
                  <Badge tone={GATE_TONE[t.adminStatus] ?? 'neutral'}>
                    admin: {t.adminStatus.replace(/_/g, ' ')}
                  </Badge>
                  <Badge tone={GATE_TONE[t.clientStatus] ?? 'neutral'}>
                    client: {t.clientStatus.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <p className="text-[13px] text-muted">
                  {t.figmaNodeId ? (
                    <>
                      Figma node <code className="text-fg">{t.figmaNodeId}</code>
                      {t.figmaVersion ? ` · version ${t.figmaVersion}` : ''}
                    </>
                  ) : t.previewAssetUrl ? (
                    'Preview only — no Figma reference recorded. Figma is the canonical artifact for Phase 4.'
                  ) : (
                    'Nothing to show yet: no Figma reference and no preview.'
                  )}
                </p>
                {/* §10's queues. Offered from the stored status; the doors decide. */}
                {mayDecide && t.internalReviewStatus !== 'passed' && t.adminStatus !== 'approved' ? (
                  <InternalReviewForm projectId={projectId} themeOptionId={t.id} />
                ) : null}
                {mayDecide && t.internalReviewStatus === 'passed' && t.adminStatus !== 'approved' ? (
                  <AdminDecisionForm projectId={projectId} themeOptionId={t.id} />
                ) : null}
                {t.colors.length === 0 ? (
                  <Nothing>No palettes drawn for this direction.</Nothing>
                ) : (
                  <div className="flex flex-col gap-1">
                    {t.colors.map((c) => (
                      <div key={c.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                        <span className="flex gap-1" aria-hidden>
                          {c.swatches.map((hex, i) => (
                            <span
                              key={`${c.id}-${i}`}
                              className="inline-block h-4 w-4 rounded-sm border border-line"
                              style={{ backgroundColor: hex }}
                            />
                          ))}
                        </span>
                        <span>{c.paletteName}</span>
                        <Badge tone={GATE_TONE[c.clientStatus] ?? 'neutral'}>{c.clientStatus.replace(/_/g, ' ')}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* §8 — Internal Review */}
      <Section title="Internal review" hint="Reviewer result, comments and when — before Admin ever sees an option.">
        {trail.reviews.length === 0 ? (
          <Nothing>No internal review has been recorded.</Nothing>
        ) : (
          <ul className="flex flex-col gap-2">
            {trail.reviews.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.result === 'passed' ? 'success' : 'danger'}>{r.result.replace(/_/g, ' ')}</Badge>
                  <span className="text-muted">{themeName(r.themeOptionId)} · {when(r.createdAt)}</span>
                </div>
                {r.comments ? <p className="max-w-2xl">{r.comments}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* §8 — Admin Decisions */}
      <Section title="Admin decisions" hint="CONFIRM and EDIT, with the reason. An edit returns the option to the designer and to internal review.">
        {trail.adminDecisions.length === 0 ? (
          <Nothing>No Admin decision has been recorded.</Nothing>
        ) : (
          <ul className="flex flex-col gap-2">
            {trail.adminDecisions.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={a.decision === 'confirm' ? 'success' : 'warning'}>{a.decision}</Badge>
                  <span className="text-muted">{themeName(a.themeOptionId)} · {when(a.createdAt)}</span>
                </div>
                {a.reason ? <p className="max-w-2xl">{a.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

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

      {/* §8 — Cost/Usage. Named rather than omitted. */}
      <Section title="Design cost and usage">
        <Nothing>
          No design generation has run on this deployment, so there is nothing to account for. §8
          asks for this &ldquo;where available&rdquo;; when a design agent runs, its usage is
          recorded against the project like every other agent run.
        </Nothing>
      </Section>
    </div>
  );
}
