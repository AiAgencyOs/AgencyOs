import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listDesignClarifications } from '@/modules/projects/p13-design-clarifications';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/ui';

import { AnswerForm, AskedForm } from './clarification-forms';

export const metadata: Metadata = { title: 'Design clarifications' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * P3-PM-005: what design needs answered. The designer raises a question; a person asks the client (this page sends nothing) and records the client's own
 * words with a message reference; the answer returns to design. Every state is shown, including questions still waiting to be asked.
 */
export default async function DesignClarificationsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await requireInternal(`/projects/${projectId}/design-clarifications`);
  if (!UUID.test(projectId)) return <EmptyState title="Unknown project" description="That is not a project id." />;
  const mayWrite = can(context, 'project.write');
  const rows = await listDesignClarifications(projectId);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Design clarifications" description="Questions design cannot proceed without. Asking the client and recording the answer is a person's step." />
      {rows.length === 0 ? <EmptyState title="Nothing to clarify" description="Design has raised no open questions for this project." /> : null}
      {rows.map((c) => (
        <Card key={c.id}>
          <CardHeader title={c.question} description={c.screen_ref ? `Screen: ${c.screen_ref}` : 'Applies to the whole design'} />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <div className="flex flex-wrap gap-2">
              <Badge tone={c.status === 'answered' ? 'success' : c.status === 'asked' ? 'warning' : 'neutral'}>{c.status}</Badge>
              <Badge tone="neutral">{c.raised_by_type === 'designer_agent' ? 'raised by the designer' : 'raised by a person'}</Badge>
            </div>
            {c.status === 'asked' || c.status === 'answered' ? (
              <p className="text-sm text-muted">
                Asked by {c.asked_via} (reference {c.asked_evidence}).
              </p>
            ) : null}
            {c.status === 'answered' ? (
              <p className="text-sm">
                Client's answer: {c.answer} <span className="text-muted">(reference {c.answer_evidence})</span>
              </p>
            ) : null}
            {mayWrite && c.status === 'open' ? <AskedForm id={c.id} projectId={projectId} /> : null}
            {mayWrite && c.status === 'asked' ? <AnswerForm id={c.id} projectId={projectId} /> : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
