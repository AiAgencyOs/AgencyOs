import { NextResponse } from 'next/server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { listScreenInventory } from '@/modules/projects/design-export-queries';

/**
 * The screen inventory as a CSV — SCR-034's export.
 *
 * Gated exactly as the design page is (`project.read`), and reads under the
 * same RLS: a role that cannot see the project gets a 404, not an empty
 * sheet. `attachment`, because a CSV is for opening elsewhere. A refused or
 * failed read throws to the route's error path rather than serving an
 * empty file that would say "no screens".
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS = [
  'screen_key',
  'name',
  'status',
  'user_role',
  'purpose',
  'entry_point',
  'exit_action',
  'required_sections',
  'required_data',
  'actions',
  'validation',
  'dependencies',
  'responsive_behaviour',
  'accessibility_notes',
  'permission_behaviour',
  'has_empty_state',
  'has_loading_state',
  'has_error_state',
  'has_success_state',
  'baseline_version',
  'scope_items',
  'created_at',
  'updated_at',
] as const;

function cell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/design`);
  if (!can(context, 'project.read')) {
    return NextResponse.json({ error: 'You do not have permission to read this project.' }, { status: 403 });
  }

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const screens = await listScreenInventory(projectId);

  const lines = [
    COLUMNS.join(','),
    ...screens.map((s) =>
      [
        s.screenKey,
        s.name,
        s.status,
        s.userRole,
        s.purpose,
        s.entryPoint,
        s.exitAction,
        s.requiredSections,
        s.requiredData,
        s.actions,
        s.validation,
        s.dependencies,
        s.responsiveBehaviour,
        s.accessibilityNotes,
        s.permissionBehaviour,
        s.hasEmptyState,
        s.hasLoadingState,
        s.hasErrorState,
        s.hasSuccessState,
        s.baselineVersion,
        s.scopeItems.join('; '),
        s.createdAt,
        s.updatedAt,
      ]
        .map(cell)
        .join(','),
    ),
  ];

  const slug = (project.code ?? project.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return new NextResponse(`\uFEFF${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}-screens.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
