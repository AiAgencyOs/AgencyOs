import { NextResponse } from 'next/server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { readDesignHandoffPackage } from '@/modules/projects/screen-queries';

/**
 * The design handoff package — SCR-038's export. A JSON manifest of every
 * reference asset (record, not pixels), every theme option's Figma
 * reference and preview, the locked handoff, and every deliverable that
 * has an artifact URL. Gated on `project.read` like the page that links
 * it; reads under RLS.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design`);
  if (!can(context.role, 'project.read')) {
    return NextResponse.json({ error: 'You do not have permission to read this project.' }, { status: 403 });
  }

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const pkg = await readDesignHandoffPackage(projectId);
  const slug = (project.code ?? project.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  return new NextResponse(JSON.stringify({ project: { id: project.id, name: project.name, code: project.code }, ...pkg }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}-design-handoff.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
