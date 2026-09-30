import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { normaliseSearch } from '@/lib/db/search';
import { can } from '@/lib/authz/permissions';
import { listProjectTemplates } from '@/modules/projects/project-template-queries';
import { Badge, buttonClass, Card, CardHeader, DomainSearch, EmptyState, IconPortfolio, SearchSummary } from '@/ui';

import { CloneTemplateButton, DeleteTemplateButton } from './templates-panel';

export const metadata: Metadata = { title: 'Templates' };

/**
 * Settings › Templates. Decision: reversed by the owner on 2026-09-29.
 * Every project template the organization has saved, what each carries,
 * and a delete for the owner. A template is made on a project's own page
 * ("Save as template") and used from Quick Create ("From template"); this
 * screen only lists and removes.
 */
export default async function SettingsTemplatesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const context = await requireInternal('/settings/templates');
  // Search within domain (bucket G-3): name or description, filtered by the reader.
  const { q: qRaw } = await searchParams;
  const q = normaliseSearch(qRaw);
  const [templates, clock] = await Promise.all([listProjectTemplates(q || undefined), agencyClock()]);
  const mayDelete = can(context, 'organization.settings');
  const mayClone = can(context, 'project.write');

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Project templates"
          description={`${templates.length} template${templates.length === 1 ? '' : 's'}. Save one from a project's header; start a project from one in Quick Create (⌘K → Create project → From template).`}
        />
        {/* Search within domain (bucket G-3): name or description, filtered by the reader. */}
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5">
          <DomainSearch action="/settings/templates" value={q} placeholder="Search name or description…" label="Search templates" />
          <SearchSummary q={q} count={templates.length} clearHref="/settings/templates" />
        </div>
        {templates.length === 0 ? (
          <EmptyState
            icon={<IconPortfolio size={22} />}
            title={q ? 'No matching template' : 'No templates yet'}
            description={q ? `No template matches ‘${q}’.` : 'Open a project and choose “Save as template” to snapshot its structure.'}
            action={q ? <Link href="/settings/templates" className={buttonClass('secondary', 'sm')}>Clear search</Link> : <Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>}
          />
        ) : (
          <ul className="divide-y divide-line">
            {templates.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <Link href={`/settings/templates/${t.id}`} className="truncate text-sm font-medium hover:underline">{t.name}</Link>
                      {!t.valid ? <Badge tone="danger">unreadable</Badge> : null}
                      {t.counts.milestones > 0 && t.milestonePercent !== 100 ? <Badge tone="warning">milestones {t.milestonePercent}%</Badge> : null}
                    </span>
                    <span className="block text-xs text-muted">
                      {t.counts.modules} module{t.counts.modules === 1 ? '' : 's'} · {t.counts.features} feature{t.counts.features === 1 ? '' : 's'} · {t.counts.milestones} milestone{t.counts.milestones === 1 ? '' : 's'} · {t.counts.scopeItems} scope item{t.counts.scopeItems === 1 ? '' : 's'} · {t.counts.tasks} task title{t.counts.tasks === 1 ? '' : 's'} · {t.counts.onboarding} onboarding item{t.counts.onboarding === 1 ? '' : 's'}
                    </span>
                    <span className="block text-xs text-muted">
                      Saved {clock.dateTime(t.createdAt)}
                      {t.createdByName ? ` by ${t.createdByName}` : ''}
                      {t.sourceProjectId ? (
                        <>
                          {' · from '}
                          <Link href={`/projects/${t.sourceProjectId}`} className="underline-offset-2 hover:underline">
                            the source project
                          </Link>
                        </>
                      ) : ' · source project since removed'}
                    </span>
                    {t.description ? <p className="mt-1 text-[13px]">{t.description}</p> : null}
                  </div>
                  <span className="flex flex-wrap items-center gap-3">
                    <Link href={`/settings/templates/${t.id}`} className="text-xs text-brand hover:underline">Details</Link>
                    {mayClone ? <CloneTemplateButton templateId={t.id} templateName={t.name} /> : null}
                    {mayDelete ? <DeleteTemplateButton templateId={t.id} /> : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-muted">
        A template's milestones are percentages; a payment plan is written on a new project only when they add up to exactly 100%. The onboarding checklist is kept on the template for reference — a project's checklist is seeded from the organization's baseline when it starts.
      </p>
    </div>
  );
}
