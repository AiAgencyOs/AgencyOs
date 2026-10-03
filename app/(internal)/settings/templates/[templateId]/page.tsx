import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProjectTemplate } from '@/modules/projects/project-template-queries';
import { Badge, Card, CardHeader, PermissionDenied } from '@/ui';

import { CloneTemplateButton } from '../templates-panel';

export const metadata: Metadata = { title: 'Template' };

/**
 * SCR-027 "Project template detail": what one saved template carries —
 * modules and their features, milestone percentages, scope items, task titles
 * and the onboarding list — read from its stored snapshot, with a clone.
 */
export default async function TemplateDetailPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const context = await requireInternal(`/settings/templates/${templateId}`);
  if (!can(context, 'organization.settings')) return <PermissionDenied />;

  const [template, clock] = await Promise.all([getProjectTemplate(templateId), agencyClock()]);
  if (!template) notFound();
  const { items } = template;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[13px]">
        <Link href="/settings/templates" className="text-brand hover:underline">Back to templates</Link>
      </p>
      <Card>
        <CardHeader
          title={template.name}
          description={`Saved ${clock.dateTime(template.createdAt)}${template.description ? ` · ${template.description}` : ''}`}
          actions={can(context, 'project.write') ? <CloneTemplateButton templateId={template.id} templateName={template.name} /> : undefined}
        />
        <div className="flex flex-wrap gap-2 px-4 pb-4 sm:px-5">
          {!template.valid ? <Badge tone="danger">unreadable snapshot</Badge> : null}
          <Badge tone="neutral">{template.counts.modules} modules</Badge>
          <Badge tone="neutral">{template.counts.features} features</Badge>
          <Badge tone={template.counts.milestones > 0 && template.milestonePercent !== 100 ? 'warning' : 'neutral'}>{template.counts.milestones} milestones · {template.milestonePercent}%</Badge>
          <Badge tone="neutral">{template.counts.scopeItems} scope items</Badge>
          <Badge tone="neutral">{template.counts.tasks} task titles</Badge>
          <Badge tone="neutral">{template.counts.onboarding} onboarding items</Badge>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Modules and Features" />
          {items.modules.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No modules.</p>
          ) : (
            <ul className="flex flex-col gap-2 px-4 pb-4 text-[13px] sm:px-5">
              {items.modules.map((m) => (
                <li key={m.name}>
                  <span className="font-medium">{m.name}</span>
                  {m.features.length > 0 ? <span className="block text-xs text-muted">{m.features.map((f) => f.name).join(' · ')}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Milestones" description="Percentages of the new project’s budget; a payment plan is written only when they add up to 100." />
          {items.milestones.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No milestones.</p>
          ) : (
            <ul className="flex flex-col gap-1 px-4 pb-4 text-[13px] sm:px-5">
              {items.milestones.map((m) => (
                <li key={m.name} className="flex justify-between gap-3"><span>{m.name}</span><span className="tabular text-muted">{m.percent}%</span></li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Scope Items" />
          {items.scopeItems.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No scope items.</p>
          ) : (
            <ul className="flex flex-col gap-1 px-4 pb-4 text-[13px] sm:px-5">
              {items.scopeItems.map((i) => (
                <li key={i.title} className="flex justify-between gap-3"><span>{i.title}</span><Badge tone={i.inclusion === 'excluded' ? 'neutral' : 'success'} dot={false}>{i.inclusion}</Badge></li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Task Titles" />
          {items.tasks.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No tasks.</p>
          ) : (
            <ul className="flex flex-col gap-1 px-4 pb-4 text-[13px] sm:px-5">
              {items.tasks.map((t, i) => (
                <li key={`${t.title}-${i}`} className="flex justify-between gap-3"><span>{t.title}</span>{t.moduleName ? <span className="text-xs text-muted">{t.moduleName}</span> : null}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {template.sourceProjectId ? (
        <p className="text-xs text-muted">Saved from <Link href={`/projects/${template.sourceProjectId}`} className="underline-offset-2 hover:underline">the source project</Link>.</p>
      ) : null}
    </div>
  );
}
