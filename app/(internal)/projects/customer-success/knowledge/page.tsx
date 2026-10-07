import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { G1DoorForm } from '@/modules/projects/phase-eight-g1-form';
import { readKnowledgeArticles } from '@/modules/projects/phase-eight-g1-queries';
import { Badge, Card, CardHeader, PageHeader, PermissionDenied, humanize, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Support knowledge base' };

const TONE: Record<string, Tone> = { draft: 'warning', approved: 'success', retired: 'neutral' };

/**
 * The approved knowledge base Support answers from. A draft is proposed by a person or the support agent; only a DIFFERENT Admin approves it; an approved article
 * is never edited (a change is a new version). No price or discount is allowed in an article.
 */
export default async function SupportKnowledgePage() {
  const context = await requireInternal('/projects/customer-success/knowledge');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const articles = await readKnowledgeArticles();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Support knowledge base"
        description="Approved answers Support may cite. Drafts wait for a different Admin."
        actions={
          <Link href="/projects/customer-success" className="text-[13px] underline">
            Back to the accounts
          </Link>
        }
      />
      <Card>
        <CardHeader title="Propose an article" description="Use an existing key to propose a new version of that article." />
        <div className="px-4 pb-4 sm:px-5">
          <G1DoorForm
            door="knowledge_propose"
            submit="Save as draft"
            fields={[
              { kind: 'text', name: 'key', label: 'Key (lower-case, hyphens)', required: true },
              { kind: 'text', name: 'title', label: 'Title', required: true },
              { kind: 'textarea', name: 'body', label: 'The answer (no prices, no secrets)', required: true },
              { kind: 'checkbox', name: 'clientSafe', label: 'Show to clients in their portal once approved' },
            ]}
          />
        </div>
      </Card>
      {articles.map((a) => (
        <Card key={a.id}>
          <CardHeader
            title={`${a.title} (v${a.version})`}
            description={`${a.key}${a.proposedByAgent ? ` - proposed by the ${humanize(a.proposedByAgent)} agent` : ''}${a.clientSafe ? ' - client-visible' : ''}`}
            actions={<Badge tone={TONE[a.status] ?? 'neutral'}>{humanize(a.status)}</Badge>}
          />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <p className="whitespace-pre-wrap text-sm">{a.body}</p>
            {a.status === 'retired' && a.retireReason ? <p className="text-[13px] text-muted">Retired: {a.retireReason}</p> : null}
            {a.status === 'draft' ? <G1DoorForm door="knowledge_approve" hidden={{ articleId: a.id }} submit="Approve (a different Admin than the author)" /> : null}
            {a.status !== 'retired' ? (
              <G1DoorForm door="knowledge_retire" hidden={{ articleId: a.id }} fields={[{ kind: 'text', name: 'reason', label: 'Why retire it', required: true }]} submit="Retire" />
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
