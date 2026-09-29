import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { readRequirementsDashboard } from '@/lib/admin/requirements-dashboard';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProposedRequirements } from '@/modules/crm/queries';
import { Badge, Card, CardHeader, EmptyState, IconCheck, PageHeader, Stat, StatGrid } from '@/ui';

export const metadata: Metadata = { title: 'Requirements' };

function when(clock: AgencyClock, value: string): string {
  return clock.dateTime(value);
}

/**
 * Requirements Dashboard — SCR-028. Every requirement version still
 * awaiting a human decision, across every lead. The decision itself stays
 * on the lead's own page (requirement-decision-form.tsx, which requires
 * opening the specific lead to reach) — this is the cross-lead view of what
 * is waiting, oldest first, so an owner does not have to check every lead
 * to find the ones nobody has answered.
 */
export default async function RequirementsPage() {
  const context = await requireInternal('/requirements');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');
  const clock = await agencyClock();

  const [proposed, dashboard] = await Promise.all([listProposedRequirements(), readRequirementsDashboard()]);
  const openQuestionProjects = dashboard.projectsWithOpenQuestions.length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Requirements"
        description={
          proposed.length === 0
            ? 'Nothing awaiting a decision.'
            : `${proposed.length} requirement version${proposed.length === 1 ? '' : 's'} awaiting accept/reject, oldest first.`
        }
      />

      {/*
        SCR-028's three cross-project counts. Each is a fact a per-project or
        per-lead page already showed one at a time; the dashboard's job is the
        "which ones?" — so every non-zero number opens onto the list beneath.
      */}
      <StatGrid>
        <Stat label="Awaiting a decision" value={String(proposed.length)} tone={proposed.length > 0 ? 'warning' : 'success'} />
        <Stat
          label="Awaiting client confirmation"
          value={String(dashboard.awaitingClientConfirmation)}
          tone={dashboard.awaitingClientConfirmation > 0 ? 'info' : 'neutral'}
        />
        <Stat
          label="Projects with open questions"
          value={String(openQuestionProjects)}
          tone={openQuestionProjects > 0 ? 'warning' : 'success'}
          href={openQuestionProjects > 0 ? '#open-questions' : undefined}
        />
        <Stat
          label="Scope drift alerts"
          value={String(dashboard.scopeDrift.length)}
          tone={dashboard.scopeDrift.length > 0 ? 'danger' : 'success'}
          href={dashboard.scopeDrift.length > 0 ? '#scope-drift' : undefined}
        />
      </StatGrid>

      {openQuestionProjects > 0 ? (
        <Card id="open-questions">
          <CardHeader
            title="Projects with open questions"
            description="A plan question nobody has settled, or a PM Agent clarification nobody has answered. The plan cannot activate, and the agent will not guess, until somebody does."
          />
          <ul className="divide-y divide-line">
            {dashboard.projectsWithOpenQuestions.map((p) => (
              <li key={p.projectId}>
                <Link
                  href={`/projects/${p.projectId}/plan`}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-[13px] hover:bg-surface-hover sm:px-5"
                >
                  <span className="font-medium">{p.projectName}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {p.planQuestions > 0 ? <Badge tone="warning">{p.planQuestions} plan</Badge> : null}
                    {p.pmQuestions > 0 ? <Badge tone="info">{p.pmQuestions} from the PM agent</Badge> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {dashboard.scopeDrift.length > 0 ? (
        <Card id="scope-drift">
          <CardHeader
            title="Scope drift"
            description="A change request raised against a frozen baseline and not yet settled. Until it is classified, decided and applied, what is being built and what was agreed are two different lists."
          />
          <ul className="divide-y divide-line">
            {dashboard.scopeDrift.map((cr) => (
              <li key={cr.changeRequestId}>
                <Link
                  href={`/projects/${cr.projectId}/scope`}
                  className="flex flex-col gap-1 px-4 py-3 text-[13px] hover:bg-surface-hover sm:px-5"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{cr.projectName}</span>
                    <Badge tone="neutral">baseline v{cr.scopeVersion}</Badge>
                    <Badge tone="warning">{cr.status.replace(/_/g, ' ')}</Badge>
                    {cr.classification ? <Badge tone="info">{cr.classification.replace(/_/g, ' ')}</Badge> : null}
                    <span className="ml-auto text-xs text-muted">raised {when(clock, cr.createdAt)}</span>
                  </span>
                  <span className="line-clamp-2 text-muted">“{cr.requested}”</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {proposed.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {proposed.map((r) => (
            <li key={r.id}>
              <Link
                href={`/leads/${r.leadId}`}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-surface-hover sm:px-5"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{r.leadTitle}</span>
                  <Badge tone="neutral">v{r.version}</Badge>
                  <Badge tone={r.source === 'agent' ? 'brand' : 'neutral'}>{r.source}</Badge>
                </span>
                <span className="text-xs text-muted">proposed {when(clock, r.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="Nothing awaiting a decision"
          description="A requirement version proposed by the agent or drafted by hand appears here until an owner accepts or rejects it."
        />
      )}
    </div>
  );
}
