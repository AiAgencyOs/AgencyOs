import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import Link from 'next/link';

import { formatCostMinor, whyNotRun } from '@/lib/admin/agent-eval';
import { listAgentProjectAssignments, listAgentToolPermissions } from '@/modules/agents/permissions-queries';
import { listAgentPolicyRefusals } from '@/modules/agents/refusals-queries';
import { KNOWN_TOOL_KEYS, boundToolKeysFor } from '@/modules/agents/permissions-schema';
import { latestAgentValidation } from '@/modules/agents/validation-queries';
import { listProjects } from '@/modules/projects/queries';
import { listAgentFailures, listAgentPromptVersions } from '@/lib/admin/agent-metrics';
import { getAgent, listAgentRuns } from '@/lib/admin/agent-status';
import { hasConfiguredProvider } from '@/lib/ai/router';
import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Callout, Card, CardHeader, DetailList, DetailRow, EmptyState, IconAgents, PageHeader, StatusBadge, PermissionDenied } from '@/ui';

import { AgentCapsForm, AgentStatusForm } from './controls-form';
import { ProjectAssignments, ToolPermissionsList } from './policy-panel';
import { ValidateAgentForm } from './validate-form';

export const metadata: Metadata = { title: 'Agent' };

function money(minor: number): string {
  const major = formatCostMinor(minor);
  return major ? `₹${major}` : '₹0';
}

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * Agent Detail — SCR-063. The registry row plus its run history, both
 * already-existing reads (aiStatus, ai.agent_runs) just never drilled into
 * from one agent.
 *
 * ADM-82 — Decision: reversed by the owner on 2026-09-29. Activation and the
 * two ceilings are now the owner's to set from this page, through
 * `ai.set_agent_status` / `ai.set_agent_caps` (audited). Everyone else sees
 * the values read-only, with the reason stated beside them.
 *
 * Decision 3 of the same day: the tool permissions and project assignments
 * below are ENFORCED by the runner, and what it refused is listed here.
 */
export default async function AgentDetailPage({ params }: { params: Promise<{ agentKey: string }> }) {
  const { agentKey } = await params;

  const context = await requireInternal(`/agents/${agentKey}`);
  const clock = await agencyClock();
  if (!can(context.role, 'audit.read')) return <PermissionDenied />;

  const [agent, runs, providerConfigured] = await Promise.all([
    getAgent(agentKey),
    listAgentRuns(agentKey),
    hasConfiguredProvider(),
  ]);
  if (!agent) notFound();
  // SCR-063: the failures on their own, the prompt versions the runs
  // actually carried, and the guardrails as the registry states them.
  const [failures, promptVersions, validation] = await Promise.all([
    listAgentFailures(agentKey),
    listAgentPromptVersions(agentKey),
    // SCR-062: the last time a person validated this agent (ai.agent_validations).
    latestAgentValidation(agentKey),
  ]);
  // SCR-063 — this tenant's policy record for the agent (20260929170000).
  // Owner only to write: the doors refuse everyone else, so nobody else is
  // offered the controls.
  const mayEditPolicy = context.role === 'owner' && can(context.role, 'organization.settings');
  const [toolPermissions, assignments, projects, refusals] = await Promise.all([
    listAgentToolPermissions(agentKey),
    listAgentProjectAssignments(agentKey),
    mayEditPolicy ? listProjects(200) : Promise.resolve([]),
    // Decision 3 (2026-09-29): what the runner refused under this policy.
    listAgentPolicyRefusals(agentKey),
  ]);
  const boundTools = boundToolKeysFor(agentKey);

  const blocked = whyNotRun(agent, providerConfigured);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={agent.displayName}
        description={agent.description ?? undefined}
        meta={
          <Badge tone={blocked ? 'neutral' : 'success'} dot>
            {blocked ? `would not run — ${blocked}` : 'would run'}
          </Badge>
        }
      />

      <Card>
        <CardHeader title="Configuration" />
        <DetailList className="px-4 sm:px-5">
          <DetailRow label="Key" value={<code className="text-xs">{agent.key}</code>} />
          <DetailRow label="Enabled" value={agent.enabled ? 'yes' : 'no'} />
          {!agent.enabled && agent.disabledReason ? <DetailRow label="Disabled reason" value={agent.disabledReason} /> : null}
          <DetailRow label="Autonomy" value={agent.autonomyLevel} />
          <DetailRow label="Default model" value={agent.defaultModel ?? '—'} />
          <DetailRow label="Default effort" value={agent.defaultEffort ?? '—'} />
          <DetailRow label="Max steps" value={agent.maxSteps ?? '—'} />
          <DetailRow label="Max cost per run" value={agent.maxCostMinor !== null ? money(agent.maxCostMinor) : '—'} />
          <DetailRow label="Configuration version" value={agent.definitionVersion ? <code className="text-xs">{agent.definitionVersion}</code> : 'never stamped'} />
          <DetailRow label="Last validated" value={agent.lastValidatedAt ? when(clock, agent.lastValidatedAt) : 'never'} />
        </DetailList>
        {/* ADM-82 — Decision: reversed by the owner on 2026-09-29. */}
        {mayEditPolicy ? (
          <div className="flex flex-col gap-4 border-t border-line px-4 py-4 sm:px-5">
            <AgentStatusForm agentKey={agent.key} enabled={agent.enabled} />
            <AgentCapsForm agentKey={agent.key} maxSteps={agent.maxSteps} maxCostMinor={agent.maxCostMinor} />
          </div>
        ) : (
          <p className="border-t border-line px-4 py-3 text-xs text-muted sm:px-5">
            Enabling, disabling and the ceilings are the owner&apos;s to change (ADM-82, reversed 2026-09-29); shown read-only for your role.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Configuration validation"
          description="The same checks the cron stamp and verify-agent-definitions run — definition, revision, model, ceilings, tools, handoff and verifier mirrors — recorded for this organisation. Nothing on the registry row is changed."
          actions={can(context.role, 'audit.read') ? <ValidateAgentForm agentKey={agent.key} /> : undefined}
        />
        {validation ? (
          <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
            <p className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={validation.outcome === 'ok' ? 'success' : 'danger'} dot>
                {validation.outcome === 'ok' ? 'ok' : 'problems'}
              </Badge>
              <span className="text-muted">
                last validated by a person {when(clock, validation.validatedAt)}
                {validation.validatedByName ? ` by ${validation.validatedByName}` : ''} · registry <code className="text-xs">{validation.registryRevision}</code>
              </span>
            </p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {validation.findings.map((f) => (
                <li key={f.check} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-[13px]">
                  <span className="flex items-center gap-2">
                    <Badge tone={f.ok ? 'success' : 'danger'}>{f.ok ? 'ok' : 'problem'}</Badge>
                    <span className="font-medium">{f.check.replace('_', ' ')}</span>
                  </span>
                  <span className={`min-w-0 flex-1 text-right text-xs ${f.ok ? 'text-muted' : 'text-danger'}`}>{f.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No person has validated this agent yet. The stamp above is the cron tick&apos;s.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Guardrails" description="What this agent may and may not do, as the registry states it. The ceilings above are enforced by the runtime per run." />
        <div className="px-4 pb-4 text-[13px] leading-relaxed sm:px-5">
          {agent.description ? <p className="whitespace-pre-line">{agent.description}</p> : <p className="text-muted">The registry holds no description for this agent.</p>}
          <p className="mt-3 text-xs text-muted">
            Autonomy <span className="text-foreground">{agent.autonomyLevel}</span> · at most{' '}
            <span className="text-foreground">{agent.maxSteps ?? '—'}</span> steps and{' '}
            <span className="text-foreground">{agent.maxCostMinor !== null ? money(agent.maxCostMinor) : '—'}</span> per run. Tool permissions and project
            assignments are this organisation's policy record, below.
          </p>
        </div>
      </Card>

      <Callout tone="info" title="Enforced by the runner">
        The tool permissions and project assignments below are rows this organisation owns (ai.agent_tool_permissions, ai.agent_project_assignments)
        and the runner reads them before every call (decision 3, 2026-09-29). A tool with no allowing record is refused at call time — no record is a
        refusal, not a default — on top of what the agent&apos;s definition binds and its autonomy admits. An agent assigned to any project works only on
        those; assigned to none, on all. Every refusal is recorded below and in the audit log.
      </Callout>

      <Card>
        <CardHeader
          title="Tool permissions"
          description={mayEditPolicy ? 'Allow or deny each tool for this agent, in this organisation. A tool with no record is refused when called. Owner only.' : 'What the owner has recorded for this agent. A tool with no record is refused when called. Only the owner may change it.'}
        />
        <ToolPermissionsList agentKey={agent.key} tools={KNOWN_TOOL_KEYS} boundTools={boundTools} recorded={toolPermissions} editable={mayEditPolicy} />
      </Card>

      <Card>
        <CardHeader
          title="Project assignments"
          description={mayEditPolicy ? 'Which projects this agent is assigned to. Withdrawn rather than deleted, so a past assignment stays visible. Owner only.' : 'Which projects this agent is assigned to. Only the owner may change it.'}
        />
        <ProjectAssignments
          agentKey={agent.key}
          assignments={assignments}
          projects={projects.map((p) => ({ id: p.id, name: p.name, code: p.code ?? '' }))}
          editable={mayEditPolicy}
        />
      </Card>

      <Card>
        <CardHeader
          title="Refusals"
          description={
            refusals.length === 0
              ? 'Nothing has been refused under this organisation’s policy.'
              : `${refusals.length} most recent thing${refusals.length === 1 ? '' : 's'} the runner refused this agent, newest first.`
          }
        />
        {refusals.length > 0 ? (
          <ul className="divide-y divide-line">
            {refusals.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="danger">{r.kind.replace('_', ' ')}</Badge>
                    {r.toolKey ? <code className="text-xs">{r.toolKey}</code> : null}
                    {r.projectId ? (
                      <Link href={`/projects/${r.projectId}`} className="underline-offset-2 hover:underline">
                        {r.projectName ?? r.projectId.slice(0, 8)}
                      </Link>
                    ) : null}
                    {r.runId ? (
                      <Link href={`/usage/runs/${r.runId}`} className="font-mono text-xs text-muted underline-offset-2 hover:underline">
                        run {r.runId.slice(0, 8)}
                      </Link>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted">{when(clock, r.createdAt)}</span>
                </div>
                <p className="break-words text-muted">{r.reason}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Prompt versions" description="The prompt each run was stamped with — a change is visible as the version the runs carry, not as a claim." />
        {promptVersions.length > 0 ? (
          <ul className="divide-y divide-line">
            {promptVersions.map((p) => (
              <li key={`${p.promptKey}@${p.promptVersion}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                <span className="flex items-center gap-2">
                  <code className="text-xs">{p.promptKey ?? 'unnamed prompt'}</code>
                  <Badge tone="neutral" mono>{p.promptVersion ?? 'unversioned'}</Badge>
                </span>
                <span className="tabular text-xs text-muted">{p.runs} run{p.runs === 1 ? '' : 's'} · last {when(clock, p.lastUsedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No run has been recorded, so no prompt version has been stamped.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Failures" description={failures.length === 0 ? 'No failed run recorded.' : `${failures.length} most recent failed run${failures.length === 1 ? '' : 's'}, the error as the runtime wrote it.`} />
        {failures.length > 0 ? (
          <ul className="divide-y divide-line">
            {failures.map((f) => (
              <li key={f.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Link href={`/usage/runs/${f.id}`} className="font-mono text-xs underline-offset-2 hover:underline">{f.id.slice(0, 8)}</Link>
                    <span className="text-muted">{f.trigger}</span>
                    {f.subjectType ? <span className="text-xs text-muted">{f.subjectType} {f.subjectId ? f.subjectId.slice(0, 8) : ''}</span> : null}
                  </span>
                  <span className="text-xs text-muted">{f.model ?? '—'}{f.promptVersion ? ` · prompt ${f.promptVersion}` : ''} · {when(clock, f.createdAt)}</span>
                </div>
                <p className="break-words text-danger">{f.error ?? 'No error was recorded, which is itself worth investigating.'}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Recent runs" description={runs.length === 0 ? undefined : `${runs.length} most recent`} />
        {runs.length > 0 ? (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[13px] sm:px-5">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    <span className="text-muted">{r.trigger}</span>
                  </span>
                  {r.error ? <span className="text-xs text-danger">{r.error}</span> : null}
                </span>
                <span className="flex items-center gap-3 text-xs text-muted">
                  <span>{r.model ?? '—'}</span>
                  <span className="tabular">{r.stepCount} step{r.stepCount === 1 ? '' : 's'}</span>
                  <span className="tabular">{money(r.costMinor)}</span>
                  <span>{when(clock, r.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<IconAgents size={20} />} title="No runs recorded yet" />
        )}
      </Card>
    </div>
  );
}
