'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { setAgentProjectAssignmentAction, setAgentToolPermissionAction } from '@/modules/agents/permissions-actions';
import type { AgentProjectAssignmentRow, AgentToolPermissionRow } from '@/modules/agents/permissions-queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, selectClass } from '@/ui';

/**
 * SCR-063 — tool permissions and project assignments for one agent, as
 * THIS tenant's policy record. Owner only: the doors refuse everyone else
 * and the page offers the controls to nobody else. Since decision 3 of
 * 2026-09-29 the runner READS these rows: a tool with no record is refused
 * at call time, so "no record" is shown as the refusal it is.
 */

function ToolRow({
  agentKey,
  toolKey,
  bound,
  recorded,
}: {
  agentKey: string;
  toolKey: string;
  /** Whether the agent's definition binds this tool today (what actually runs). */
  bound: boolean;
  recorded: AgentToolPermissionRow | undefined;
}) {
  const [state, action, pending] = useActionState(setAgentToolPermissionAction, IDLE_STATE);
  const allowed = recorded?.allowed ?? null;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
      <span className="flex flex-wrap items-center gap-2">
        <Link href={`/agents/tools/${encodeURIComponent(toolKey)}`} className="underline-offset-2 hover:underline">
          <code className="text-xs">{toolKey}</code>
        </Link>
        {bound ? <Badge tone="info">bound by definition</Badge> : null}
        {allowed === null ? <Badge tone="warning">no record — refused when called</Badge> : allowed ? <Badge tone="success">allowed</Badge> : <Badge tone="danger">denied</Badge>}
        {recorded?.note ? <span className="text-xs text-muted">{recorded.note}</span> : null}
      </span>
      <form action={action} className="flex items-center gap-1">
        <input type="hidden" name="agentKey" value={agentKey} />
        <input type="hidden" name="toolKey" value={toolKey} />
        <button type="submit" name="allowed" value="true" disabled={pending || allowed === true} className={buttonClass('ghost', 'sm')}>
          Allow
        </button>
        <button type="submit" name="allowed" value="false" disabled={pending || allowed === false} className={buttonClass('ghost', 'sm')}>
          Deny
        </button>
        {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
      </form>
    </li>
  );
}

export function ToolPermissionsList({
  agentKey,
  tools,
  boundTools,
  recorded,
  editable,
}: {
  agentKey: string;
  tools: readonly string[];
  boundTools: readonly string[];
  recorded: AgentToolPermissionRow[];
  editable: boolean;
}) {
  const byKey = new Map(recorded.map((r) => [r.toolKey, r]));
  // Recorded keys outside the known list are still shown: a denial should
  // not vanish because the vocabulary moved.
  const keys = [...new Set([...tools, ...recorded.map((r) => r.toolKey)])];
  const bound = new Set(boundTools);

  if (!editable) {
    return (
      <ul className="divide-y divide-line">
        {keys.map((k) => {
          const r = byKey.get(k);
          return (
            <li key={k} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px] sm:px-5">
              {/* SCR-061: the tool's name opens its detail. */}
              <Link href={`/agents/tools/${encodeURIComponent(k)}`} className="underline-offset-2 hover:underline">
                <code className="text-xs">{k}</code>
              </Link>
              {bound.has(k) ? <Badge tone="info">bound by definition</Badge> : null}
              {!r ? <Badge tone="warning">no record — refused when called</Badge> : r.allowed ? <Badge tone="success">allowed</Badge> : <Badge tone="danger">denied</Badge>}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {keys.map((k) => (
        <ToolRow key={k} agentKey={agentKey} toolKey={k} bound={bound.has(k)} recorded={byKey.get(k)} />
      ))}
    </ul>
  );
}

function AssignmentRow({ agentKey, row }: { agentKey: string; row: AgentProjectAssignmentRow }) {
  const [state, action, pending] = useActionState(setAgentProjectAssignmentAction, IDLE_STATE);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="agentKey" value={agentKey} />
      <input type="hidden" name="projectId" value={row.projectId} />
      <button type="submit" name="active" value={row.active ? 'false' : 'true'} disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? '…' : row.active ? 'Withdraw' : 'Reassign'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function ProjectAssignments({
  agentKey,
  assignments,
  projects,
  editable,
}: {
  agentKey: string;
  assignments: AgentProjectAssignmentRow[];
  projects: { id: string; name: string; code: string }[];
  editable: boolean;
}) {
  const [state, action, pending] = useActionState(setAgentProjectAssignmentAction, IDLE_STATE);
  const assigned = new Set(assignments.filter((a) => a.active).map((a) => a.projectId));
  const candidates = projects.filter((p) => !assigned.has(p.id));

  return (
    <div className="flex flex-col gap-2">
      {assignments.length === 0 ? (
        <p className="px-4 pb-2 text-[13px] text-muted sm:px-5">Not assigned to any project.</p>
      ) : (
        <ul className="divide-y divide-line">
          {assignments.map((a) => (
            <li key={a.projectId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
              <span className="flex items-center gap-2">
                <span className={a.active ? 'font-medium' : 'text-muted line-through'}>{a.projectName}</span>
                <span className="font-mono text-xs text-muted">{a.projectCode}</span>
                <Badge tone={a.active ? 'success' : 'neutral'}>{a.active ? 'assigned' : 'withdrawn'}</Badge>
              </span>
              {editable ? <AssignmentRow agentKey={agentKey} row={a} /> : null}
            </li>
          ))}
        </ul>
      )}

      {editable && candidates.length > 0 ? (
        <form action={action} className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-5">
          <input type="hidden" name="agentKey" value={agentKey} />
          <input type="hidden" name="active" value="true" />
          <select name="projectId" required defaultValue="" className={`${selectClass} min-w-48`}>
            <option value="" disabled>
              Choose a project…
            </option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.code})
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Assigning…' : 'Assign'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </form>
      ) : null}
    </div>
  );
}
