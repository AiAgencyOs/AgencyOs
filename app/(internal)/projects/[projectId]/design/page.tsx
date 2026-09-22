import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getProject,
  listInternalRoster,
  readDesignAssets,
  readDesignTrail,
  readProjectSpend,
  readUiCoverage,
} from '@/modules/projects/queries';
import { Badge, PageHeader } from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { DesignSubNav } from './design-subnav';
import { AssignReviewerForm } from './design-forms';
import { Nothing, PHASE_TONE, Section, when } from './design-shared';

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
 * Originally one 800-line page holding the whole trail. Split across four
 * routes (this Overview, Themes, Colors, Final selection — see
 * `design-subnav.tsx`) for the same reason `ProjectSubNav` exists at all: a
 * page that answers everything is a page nobody can scan for the one thing
 * they came for. The split changed nothing about what is read, written or
 * enforced — every section still calls `readDesignTrail` and the same eleven
 * Server Actions `design-forms.tsx` has always exposed.
 *
 * This page keeps: phase status and reviewer assignment, the screen baseline,
 * the coverage report and reference imagery, and cost/usage. Theme and colour
 * generation, the internal/Admin queues, the client loop and the final lock
 * live on their own routes now.
 *
 * ── it does not recompute anything ────────────────────────────────────
 *
 * The revision count is read as stored, here and on every route this page's
 * trail was split across. A page that re-derived "this looks approved" from
 * the rows would be a second opinion on a rule the database already holds,
 * and the two would disagree the first time either changed.
 */

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
        <ProjectSubNav projectId={projectId} />
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

  const spend = await readProjectSpend(projectId);
  /**
   * Doc 12 §9's coverage matrix — *"one of the main controls preventing an AI
   * designer from producing attractive but incomplete work"*. G-306: it was
   * written with the flags, the blocking distinction and the refusal that
   * reads three of them, and nothing ever rendered it, so the control existed
   * and nobody could look at it.
   */
  const screenCoverage = await readUiCoverage(projectId);
  // Designer §9 — optional reference imagery, never canonical. G-308.
  const designAssets = await readDesignAssets(projectId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Design direction"
        description={`${project.name} — the Phase 3 decision trail.`}
      />

      <ProjectSubNav projectId={projectId} />
      <DesignSubNav projectId={projectId} />

      <p className="max-w-2xl text-[13px] text-muted">
        Phase status, the screen baseline, the coverage report and project spend. Theme and colour
        options, the review queues, the client loop and the final lock are on their own tabs above.{' '}
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

      {/*
        Doc 12 §9 and §20 — the coverage matrix. A REPORT, and deliberately
        not a second gate: `projects.refuse_uncovered_design` already refuses
        the three flags that are mechanically exact, and the rest are
        judgement nobody has configured. Surfacing them is the control; adding
        a threshold here would be inventing the business rule.
      */}
      <Section
        title="Screen coverage"
        hint="Doc 12 §9. Blocking flags are the three the database refuses a design against; the rest are for a person to weigh."
      >
        {screenCoverage.length === 0 ? (
          <Nothing>
            Nothing is flagged. Every included scope item has a screen, and every screen has what
            §9 asks of it.
          </Nothing>
        ) : (
          <ul className="flex flex-col gap-1">
            {screenCoverage.map((flag) => (
              <li
                key={`${flag.flag}:${flag.subject_id}`}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{flag.subject}</span>{' '}
                  <span className="text-muted">— {flag.flag.replace(/_/g, ' ')}</span>
                </span>
                {flag.blocking ? <Badge tone="danger">refused by the database</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/*
        Designer §9 — optional support, never canonical. G-308, ADM-111: the
        agent decides on its own whether one helps, inside design.directions;
        at most one per context version. Rendered exactly like preview_asset_url
        on the Themes tab — a reference, never implied to be the design.
      */}
      <Section
        title="Reference imagery"
        hint="Designer §9 — optional AI-generated inspiration, drawn by the agent when it judges one would help. Never the canonical design; Figma is."
      >
        {designAssets.length === 0 ? (
          <Nothing>No reference image has been generated for this project.</Nothing>
        ) : (
          <ul className="flex flex-col gap-3">
            {designAssets.map((asset) => (
              <li key={asset.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone="neutral">{asset.kind.replace(/_/g, ' ')}</Badge>
                  <span className="text-xs text-muted">{asset.model} · {asset.createdAt}</span>
                </div>
                {/* A base64 data URL — next/image cannot optimise it, and shouldn't try. */}
                <img
                  src={`data:${asset.mediaType};base64,${asset.imageBase64}`}
                  alt={asset.prompt}
                  className="max-h-64 w-auto rounded-md border border-line"
                />
                <p className="text-xs text-muted">{asset.prompt}</p>
                <p className="text-xs text-muted">{asset.rightsNote}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/*
        §8 — Cost/Usage, and §6's "track usage by project, phase, agent and
        task". The figures come from G-297's attribution, which is derived from
        each run's subject — so this covers runs that happened before the
        dimension existed, not only ones since.

        The UNATTRIBUTED line is kept rather than dropped. A report showing
        only the phases it can name would understate the total, and
        understating spend is the direction that matters: somebody would
        believe the project cost less than it did.
      */}
      <Section title="Cost and usage">
        {spend.length === 0 ? (
          <Nothing>
            No agent run has been attributed to this project yet. No design agent has run on this
            deployment at all — §8 asks for this “where available”, and when one runs its usage is
            recorded against the project like every other agent run.
          </Nothing>
        ) : (
          <table className="w-full max-w-2xl text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-1 font-normal">Phase</th>
                <th className="py-1 font-normal">Runs</th>
                <th className="py-1 font-normal">In</th>
                <th className="py-1 font-normal">Out</th>
                <th className="py-1 font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {spend.map((row) => (
                <tr key={row.phase ?? 'unattributed'} className="border-b border-line">
                  <td className="py-1">
                    {row.phase === null ? (
                      <span className="text-muted">phase not knowable</span>
                    ) : (
                      `Phase ${row.phase}`
                    )}
                  </td>
                  <td className="py-1">{row.runs}</td>
                  <td className="py-1">{row.inputTokens.toLocaleString('en-IN')}</td>
                  <td className="py-1">{row.outputTokens.toLocaleString('en-IN')}</td>
                  {/* Minor units, like every other money column in this system. */}
                  <td className="py-1">₹{(row.costMinor / 100).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {spend.some((r) => r.phase === null) ? (
          <p className="max-w-2xl text-xs text-muted">
            A run whose phase is not knowable is still this project’s spend. Phase is recorded only
            where a run’s subject belongs to exactly one phase — guessing would make this table
            confidently wrong.
          </p>
        ) : null}
      </Section>
    </div>
  );
}
