import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readCategoryCadence, readLiveAccounts, readContactPreference, readProjectFeedback, readProjectGoals } from '@/modules/projects/phase-eight-gaps2-queries';
import { Badge, Card, CardHeader, PageHeader, PermissionDenied, humanize } from '@/ui';

import { Gaps2Form } from './gaps2-forms';

export const metadata: Metadata = { title: 'Customer Success records' };

const CHANNELS: [string, string][] = [['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'Portal'], ['call', 'Call'], ['meeting', 'Meeting']];
const PURPOSES: [string, string][] = [['operational', 'Operational'], ['relationship', 'Relationship'], ['commercial', 'Commercial']];

/**
 * What a person heard and decided, recorded through the doors: contact preferences, the message-category cadence (Admin), client feedback and client
 * goals. Nothing here is inferred, scored or sent. One account at a time (`?project=`) keeps every read bounded.
 */
export default async function CustomerSuccessRecordsPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const context = await requireInternal('/projects/customer-success/records');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const { project } = await searchParams;
  const [accounts, cadence] = await Promise.all([readLiveAccounts(), readCategoryCadence()]);
  const selected = accounts.find((a) => a.projectId === project) ?? null;
  const [feedback, goals, preference] = selected
    ? await Promise.all([readProjectFeedback(selected.projectId), readProjectGoals(selected.projectId), selected.clientAccountId ? readContactPreference(selected.clientAccountId) : Promise.resolve(null)])
    : [[], [], null];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Customer Success records"
        description="Preferences, cadence, feedback and goals: what a person recorded. Nothing here is inferred, scored or sent."
        actions={<Link href="/projects/customer-success" className="text-[13px] underline">Back to the accounts</Link>}
      />

      <Card>
        <CardHeader title="Message cadence" description="Minimum days between two contacts of the same category to one client. No row means no rule: there is no default number." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          <div className="flex flex-wrap gap-2">
            {cadence.length === 0 ? <span className="text-[13px] text-muted">No cadence set.</span> : cadence.map((c) => <Badge key={c.purpose} tone="info">{humanize(c.purpose)}: {c.minGapDays} days</Badge>)}
          </div>
          <Gaps2Form door="set_cadence" submit="Set cadence (Admin)" fields={[{ kind: 'select', name: 'purpose', label: 'Category', options: PURPOSES }, { kind: 'number', name: 'minGapDays', label: 'Minimum gap in days (0-365)', required: true }]} />
          <Gaps2Form door="clear_cadence" submit="Clear cadence (Admin)" fields={[{ kind: 'select', name: 'purpose', label: 'Category', options: PURPOSES }]} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Account" description="Choose a live account to read and record against." />
        <div className="flex flex-wrap gap-2 px-4 pb-4 sm:px-5">
          {accounts.length === 0 ? <span className="text-[13px] text-muted">No live accounts.</span> : accounts.map((a) => (
            <Link key={a.projectId} href={`/projects/customer-success/records?project=${a.projectId}`} className={`rounded-md border px-2 py-1 text-[13px] ${selected?.projectId === a.projectId ? 'border-brand' : 'border-line'}`}>{a.name}</Link>
          ))}
        </div>
      </Card>

      {selected ? (
        <>
          <Card>
            <CardHeader title="How this client wants to be reached" description={preference ? `Preferred: ${preference.preferredChannel ?? 'none'}. Avoid: ${preference.avoidChannels.join(', ') || 'none'}. Language: ${preference.language ?? 'not recorded'}.` : 'Nothing recorded yet.'} />
            {selected.clientAccountId ? (
              <div className="px-4 pb-4 sm:px-5">
                <Gaps2Form door="set_preference" hidden={{ clientId: selected.clientAccountId }} submit="Save preference" fields={[
                  { kind: 'select', name: 'preferredChannel', label: 'Preferred channel', options: [['', 'No preference'], ...CHANNELS] },
                  { kind: 'select', name: 'avoidChannels', label: 'Channel to avoid', options: [['', 'None to avoid'], ...CHANNELS] },
                  { kind: 'text', name: 'language', label: 'Language code (en, pt-BR)' },
                  { kind: 'text', name: 'note', label: 'Note' },
                ]} />
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Feedback heard" description="What the client said, as a person heard it." />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {feedback.length === 0 ? <p className="text-[13px] text-muted">None recorded.</p> : (
                <ul className="flex flex-col gap-1 text-[13px]">{feedback.map((f) => <li key={f.id}><Badge tone={f.sentiment === 'negative' ? 'danger' : f.sentiment === 'positive' ? 'success' : 'neutral'}>{humanize(f.sentiment)}</Badge> {f.occurredAt.slice(0, 10)} via {f.source}: {f.summary}</li>)}</ul>
              )}
              <Gaps2Form door="record_feedback" hidden={{ projectId: selected.projectId }} submit="Record feedback" fields={[
                { kind: 'select', name: 'source', label: 'Source', options: [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'Portal'], ['meeting', 'Meeting'], ['survey', 'Survey']] },
                { kind: 'select', name: 'sentiment', label: 'Sentiment', options: [['positive', 'Positive'], ['neutral', 'Neutral'], ['negative', 'Negative'], ['mixed', 'Mixed']] },
                { kind: 'textarea', name: 'summary', label: 'What was said', required: true },
              ]} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Client goals" description="What the client said they want to achieve." />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {goals.length === 0 ? <p className="text-[13px] text-muted">None recorded.</p> : (
                <ul className="flex flex-col gap-1 text-[13px]">{goals.map((g) => <li key={g.id}><Badge tone={g.status === 'active' ? 'info' : g.status === 'achieved' ? 'success' : 'neutral'}>{humanize(g.status)}</Badge> {g.goal}{g.statusNote ? ` (${g.statusNote})` : ''}</li>)}</ul>
              )}
              <Gaps2Form door="record_goal" hidden={{ projectId: selected.projectId }} submit="Record goal" fields={[{ kind: 'textarea', name: 'goal', label: 'The goal', required: true }]} />
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
