import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjectFileTree } from '@/modules/projects/files-storage-queries';
import { filterThreads, isWaiting, share, tabOf, type ThreadTab } from '@/modules/projects/project-communication';
import { readProjectMessageCounts, readProjectQueries, readProjectThreads, readThreadMessages } from '@/modules/projects/project-communication-queries';
import { listProjectMembers } from '@/modules/projects/project-members-queries';
import { PROJECT_ROLE_LABEL } from '@/modules/projects/project-members-schema';
import { getProject } from '@/modules/projects/queries';
import {
  Avatar,
  Badge,
  buttonClass,
  Card,
  CardHeader,
  ChatBubble,
  ChatCanvas,
  ChatHeader,
  cx,
  DayDivider,
  DomainSearch,
  EmptyState,
  IconAlert,
  IconAttach,
  IconCalendar,
  IconCheck,
  IconFile,
  IconInbox,
  IconMessage,
  IconSend,
  IconUpload,
  IconUsers,
  PermissionDenied,
  QuickActions,
  Stat,
  StatGrid,
  ViewAll,
} from '@/ui';

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Project Discussion' };

const TABS: { key: ThreadTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'client', label: 'Client' },
  { key: 'internal', label: 'Internal' },
];

function bytes(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function dayLabel(at: Date, now: Date, clock: AgencyClock): string {
  const key = clock.dayKey(at);
  if (key === clock.dayKey(now)) return 'Today';
  if (key === clock.dayKey(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return clock.day(at);
}

/**
 * The project Discussion tab (route stays /communication; reference images 33, 35 and 36): message
 * figures, the conversations this project has, the selected thread read as a
 * WhatsApp conversation, and a rail of members, shared files and quick
 * actions. The thread is READ-ONLY here: a message to the client goes through
 * the project update door on the overview, which runs the consent and
 * 24-hour-window checks — this page does not grow a second sender.
 */
export default async function ProjectCommunicationPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ c?: string; tab?: string; q?: string }> }) {
  const { projectId } = await params;
  const { c, tab: tabRaw, q: qRaw } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/communication`);
  if (!can(context, 'project.read') || !can(context, 'lead.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const now = Date.now();
  const clientName = project.client_account_id ? await readClientName(project.client_account_id) : null;
  const threads = await readProjectThreads(projectId, project.client_account_id, { project: project.name, client: clientName });

  const q = (qRaw ?? '').trim().slice(0, 120);
  const tab: ThreadTab = TABS.some((t) => t.key === tabRaw) ? (tabRaw as ThreadTab) : 'all';
  const shown = filterThreads(threads, tab, q);
  const selected = threads.find((t) => t.id === c) ?? shown[0] ?? null;

  const [counts, queries, members, files, messages] = await Promise.all([
    readProjectMessageCounts(threads.map((t) => t.id), now),
    readProjectQueries(projectId),
    listProjectMembers(projectId),
    listProjectFileTree(projectId),
    selected ? readThreadMessages(selected.id) : Promise.resolve([]),
  ]);
  const mayUpdate = can(context, 'project.write');
  const base = `/projects/${projectId}/communication`;
  const href = (over: { c?: string; tab?: ThreadTab }) => {
    const p = new URLSearchParams();
    const nextTab = over.tab ?? tab;
    if (nextTab !== 'all') p.set('tab', nextTab);
    if (q) p.set('q', q);
    if (over.c) p.set('c', over.c);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const updateHref = `/projects/${projectId}#project-updates`;
  const nowDate = new Date(now);

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        actions={
          mayUpdate ? (
            <Link href={updateHref} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background shadow-xs hover:opacity-90">
              <IconSend size={14} />
              New Message
            </Link>
          ) : null
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat label="Total Messages" value={String(counts.total)} caption={`+${counts.thisWeek} this week`} tone="brand" icon={<IconMessage size={16} />} />
        <Stat label="Client Messages" value={String(counts.client)} caption={`${share(counts.client, counts.total)} of all`} tone="success" icon={<IconInbox size={16} />} />
        <Stat label="Team Messages" value={String(counts.team)} caption={`${share(counts.team, counts.total)} of all`} tone="info" icon={<IconUsers size={16} />} />
        <Stat label="Resolved Queries" value={String(queries.resolved)} caption="Clarifications answered" tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Open Queries" value={String(queries.open)} caption={queries.open > 0 ? 'Needs attention' : 'Nothing waiting'} tone={queries.open > 0 ? 'warning' : 'neutral'} icon={<IconAlert size={16} />} href={`/projects/${projectId}/requirements`} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(16rem,0.9fr)_minmax(0,1.7fr)_minmax(19rem,1fr)]">
        <Card className="flex flex-col">
          <CardHeader title="Conversations" />
          <div className="flex flex-col gap-3 px-4 pb-3 sm:px-5">
            <DomainSearch action={base} value={q} placeholder="Search conversations…" label="Search conversations" preserve={{ tab: tab === 'all' ? undefined : tab }} />
            <nav aria-label="Conversation filter" className="flex flex-wrap gap-1.5">
              {TABS.map((t) => (
                <Link
                  key={t.key}
                  href={href({ tab: t.key })}
                  aria-current={t.key === tab ? 'page' : undefined}
                  className={cx('rounded-lg border px-2.5 py-1 text-[13px] font-medium', t.key === tab ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-foreground')}
                >
                  {t.label}
                  <span className="tabular ml-1.5 text-[11px]">{filterThreads(threads, t.key, '').length}</span>
                </Link>
              ))}
            </nav>
          </div>
          {threads.length === 0 ? (
            <EmptyState
              icon={<IconMessage size={22} />}
              title="No conversation yet"
              description="The project's WhatsApp group appears here once it is linked, and the client's own thread once they write."
              action={
                <Link href={`/projects/${projectId}`} className={buttonClass('secondary', 'sm')}>
                  Open the project
                </Link>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={<IconMessage size={22} />}
              title="No conversation matches"
              description="Nothing fits that filter."
              action={
                <Link href={base} className={buttonClass('secondary', 'sm')}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {shown.map((t) => (
                <li key={t.id}>
                  <Link href={href({ c: t.id })} aria-current={t.id === selected?.id ? 'true' : undefined} className={cx('flex items-start gap-3 px-4 py-3 hover:bg-surface-hover sm:px-5', t.id === selected?.id && 'bg-brand-soft/40')}>
                    <Avatar name={t.title} size="lg" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold">{t.title}</span>
                        <span className="shrink-0 text-[11px] text-muted">{t.lastAt ? clock.date(t.lastAt) : ''}</span>
                      </span>
                      <span className="block truncate text-xs text-muted">{t.lastPreview ?? 'No message yet'}</span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        <Badge tone={tabOf(t.kind) === 'client' ? 'brand' : 'neutral'}>{tabOf(t.kind) === 'client' ? 'Client' : 'Internal'}</Badge>
                        {isWaiting(t) ? <Badge tone="warning" dot>Waiting on you</Badge> : null}
                        <span className="tabular text-[11px] text-muted">{t.messages} message{t.messages === 1 ? '' : 's'}</span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex h-[38rem] min-w-0 flex-col overflow-hidden rounded-xl border border-line shadow-sm">
          {selected ? (
            <>
              <ChatHeader
                name={selected.title}
                status={
                  <>
                    {selected.kind === 'project_group' ? `WhatsApp group · ${members.length} team member${members.length === 1 ? '' : 's'} on the project · ` : ''}
                    {selected.messages} message{selected.messages === 1 ? '' : 's'}
                  </>
                }
              />
              <ChatCanvas>
                {messages.length === 0 ? (
                  <p className="mx-auto my-6 max-w-xs rounded-lg bg-[var(--wa-system)] px-3 py-2 text-center text-[12px] text-[var(--wa-system-fg)]">Nothing recorded in this conversation yet.</p>
                ) : (
                  messages.map((m, i) => {
                    const at = new Date(m.occurredAt);
                    const previous = i > 0 ? messages[i - 1] : undefined;
                    const newDay = !previous || clock.dayKey(new Date(previous.occurredAt)) !== clock.dayKey(at);
                    const startsRun = newDay || previous?.incoming !== m.incoming || previous?.authorName !== m.authorName;
                    return (
                      <div key={m.id} className="contents">
                        {newDay ? <DayDivider>{dayLabel(at, nowDate, clock)}</DayDivider> : null}
                        <ChatBubble
                          outgoing={!m.incoming}
                          author={startsRun ? (m.incoming ? (selected.kind === 'project_group' ? 'Client' : undefined) : (m.authorName ?? 'Team')) : undefined}
                          body={m.body}
                          time={clock.clock(at)}
                          delivery={m.delivery}
                          wire={m.wire}
                          media={m.mediaKind}
                          mediaCaption={m.caption}
                          mediaDescription={m.mediaDescription}
                          tail={startsRun}
                        />
                      </div>
                    );
                  })
                )}
              </ChatCanvas>
              <div className="shrink-0 border-t border-[var(--wa-divider)] bg-[var(--wa-composer)] px-3 py-2.5">
                {mayUpdate ? (
                  <Link href={updateHref} className="flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2 text-[13px] text-muted hover:text-foreground">
                    <span>Replies to the client go through a project update — consent and the 24-hour window are checked there.</span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-brand">
                      <IconSend size={14} />
                      Send Update
                    </span>
                  </Link>
                ) : (
                  <p className="px-1 text-[13px] text-muted">This thread is read-only for your role.</p>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center bg-surface">
              <EmptyState
                icon={<IconMessage size={22} />}
                title="Pick a conversation"
                description="Choose a thread on the left to read it."
                action={
                  <Link href={base} className={buttonClass('secondary', 'sm')}>
                    Show all
                  </Link>
                }
              />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Project Members" actions={<ViewAll href={`/projects/${projectId}/team`} />} />
            {members.length === 0 ? (
              <EmptyState
                icon={<IconUsers size={22} />}
                title="No member chosen"
                description="Choose the project's team on its Team tab."
                action={
                  <Link href={`/projects/${projectId}/team`} className={buttonClass('secondary', 'sm')}>
                    Open team
                  </Link>
                }
              />
            ) : (
              <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
                {members.slice(0, 8).map((m) => (
                  <li key={m.id} className="flex items-center gap-2.5 text-[13px]">
                    <Avatar name={m.fullName} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{m.fullName}</span>
                      <span className="block truncate text-xs text-muted">{PROJECT_ROLE_LABEL[m.projectRole]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Shared Files" actions={<ViewAll href={`/projects/${projectId}/files`} />} />
            {files.length === 0 ? (
              <EmptyState
                icon={<IconFile size={22} />}
                title="No file shared"
                description="Files added to the project appear here."
                action={
                  <Link href={`/projects/${projectId}/files`} className={buttonClass('secondary', 'sm')}>
                    Open files
                  </Link>
                }
              />
            ) : (
              <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
                {files.slice(0, 4).map((f) => (
                  <li key={f.id} className="flex items-center gap-2.5 text-[13px]">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <IconAttach size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{f.title}</span>
                      <span className="block truncate text-xs text-muted">{[bytes(f.latest.sizeBytes), clock.date(f.createdAt)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <QuickActions
            title="Quick Actions"
            actions={[
              ...(mayUpdate ? [{ label: 'Send Update', icon: <IconSend size={13} />, href: updateHref }] : []),
              { label: 'Meetings', icon: <IconCalendar size={13} />, href: '/meetings' },
              { label: 'Upload File', icon: <IconUpload size={13} />, href: `/projects/${projectId}/files` },
              { label: 'Announcements', icon: <IconMessage size={13} />, href: '/communication' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
