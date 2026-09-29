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
import { readDeploymentDependencies } from '@/modules/projects/deployment-deps-queries';
import { listReleasePaymentOverrides, readFinalPaymentState } from '@/modules/projects/release-payment-queries';
import { readPerformanceSummary, readSecuritySummary } from '@/modules/qa/summary-queries';
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
import { DeploymentDependencies } from './deployment-deps-panel';
import { OverrideReleasePaymentForm } from './release-payment-panel';

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
  // Decision F1 (2026-09-30) and SCR-049 (bucket F): the payment gate as the
  // door reads it, the owner's overrides, deployment dependencies, and the
  // security and performance summaries beside the QA one.
  const [paymentState, overrides, deployment, security, performance] = await Promise.all([
    readFinalPaymentState(projectId),
    listReleasePaymentOverrides(projectId),
    readDeploymentDependencies(projectId),
    readSecuritySummary(projectId),
    readPerformanceSummary(projectId),
  ]);
  const paymentGateOpen = paymentState.state === 'verified' || paymentState.state === 'overridden' || paymentState.state === 'no_priced_milestone';

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

  // Decision F1 (2026-09-30): the final payment IS a hard gate now —
  // mark_production_ready answers payment_unverified until the final priced
  // milestone's invoice is paid, net-verified or carries a verified claim, or
  // an owner override is recorded. The ladder stays as the wider picture.
  const paymentItem: GateItem = {
    key: 'payment',
    label: 'Final payment verified',
    hardGate: true,
    href: paymentState.invoiceId ? `/invoices/${paymentState.invoiceId}` : base,
    hrefLabel: paymentState.invoiceId ? `Invoice ${paymentState.invoiceNumber ?? ''}` : 'Overview · payment ladder',
    ...(paymentState.state === 'verified'
      ? { mark: 'pass', fact: `The final milestone "${paymentState.milestoneName ?? ''}" is paid or verified (invoice ${paymentState.invoiceNumber ?? ''}).${ladder?.measurable ? ` ${ladder.verifiedPercent ?? 0}% of the plan is verified overall.` : ''}` }
      : paymentState.state === 'overridden'
        ? { mark: 'pass', fact: `Overridden by the owner${overrides[0] ? ` ${clock.dateTime(overrides[0].createdAt)}${overrides[0].overriddenByName ? ` (${overrides[0].overriddenByName})` : ''}: "${overrides[0].reason}"` : ''}. Audited as release.payment_overridden.` }
        : paymentState.state === 'no_priced_milestone'
          ? { mark: 'unknown', fact: 'No priced milestone on this project, so there is no final payment to verify; the door does not gate on it.' }
          : paymentState.state === 'no_invoice'
            ? { mark: 'fail', fact: `The final milestone "${paymentState.milestoneName ?? ''}" has no live invoice. Raise and issue it, then verify the payment — or the owner records an override with a reason.` }
            : { mark: 'fail', fact: `Invoice ${paymentState.invoiceNumber ?? ''} for the final milestone "${paymentState.milestoneName ?? ''}" is not paid, net-verified or claim-verified yet.` }),
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
    ...(paymentGateOpen ? [] : [`the final payment is not verified (${paymentState.invoiceNumber ?? 'no invoice'})`]),
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
                    Decision F1 (2026-09-30): the final payment is part of the door — sign-off is refused until it is verified, or the owner records an override with a reason. Test runs and the handover stay reports beside it; a release hold is the one thing a person adds on top.
                  </p>
                  {maySignOff ? <ProductionReadyForm projectId={projectId} /> : <p className="text-xs text-muted">Signing off needs project.sign_off (owner or ops admin).</p>}
                </>
              )}
            </CardBody>
          </Card>

          {/* Decision F1: the owner's override, drawn only while the gate refuses and only for the owner; the door decides both again. */}
          {!paymentGateOpen ? (
            <Card>
              <CardHeader title="Payment gate" description="The door refuses payment_unverified. The owner may override it with a reason; the override is kept and audited." />
              <CardBody>
                {context.role === 'owner' ? <OverrideReleasePaymentForm projectId={projectId} /> : <p className="text-[13px] text-muted">Only the owner may override the payment gate.</p>}
              </CardBody>
            </Card>
          ) : overrides.length > 0 ? (
            <Card>
              <CardHeader title="Payment gate overrides" description="Recorded by the owner; audited release.payment_overridden." />
              <ul className="divide-y divide-line">
                {overrides.map((o) => (
                  <li key={o.id} className="px-4 py-2 text-[13px] sm:px-5">
                    <span className="block whitespace-pre-wrap">{o.reason}</span>
                    <span className="text-xs text-muted">{clock.dateTime(o.createdAt)}{o.overriddenByName ? ` · ${o.overriddenByName}` : ''}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* SCR-049 (bucket F): deployment dependencies on the handover — a report beside the gate. */}
          <Card>
            <CardHeader title="Deployment dependencies" description="What the deployment waits on — DNS, a vendor key, a client sign-off. Recorded on the handover; the sign-off door does not read it." />
            <CardBody>
              {deployment ? (
                <DeploymentDependencies projectId={projectId} handoverId={deployment.handoverId} dependencies={deployment.dependencies} editable={mayWrite} />
              ) : (
                <p className="text-[13px] text-muted">No handover has been prepared, so there is nowhere to record them yet.</p>
              )}
            </CardBody>
          </Card>

          {/* SCR-049 (bucket F): security and performance summaries beside the QA one. */}
          <Card>
            <CardHeader title="Security summary" description="Security-suite runs and open defects that read as security issues (by their title). A report." />
            <CardBody className="text-[13px]">
              {security.latest ? (
                <p>
                  Latest security run {clock.dateTime(security.latest.executedAt)}: {security.latest.passed}/{security.latest.total} passed{security.latest.failed > 0 ? <span className="text-danger">, {security.latest.failed} failed</span> : null}
                  {security.latest.evidenceUrl ? <> · <a href={security.latest.evidenceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">evidence</a></> : null}
                  {' '}· {security.runs} closed run{security.runs === 1 ? '' : 's'} in all.
                </p>
              ) : (
                <p className="text-muted">No security-suite run has been closed on this project.</p>
              )}
              <p className={`mt-1 ${security.openSecurityDefects > 0 ? 'text-danger' : 'text-muted'}`}>{security.openSecurityDefects} open defect{security.openSecurityDefects === 1 ? '' : 's'} read as security issues.</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Performance summary" description="Budgets against the latest attached metrics, performance-suite runs and stability incidents. A report — Doc 14 §16 leaves the threshold with the project." actions={<ViewAll href={`${base}/qa`} label="QA" />} />
            <CardBody className="text-[13px]">
              <p>
                {performance.budgets.length === 0 ? 'No performance budget set.' : `${performance.budgets.length} budget${performance.budgets.length === 1 ? '' : 's'}: `}
                {performance.budgets.length > 0 ? (
                  <>
                    <span className={performance.overBudget > 0 ? 'text-danger' : 'text-success'}>{performance.overBudget} over</span>, {performance.budgets.length - performance.overBudget - performance.unmeasured} within, {performance.unmeasured} unmeasured.
                  </>
                ) : null}
              </p>
              <p className="mt-1 text-muted">{performance.runs} performance run{performance.runs === 1 ? '' : 's'} · <span className={performance.incidentsOpen > 0 ? 'text-danger' : ''}>{performance.incidentsOpen} open incident{performance.incidentsOpen === 1 ? '' : 's'}</span> of {performance.incidentsTotal}.</p>
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
