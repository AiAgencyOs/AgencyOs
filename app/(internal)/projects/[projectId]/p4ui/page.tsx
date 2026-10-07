import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { loadP4uiDesignView, loadP4uiPrototypeView } from '@/modules/projects/p4ui-queries';
import { getProject } from '@/modules/projects/queries';
import { PageHeader, PermissionDenied } from '@/ui';

import { P4uiDesignPanel } from '../p4ui-design-panel';
import { P4uiPrototypePanel } from '../p4ui-prototype-panel';

export const metadata: Metadata = { title: 'UI design and prototype' };

/**
 * UID section 18 / PROTO section 13: the Phase 4 UI Designer and Prototype records for one project, on one staff-only page. Every figure is read from stored
 * rows (a failed read throws rather than rendering as empty), and every form is a door that re-checks its own gate.
 */
export default async function P4uiPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await requireInternal(`/projects/${projectId}/p4ui`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [design, prototype] = await Promise.all([loadP4uiDesignView(projectId), loadP4uiPrototypeView(projectId)]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="UI design and prototype" description={project.name} />
      <section aria-label="UI design" className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">UI Designer</h2>
        <P4uiDesignPanel projectId={projectId} view={design} />
      </section>
      <section aria-label="Prototype" className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Prototype</h2>
        <P4uiPrototypePanel projectId={projectId} view={prototype} />
      </section>
    </div>
  );
}
