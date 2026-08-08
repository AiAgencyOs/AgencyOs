import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getLatestConversation,
  getLeadHeader,
  listMessages,
  listRequirementVersions,
} from '@/modules/crm/queries';
import { requirementPayloadSchema } from '@/modules/crm/schema';

import { ExtractionForm, MessageForm } from './message-form';
import { StartConversationForm } from './start-form';

export const metadata: Metadata = { title: 'Requirement collection · AgencyOS' };

const TIME = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const AUTHOR_LABEL: Record<string, string> = {
  client: 'Customer',
  user: 'Staff',
  agent: 'Agent',
  system: 'System',
};

/**
 * Requirement collection for one lead: the transcript, and the requirement
 * versions extracted from it.
 *
 * Same two-layer gate as the leads list — capability re-checked here because
 * a URL can be typed, and RLS refuses the rows regardless.
 */
export default async function LeadConversationPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;

  const context = await requireInternal(`/leads/${leadId}`);
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const lead = await getLeadHeader(leadId);
  if (!lead) notFound();

  const conversation = await getLatestConversation(leadId);
  const messages = conversation ? await listMessages(conversation.id) : [];
  const versions = conversation ? await listRequirementVersions(conversation.id) : [];
  const mayWrite = can(context.role, 'lead.write');

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">Requirement collection</p>
        <h1 className="text-xl font-semibold tracking-tight">{lead.title}</h1>
        <p className="text-sm text-muted">
          {lead.status} · {lead.source}
          {lead.summary ? ` · ${lead.summary}` : ''}
        </p>
      </header>

      {!conversation ? (
        <section className="flex flex-col gap-3 rounded-lg border border-dashed border-black/15 px-4 py-6 dark:border-white/20">
          <p className="text-sm text-muted">No conversation yet for this lead.</p>
          {mayWrite ? <StartConversationForm leadId={leadId} /> : null}
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">
              Transcript{' '}
              <span className="text-muted">
                ({messages.length} message{messages.length === 1 ? '' : 's'} · {conversation.channel})
              </span>
            </h2>

            {messages.length === 0 ? (
              <p className="text-sm text-muted">Nothing recorded yet.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted">
                        {AUTHOR_LABEL[m.author_type] ?? m.author_type}
                      </span>
                      <span className="font-mono text-xs text-muted">
                        {TIME.format(new Date(m.occurred_at))}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}

            {mayWrite ? <MessageForm conversationId={conversation.id} leadId={leadId} /> : null}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Extracted requirements</h2>

            {versions.length === 0 ? (
              <p className="text-sm text-muted">
                None yet. Extraction runs as a queued job and records a version here.
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {versions.map((v) => {
                  const parsed = requirementPayloadSchema.safeParse(v.payload);
                  return (
                    <li
                      key={v.id}
                      className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-xs font-medium">v{v.version}</span>
                        <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                          {v.status}
                        </span>
                        <span className="text-xs text-muted">by {v.source}</span>
                        <span className="ml-auto font-mono text-xs text-muted">
                          {TIME.format(new Date(v.created_at))}
                        </span>
                      </div>

                      {parsed.success ? (
                        <div className="mt-2 flex flex-col gap-2 text-sm">
                          <p>{parsed.data.summary}</p>
                          {parsed.data.scopeItems.length > 0 ? (
                            <ul className="list-inside list-disc text-muted">
                              {parsed.data.scopeItems.map((s) => (
                                <li key={s.title}>{s.title}</li>
                              ))}
                            </ul>
                          ) : null}
                          {parsed.data.openQuestions.length > 0 ? (
                            <p className="text-xs text-muted">
                              {parsed.data.openQuestions.length} open question
                              {parsed.data.openQuestions.length === 1 ? '' : 's'}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-muted">
                          Stored payload does not match the current requirement schema.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            {mayWrite ? <ExtractionForm conversationId={conversation.id} leadId={leadId} /> : null}
          </section>
        </>
      )}
    </div>
  );
}
