import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listApprovalsForSubject } from '@/modules/approvals/queries';
import { readPaymentLadder } from '@/modules/finance/queries';
import { readHandoverRelease } from '@/modules/projects/handover-release-queries';
import { readReleaseHold } from '@/modules/projects/release-hold-queries';
import { getProject, listDeliverables, readCompletionSummary } from '@/modules/projects/queries';
import { listDefects, listTestRuns, readProjectQuality, readTestPlan } from '@/modules/qa/queries';
import { readHandoverPackage, readProductionReadiness, readProductionReadyAt } from '@/modules/qa/release-queries';
import { blocksDelivery, type DefectSeverity, type DefectStatus } from '@/modules/qa/schema';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  cx,
  humanize,
  IconAlert,
  IconCheck,
  IconFlag,
  IconList,
  IconRupee,
  PermissionDenied,
  Stat,
  StatGrid,
  StatusBadge,
  ViewAll,
  type Tone,
} from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { ProductionReadyForm } from '../qa-panel';
import { WorkspaceHeader } from '../workspace-header';
import { RollbackPlanForm, SmokeChecklist } from './release-panel';
import { HoldReleaseForm, LiftReleaseHoldForm } from './release-hold-panel';

export const metadata: Metadata = { title: 'Release gate' };

/**
 * One line of the gate. `unknown` is a real third answer, not a softer
 * "fail": it means the record the line is about does not exist yet (no test
 * run, no handover, a payment plan this role may not read), and the page says
 * which rather than colouring it red.
 */
type GateMark = 'pass' | 'fail' | 'unknown';

type GateItem = {
  key: string;
  label: string;
  mark: GateMark;
  /** The fact behind the mark, in words somebody can check. */
  fact: string;
  /** Where it gets fixed. */
  href: string;
  hrefLabel: string;
  /** Whether `projects.mark_production_ready` actually checks this line. */
  hardGate: boolean;
};

const MARK_TONE: Record<GateMark, Tone> = { pass: 'success', fail: 'danger', unknown: 'neutral' };
const MARK_WORD: Record<GateMark, string> = { pass: 'Pass', fail: 'Fail', unknown: 'Unknown' };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Per-project half of SCR-049 — the release checklist, composed from readers
 * that already existed and one small file of reads that did not.
 *
 * Two kinds of line sit on one list and the page keeps them apart. The **hard
 * gate** is exactly what `projects.mark_production_ready` checks (ADM-19: no
 * open blockers, no open majors, a client-approved build) and the Decision
 * card states what that door would answer right now, read from the same
 * function the door calls. The other lines — final payment verified, test
 * runs on the build, a handover package — are what a release manager checks
 * beside it, and the page says plainly that the door does not. Nothing here
 * decides; the only write is the existing sign-off form.
 */
export default async function ReleaseGatePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/release`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const mayReadInvoices = can(context.role, 'invoice.read');
  const maySignOff = can(context.role, 'project.sign_off');

  const [clientName, ladder, summary, quality, defects, deliverables, plan, runs, handover, readiness, readyAt, release, hold] =
    await Promise.all([
      project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
      // Same rule the Overview applies: the ladder is a finance read.
      mayReadInvoices ? readPaymentLadder(projectId) : Promise.resolve(null),
      readCompletionSummary(projectId),
      readProjectQuality(projectId),
      listDefects(projectId),
      listDeliverables(projectId),
      readTestPlan(projectId),
      listTestRuns(projectId),
      readHandoverPackage(projectId),
      readProductionReadiness(projectId),
      readProductionReadyAt(projectId),
      readHandoverRelease(projectId),
      // SCR-044 — a standing release hold, which the sign-off door refuses on.
      readReleaseHold(projectId),
    ]);
  const mayWrite = can(context.role, 'project.write');

  // listDeliverables orders by kind, then version descending — the first
  // build row is the latest one.
  const builds = deliverables.filter((d) => d.kind === 'build');
  const latestBuild = builds[0] ?? null;
  const approvedBuild = builds.find((d) => d.status === 'approved') ?? null;
  const buildApprovals = latestBuild ? await listApprovalsForSubject('deliverable', latestBuild.id) : [];
  const latestApproval = buildApprovals[0] ?? null;

  const blocking = defects.filter((d) =>
    blocksDelivery({ status: d.status as DefectStatus, severity: d.severity as DefectSeverity }),
  );

  const buildRuns = latestBuild ? runs.filter((r) => r.deliverableId === latestBuild.id) : [];
  const failedBuildRuns = buildRuns.filter((r) => r.failed > 0);
  const runTotals = buildRuns.reduce(
    (acc, r) => ({ passed: acc.passed + r.passed, failed: acc.failed + r.failed, total: acc.total + r.total }),
    { passed: 0, failed: 0, total: 0 },
  );

  const base = `/projects/${projectId}`;

  // ── the checklist ────────────────────────────────────────────────────────

  const paymentItem: GateItem = {
    key: 'payment',
    label: 'Final payment verified',
    hardGate: false,
    href: base,
    hrefLabel: 'Overview · payment ladder',
    ...(ladder === null
      ? { mark: 'unknown', fact: 'Not visible to your role — the payment ladder is a finance read (invoice.read).' }
      : !ladder.measurable
        ? { mark: 'unknown', fact: 'No payment plan on this project adds to 100%, so there is no percentage to verify against.' }
        : ladder.gate.open
          ? {
              mark: 'pass',
              fact: `100% of the payment plan is verified — ${ladder.verifiedMilestones} of ${plural(ladder.milestones, 'priced milestone')}.`,
            }
          : {
              mark: 'fail',
              fact: `${ladder.verifiedPercent ?? 0}% verified; ${ladder.gate.shortfallPercent}% is still to be verified (${ladder.verifiedMilestones} of ${plural(ladder.milestones, 'priced milestone')}).`,
            }),
  };

  // SCR-044 — the one line a person decides. A HARD gate: mark_production_ready
  // answers `held` while it stands, before it measures the other three.
  const holdItem: GateItem = {
    key: 'hold',
    label: 'No release hold',
    hardGate: true,
    href: `${base}/release#release-hold`,
    hrefLabel: 'Release hold',
    mark: hold ? 'fail' : 'pass',
    fact: hold
      ? `Held ${clock.dateTime(hold.heldAt)}${hold.heldByName ? ` by ${hold.heldByName}` : ''}: "${hold.reason}"`
      : 'No hold stands. The owner or an ops admin may hold the release for a reason the gate does not measure.',
  };

  const blockersItem: GateItem = {
    key: 'blockers',
    label: 'No open blocker defects',
    hardGate: true,
    href: base,
    hrefLabel: 'Overview · quality',
    mark: readiness.noOpenBlockers ? 'pass' : 'fail',
    fact: readiness.noOpenBlockers
      ? `No blocker is open. ${plural(quality.unverified, 'fix')} still await QA verification.`
      : `${plural(quality.open_blockers, 'blocker')} open. A version cannot be submitted to the client until they are settled.`,
  };

  const majorsItem: GateItem = {
    key: 'majors',
    label: 'No open major defects',
    hardGate: true,
    href: base,
    hrefLabel: 'Overview · quality',
    mark: readiness.noOpenMajors ? 'pass' : 'fail',
    fact: readiness.noOpenMajors
      ? `No major is open. ${plural(quality.open_minors, 'minor')} open, which the gate does not count.`
      : `${plural(quality.open_majors, 'major')} open.`,
  };

  const buildItem: GateItem = {
    key: 'build',
    label: 'Client-approved build',
    hardGate: true,
    href: `${base}/builds`,
    hrefLabel: 'Builds',
    ...(readiness.buildApproved
      ? {
          mark: 'pass',
          fact: approvedBuild
            ? `${approvedBuild.title} v${approvedBuild.version} is approved${latestBuild && latestBuild.id !== approvedBuild.id ? ` — the latest, v${latestBuild.version}, is ${humanize(latestBuild.status)}` : ''}.`
            : 'The database reports an approved build.',
        }
      : latestBuild === null
        ? { mark: 'unknown', fact: 'No build has been submitted as a deliverable.' }
        : {
            mark: 'fail',
            fact: `Latest build v${latestBuild.version} is ${humanize(latestBuild.status)}${
              latestApproval ? `; its client approval is ${humanize(latestApproval.state)}` : '; no client approval has been requested'
            }.`,
          }),
  };

  const testsItem: GateItem = {
    key: 'tests',
    label: 'Test runs passed on the latest build',
    hardGate: false,
    href: `${base}/qa`,
    hrefLabel: 'QA · test runs',
    ...(latestBuild === null
      ? { mark: 'unknown', fact: 'No build to run tests against.' }
      : buildRuns.length === 0
        ? { mark: 'unknown', fact: `No test run has been recorded against build v${latestBuild.version}.` }
        : failedBuildRuns.length > 0
          ? {
              mark: 'fail',
              fact: `${runTotals.failed} of ${runTotals.total} tests failed across ${plural(buildRuns.length, 'run')} on v${latestBuild.version} (${failedBuildRuns.map((r) => r.suite).join(', ')}).`,
            }
          : {
              mark: 'pass',
              fact: `${runTotals.passed} of ${runTotals.total} tests passed across ${plural(buildRuns.length, 'run')} on v${latestBuild.version}; none failed.`,
            }),
  };

  const planItem: GateItem = {
    key: 'plan',
    label: 'Test plan drafted against the frozen baseline',
    hardGate: false,
    href: `${base}/qa`,
    hrefLabel: 'QA · test plan',
    ...(plan
      ? {
          mark: 'pass',
          fact: `${plural(plan.items.length, 'item')} planned against scope baseline v${plan.scopeVersionNumber}, ${plural(plan.items.filter((i) => i.criticalPath).length, 'critical-path item')}.`,
        }
      : { mark: 'unknown', fact: 'No test plan has been drafted.' }),
  };

  const handoverItem: GateItem = {
    key: 'handover',
    label: 'Handover package',
    hardGate: false,
    href: base,
    hrefLabel: 'Overview · summary',
    ...(handover === null
      ? { mark: 'unknown', fact: 'No handover has been prepared.' }
      : handover.status === 'accepted'
        ? { mark: 'pass', fact: `Accepted by the client ${handover.accepted_at ? clock.date(handover.accepted_at) : ''} — ${plural(handover.items.length, 'item')}.` }
        : handover.status === 'delivered'
          ? { mark: 'pass', fact: `Delivered ${handover.delivered_at ? clock.date(handover.delivered_at) : ''}, awaiting the client's acceptance — ${plural(handover.items.length, 'item')}.` }
          : { mark: 'fail', fact: `Still ${humanize(handover.status)} — ${plural(handover.items.length, 'item')} in the package so far.` }),
  };

  // SCR-049 — the smoke checklist and rollback plan, recorded on the
  // handover (20260929170000). Reports, not gates: `mark_production_ready`
  // reads neither, and the line says so by carrying no "gate" badge.
  const smokeDone = release ? release.smokeChecklist.filter((i) => i.doneAt !== null).length : 0;
  const smokeTotal = release ? release.smokeChecklist.length : 0;
  const smokeItem: GateItem = {
    key: 'smoke',
    label: 'Smoke checklist complete',
    hardGate: false,
    href: `${base}/release`,
    hrefLabel: 'Release · smoke checklist',
    ...(release === null
      ? { mark: 'unknown', fact: 'No handover has been prepared, so there is no checklist to tick.' }
      : smokeTotal === 0
        ? { mark: 'unknown', fact: 'No smoke check has been listed on the handover.' }
        : smokeDone === smokeTotal
          ? { mark: 'pass', fact: `All ${plural(smokeTotal, 'smoke check')} ticked. A report beside the gate — the sign-off door does not read it.` }
          : { mark: 'fail', fact: `${smokeDone} of ${plural(smokeTotal, 'smoke check')} ticked. A report beside the gate — the sign-off door does not read it.` }),
  };
  const rollbackItem: GateItem = {
    key: 'rollback',
    label: 'Rollback plan recorded',
    hardGate: false,
    href: `${base}/release`,
    hrefLabel: 'Release · rollback plan',
    ...(release === null
      ? { mark: 'unknown', fact: 'No handover has been prepared, so there is nowhere to record one.' }
      : release.rollbackPlan
        ? { mark: 'pass', fact: 'A rollback plan is written on the handover. A report, not a gate.' }
        : { mark: 'fail', fact: 'No rollback plan has been written on the handover. A report, not a gate.' }),
  };

  const items: GateItem[] = [holdItem, blockersItem, majorsItem, buildItem, testsItem, planItem, paymentItem, handoverItem, rollbackItem, smokeItem];
  const counts = items.reduce(
    (acc, i) => ({ ...acc, [i.mark]: acc[i.mark] + 1 }),
    { pass: 0, fail: 0, unknown: 0 } as Record<GateMark, number>,
  );

  // ── the decision, in the door's own words ─────────────────────────────
  // The same three answers `mark_production_ready` reads before it writes.
  const unmet: string[] = [
    ...(hold ? [`a release hold is on: "${hold.reason}"`] : []),
    ...(readiness.noOpenBlockers ? [] : ['there are open blocker defects']),
    ...(readiness.noOpenMajors ? [] : ['there are open major defects']),
    ...(readiness.buildApproved ? [] : ['the client has not approved a build']),
  ];
  const doorWouldOpen = unmet.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context.role, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat
          label="Gate"
          value={`${counts.pass}/${items.length}`}
          caption={`${counts.fail} failing · ${counts.unknown} unknown`}
          tone={counts.fail > 0 ? 'danger' : counts.unknown > 0 ? 'neutral' : 'success'}
          icon={<IconFlag size={16} />}
        />
        <Stat
          label="Open blockers"
          value={String(quality.open_blockers)}
          caption={`${quality.open_majors} major · ${quality.open_minors} minor · ${quality.unverified} awaiting verification`}
          tone={quality.open_blockers > 0 ? 'danger' : quality.open_majors > 0 ? 'warning' : 'success'}
          icon={<IconAlert size={16} />}
        />
        <Stat
          label="Release candidate"
          value={latestBuild ? `v${latestBuild.version}` : '—'}
          caption={latestBuild ? `${latestBuild.title} · ${humanize(latestBuild.status)}` : 'No build submitted'}
          tone={latestBuild?.status === 'approved' ? 'success' : latestBuild ? 'info' : 'neutral'}
          icon={<IconList size={16} />}
          href={`${base}/builds`}
        />
        <Stat
          label="Tests on RC"
          value={buildRuns.length === 0 ? '—' : `${runTotals.passed}/${runTotals.total}`}
          caption={buildRuns.length === 0 ? 'No run recorded' : `${plural(buildRuns.length, 'run')} · ${runTotals.failed} failed`}
          tone={buildRuns.length === 0 ? 'neutral' : runTotals.failed > 0 ? 'danger' : 'success'}
          icon={<IconCheck size={16} />}
          href={`${base}/qa`}
        />
        <Stat
          label="Payment verified"
          value={ladder === null ? '—' : ladder.measurable ? `${ladder.verifiedPercent ?? 0}%` : 'n/a'}
          caption={
            ladder === null
              ? 'Not visible to your role'
              : ladder.measurable
                ? `${ladder.verifiedMilestones}/${ladder.milestones} priced milestones`
                : 'No plan adds to 100%'
          }
          tone={ladder === null ? 'neutral' : ladder.gate.open ? 'success' : ladder.measurable ? 'warning' : 'neutral'}
          icon={<IconRupee size={16} />}
        />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <Card>
          <CardHeader
            title="Release checklist"
            description="Each line is a fact read now, not a cached flag. Lines marked “gate” are what the sign-off door actually checks; the rest are what a release manager checks beside it."
          />
          <ul className="divide-y divide-line">
            {items.map((item) => {
              const tone = MARK_TONE[item.mark];
              return (
                <li key={item.key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                  <span
                    className={cx(
                      'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                      tone === 'success' ? 'bg-success text-white' : tone === 'danger' ? 'bg-danger-soft text-danger' : 'border border-line-strong bg-surface text-muted',
                    )}
                    aria-hidden
                  >
                    {item.mark === 'pass' ? <IconCheck size={14} /> : item.mark === 'fail' ? <IconAlert size={14} /> : <span className="text-xs font-semibold">?</span>}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">{item.label}</span>
                      <Badge tone={tone}>{MARK_WORD[item.mark]}</Badge>
                      {item.hardGate ? <Badge tone="brand">gate</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-[13px] text-muted">{item.mark === 'unknown' ? `Unknown — not recorded. ${item.fact}` : item.fact}</p>
                  </div>
                  <Link href={item.href} className="shrink-0 text-xs font-medium text-brand hover:underline">
                    {item.hrefLabel} →
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Decision" description="What projects.mark_production_ready would answer if pressed now." />
            <CardBody className="flex flex-col gap-3">
              {readyAt ? (
                <>
                  <div className="flex items-center gap-2">
                    <Badge tone="success">Production ready</Badge>
                    <span className="text-[13px] text-muted">signed off {clock.dateTime(readyAt)}</span>
                  </div>
                  <p className="text-[13px] text-muted">
                    Signing off again would answer <span className="font-mono">already_ready</span> and leave the date where it is.
                    {!doorWouldOpen ? ` Since then the gate has moved: ${unmet.join('; ')}.` : ''}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Badge tone={doorWouldOpen ? 'success' : 'danger'}>{doorWouldOpen ? 'Would open' : 'Would refuse'}</Badge>
                    <span className="font-mono text-xs text-muted">{doorWouldOpen ? 'ready' : 'not_ready'}</span>
                  </div>
                  <p className="text-[13px] text-muted">
                    {doorWouldOpen
                      ? 'Every condition ADM-19 sets holds: no open blockers, no open majors, and a client-approved build.'
                      : `Refused because ${unmet.join(', and ')}.`}
                  </p>
                  <p className="text-xs text-muted">
                    Payment, test runs and the handover are not part of the door — a project can be production ready and unpaid. There is no override past ADM-19&apos;s three conditions; a release hold is the one thing a person adds to them.
                  </p>
                  {maySignOff ? <ProductionReadyForm projectId={projectId} /> : <p className="text-xs text-muted">Signing off needs project.sign_off (owner or ops admin).</p>}
                </>
              )}
            </CardBody>
          </Card>

          <Card>
            <div id="release-hold">
              <CardHeader
                title="Release hold"
                description="A reason the gate does not measure — a client freeze, a legal hold. While it stands the sign-off door answers held, quoting it. Owner or ops admin; audited."
              />
            </div>
            <CardBody>
              {maySignOff ? (
                hold ? (
                  <LiftReleaseHoldForm projectId={projectId} reason={hold.reason} heldLabel={`Held ${clock.dateTime(hold.heldAt)}${hold.heldByName ? ` by ${hold.heldByName}` : ''}`} />
                ) : (
                  <HoldReleaseForm projectId={projectId} />
                )
              ) : hold ? (
                <p className="text-[13px]">
                  <Badge tone="danger">held</Badge> <span className="text-muted">{clock.dateTime(hold.heldAt)}{hold.heldByName ? ` · ${hold.heldByName}` : ''}</span>
                  <span className="mt-1 block whitespace-pre-wrap">{hold.reason}</span>
                </p>
              ) : (
                <p className="text-[13px] text-muted">No hold stands. Holding a release needs project.sign_off (owner or ops admin).</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Release candidate" actions={<ViewAll href={`${base}/builds`} label="Builds" />} />
            {latestBuild ? (
              <CardBody className="flex flex-col gap-2 text-[13px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {latestBuild.title} <span className="font-mono">v{latestBuild.version}</span>
                  </span>
                  <StatusBadge status={latestBuild.status} dot={false} />
                </div>
                <p className="text-xs text-muted">Submitted {clock.date(latestBuild.created_at)}</p>
                {latestBuild.known_issues ? (
                  <p className="text-xs text-muted">
                    <span className="font-medium text-foreground">Known issues:</span> {latestBuild.known_issues}
                  </p>
                ) : null}
                <p className="text-xs text-muted">
                  {latestApproval
                    ? `Client approval ${humanize(latestApproval.state)}${latestApproval.decided_at ? ` on ${clock.date(latestApproval.decided_at)}` : ''}.`
                    : 'No client approval requested for this version.'}
                </p>
                {blocking.length > 0 ? (
                  <p className="text-xs text-danger">
                    {plural(blocking.length, 'defect')} block{blocking.length === 1 ? 's' : ''} delivery:{' '}
                    {blocking.map((d) => d.title).join('; ')}
                  </p>
                ) : null}
              </CardBody>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No build has been submitted as a deliverable.</p>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Rollback plan"
              description="How this release is undone if it fails. Recorded on the handover; the sign-off door does not read it."
            />
            {release ? (
              <CardBody>
                {mayWrite ? (
                  <RollbackPlanForm projectId={projectId} handoverId={release.id} current={release.rollbackPlan} />
                ) : release.rollbackPlan ? (
                  <p className="whitespace-pre-line text-[13px] text-muted">{release.rollbackPlan}</p>
                ) : (
                  <p className="text-[13px] text-muted">No rollback plan recorded.</p>
                )}
              </CardBody>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No handover prepared — a rollback plan is recorded on the handover.</p>
            )}
          </Card>

          <Card>
            <CardHeader
              title={`Smoke checklist${smokeTotal > 0 ? ` (${smokeDone}/${smokeTotal})` : ''}`}
              description="What is checked on the deployed candidate. A report the gate summary shows; not a gate."
            />
            {release ? (
              <CardBody>
                <SmokeChecklist
                  projectId={projectId}
                  handoverId={release.id}
                  items={release.smokeChecklist}
                  editable={mayWrite}
                  formatDate={Object.fromEntries(release.smokeChecklist.flatMap((i) => (i.doneAt ? [[i.doneAt, clock.dateTime(i.doneAt)]] : [])))}
                />
              </CardBody>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No handover prepared — the checklist lives on the handover.</p>
            )}
          </Card>

          <Card>
            <CardHeader title="Handover package" />
            {handover ? (
              <>
                <CardBody className="flex flex-col gap-1 text-[13px]">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={handover.status} dot={false} />
                    <span className="text-xs text-muted">started {clock.date(handover.created_at)}</span>
                  </div>
                  {handover.summary ? <p className="text-muted">{handover.summary}</p> : null}
                </CardBody>
                {handover.items.length === 0 ? (
                  <p className="px-4 pb-3 text-xs text-muted sm:px-5">No items in the package yet.</p>
                ) : (
                  <ul className="divide-y divide-line border-t border-line">
                    {handover.items.map((it) => (
                      <li key={it.id} className="flex items-center gap-3 px-4 py-2 text-[13px] sm:px-5">
                        <Badge tone="neutral">{humanize(it.kind)}</Badge>
                        <span className="min-w-0 flex-1 truncate">{it.label}</span>
                        <span className="shrink-0 text-xs text-muted">
                          {it.kind === 'credential' ? `via ${it.transfer_method ?? 'unrecorded'}` : (it.reference ?? '')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">
                No handover prepared. {summary.final_version ? `Final approved version: ${summary.final_version}.` : 'No version has been approved yet.'}
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
