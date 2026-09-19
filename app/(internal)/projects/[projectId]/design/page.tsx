import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, readDesignTrail } from '@/modules/projects/queries';
import { Badge, PageHeader, type Tone } from '@/ui';

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
 * ── it is read-only, and that is a decision ───────────────────────────
 *
 * Every door this phase owns refuses something specific — an option internal
 * review has not passed, a share of something Admin has not approved, a
 * confirmation naming what the client was never shown. Putting buttons here
 * before the gates have a surface would mean the first thing anybody could do
 * with Phase 3 is the thing the gates exist to sequence.
 *
 * So this shows the trail and takes no decisions. The queues §10 asks for —
 * internal review, Admin approval — are their own unit, and each of them is a
 * form over a door that already exists.
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

  const trail = await readDesignTrail(projectId);
  const { phase } = trail;

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
        Everything Phase 3 decided and who decided it. Read-only: the gates this phase enforces are
        sequenced — designer, internal review, Admin, PM, client — and their queues are their own
        surface.{' '}
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
            No internal design reviewer is assigned. The Admin gate refuses until somebody holds it.
          </Nothing>
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
          <Nothing>Nothing is locked. The direction locks when the client confirms an exact theme and colour.</Nothing>
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
