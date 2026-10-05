import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listConfirmedUnmerged, listHandoffs, listOpenDuplicateReviews, listSubtasks, readIdentitySummary } from '@/modules/acquisition/queries';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { CancelHandoffForm, CancelSubtaskForm, DuplicateDecisionForm, MergeContactsForm, TrackedLinkForm } from '../forms';

export const metadata: Metadata = { title: 'Lead generation identity' };

const REASON: Record<string, string> = {
  shared_key: 'The same email, phone, profile or marketplace id turned up on two different people',
  name_and_domain: 'The same name at the same company domain, with a different email',
  name_and_company: 'The same name at the same company',
};

type Person = { id: string; name: string; email: string | null; phone: string | null; company: string | null; reachableVia: string | null };
function PersonCard({ p }: { p: Person }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line p-3 text-[13px]">
      <span className="font-medium">{p.name}</span>
      <span className="text-muted">{p.email ?? 'no email'}</span>
      <span className="text-muted">{p.phone ?? 'no phone'}{p.reachableVia ? ` · reachable on ${p.reachableVia}` : ''}</span>
      {p.company ? <span className="text-muted">{p.company}</span> : null}
    </div>
  );
}

/**
 * One person across every channel. The system matches on exact keys by itself; this screen is where a person
 * settles the cases it will not decide alone. Deciding records a judgement; joining two records is a separate, explicit step.
 */
export default async function IdentityPage() {
  const context = await requireInternal('/lead-generation/identity');
  if (!can(context, 'acquisition.read')) return <PermissionDenied />;
  const mayManage = can(context, 'acquisition.manage');
  const [{ rows, totalOpen }, confirmed, summary, handoffs, subtasks] = await Promise.all([listOpenDuplicateReviews(), listConfirmedUnmerged(), readIdentitySummary(), listHandoffs(), listSubtasks()]);
  const touches = Object.entries(summary.touchpointsByChannel).sort((a, b) => b[1] - a[1]);
  const keyTotal = Object.values(summary.keys).reduce((a, b) => a + b, 0);
  const touchTotal = touches.reduce((n, [, c]) => n + c, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Lead generation" title="Identity & duplicates" description="The same person reached by email, a social profile, a marketplace and WhatsApp stays one person. Exact matches are joined automatically; doubtful ones wait here for you." />

      <StatGrid>
        <Stat label="Waiting for a decision" value={String(totalOpen)} caption="suspected duplicates" tone={totalOpen > 0 ? 'warning' : 'success'} />
        <Stat label="Identity keys" value={String(keyTotal)} caption={Object.entries(summary.keys).map(([k, n]) => `${n} ${k}`).join(', ') || 'none yet'} tone="neutral" />
        <Stat label="Touchpoints" value={String(touchTotal)} caption={summary.truncated ? 'counted up to 20,000' : 'every way a lead was touched'} tone="info" />
        <Stat label="Conversation owners" value={String(Object.values(summary.ownersByAgent).reduce((a, b) => a + b, 0))} caption={Object.entries(summary.ownersByAgent).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ') || 'none assigned yet'} tone="neutral" />
      </StatGrid>

      <Callout tone="info" title="What deciding does and does not do">
        Choosing “Same person” or “Different people” records your judgement and keeps the history. Joining two records is a separate step below, and only
        for a pair you confirmed: the conversations, leads, meetings and keys move to the one you keep, and the other record stays as history.
        If the two disagree about consent, the safer answer (withdrawn) wins.
      </Callout>

      <Card>
        <CardHeader title="Suspected duplicates" description="Oldest first." />
        <CardBody>
          {rows.length === 0 ? (
            <EmptyState title="Nothing waiting" description="Doubtful matches appear here when a lead arrives that looks like someone you already know." action={<Link href="/leads" className="text-[13px] text-brand hover:underline">Open the leads list</Link>} />
          ) : (
            <ul className="flex flex-col gap-5">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-3 border-b border-line pb-5 last:border-0">
                  <div className="flex items-center gap-2"><Badge tone="warning">Needs a decision</Badge><span className="text-[13px] text-muted">{REASON[r.reason] ?? r.reason}</span></div>
                  <div className="grid gap-3 sm:grid-cols-2"><PersonCard p={r.a} /><PersonCard p={r.b} /></div>
                  {mayManage ? <DuplicateDecisionForm reviewId={r.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {confirmed.length > 0 ? (
        <Card>
          <CardHeader title="Confirmed the same person - not joined yet" description="Choose which record survives. This cannot be undone from here." />
          <CardBody>
            <ul className="flex flex-col gap-5">
              {confirmed.map((r) => (
                <li key={r.id} className="flex flex-col gap-3 border-b border-line pb-5 last:border-0">
                  <div className="grid gap-3 sm:grid-cols-2"><PersonCard p={r.a} /><PersonCard p={r.b} /></div>
                  {mayManage ? <MergeContactsForm a={{ id: r.a.id, name: r.a.name }} b={{ id: r.b.id, name: r.b.name }} /> : null}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Moves to WhatsApp" description={`${handoffs.live} link${handoffs.live === 1 ? '' : 's'} waiting to be used. A used link continues the same lead; if the number belongs to someone else it waits for a decision above.`} />
        <CardBody>
          {handoffs.rows.length === 0 ? (
            <EmptyState title="No handoffs yet" description="An admin creates one below for a lead who is somewhere else; no engine creates them on its own yet." action={<Link href="/lead-generation/settings" className="text-[13px] text-brand hover:underline">Set the WhatsApp number</Link>} />
          ) : (
            <ul className="flex flex-col gap-3">
              {handoffs.rows.map((h) => (
                <li key={h.id} className="flex flex-col gap-2 border-b border-line pb-3 text-[13px] last:border-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-0.5">
                    <Link href={`/leads/${h.leadId}`} className="font-medium text-brand hover:underline">{h.leadTitle}</Link>
                    <span className="text-muted">from {h.sourcePlatform ?? h.sourceChannel.replace('_', ' ')} · {h.status.toLowerCase()}{h.consumeOutcome === 'linked_for_review' ? ' · needs a decision' : ''} · expires {new Date(h.expiresAt).toLocaleDateString('en-IN')}</span>
                  </div>
                  {mayManage && ['CREATED', 'OPENED', 'RESOLVED'].includes(h.status) ? <CancelHandoffForm handoffId={h.id} /> : <Badge tone={h.status === 'CONSUMED' ? 'success' : 'neutral'}>{h.status.toLowerCase()}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {mayManage ? (
        <Card>
          <CardHeader title="Create a tracked WhatsApp link" description="For a lead who is on email, a profile or a marketplace. The link opens WhatsApp with a reference pre-filled, so their first message continues THIS lead instead of opening a second one. It works once and is shown once. A marketplace's own rule decides whether this is allowed for people found there." />
          <CardBody><TrackedLinkForm /></CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Meeting and quotation requests" description={`${subtasks.open} open. An agent asks for a meeting or a quotation; the Scheduler or Quotation Master does only that, and the result goes back to whoever owns the conversation.`} />
        <CardBody>
          {subtasks.rows.length === 0 ? (
            <EmptyState title="No requests yet" description="Only an agent that owns a conversation can ask for these, and no agent is running them yet. A meeting or a quotation is requested the usual way, from the lead." />
          ) : (
            <ul className="flex flex-col gap-3">
              {subtasks.rows.map((t) => (
                <li key={t.id} className="flex flex-col gap-2 border-b border-line pb-3 text-[13px] last:border-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span><Link href={`/leads/${t.leadId}`} className="font-medium text-brand hover:underline">{t.leadTitle}</Link> · {t.kind === 'schedule_meeting' ? 'meeting' : 'quotation'} · {t.status.replace('_', ' ').toLowerCase()}</span>
                    <span className="text-muted">{t.objective} · asked by {t.requestedByOwner.replace('_', ' ')}{t.returnedToOwner ? ` · returned to ${t.returnedToOwner.replace('_', ' ')}` : ''}{t.failureReason ? ` · ${t.failureReason}` : ''}</span>
                  </div>
                  {mayManage && ['REQUESTED', 'IN_PROGRESS'].includes(t.status) ? <CancelSubtaskForm subtaskId={t.id} /> : <Badge tone={t.status === 'COMPLETED' ? 'success' : 'neutral'}>{t.status.toLowerCase()}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Touchpoints by channel" description="Where leads have been touched. First touch is never overwritten by a later channel." />
        <CardBody>
          {touches.length === 0 ? <p className="text-[13px] text-muted">None recorded yet.</p> : (
            <ul className="flex flex-wrap gap-2">{touches.map(([c, n]) => <Badge key={c} tone="neutral">{c.replace('_', ' ')}: {n}</Badge>)}</ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
