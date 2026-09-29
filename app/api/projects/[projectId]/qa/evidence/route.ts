import { NextResponse } from 'next/server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { readQaEvidence } from '@/modules/qa/dashboard-queries';

/**
 * The QA evidence summary — SCR-044's export. One CSV with two sections:
 * every test run (suite, build, counts, tester, when, evidence link) and
 * every defect (severity, status, resolution, verification). Gated on
 * `project.read` like the QA tab; reads under RLS, so a role that cannot
 * see the project gets a 404 rather than an empty sheet.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/qa`);
  if (!can(context, 'project.read')) {
    return NextResponse.json({ error: 'You do not have permission to read this project.' }, { status: 403 });
  }

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const evidence = await readQaEvidence(projectId);

  const lines: string[] = [
    ['section', 'id', 'suite_or_severity', 'build_or_status', 'title', 'total', 'passed', 'failed', 'skipped', 'tester_or_assignee', 'executed_or_raised_at', 'verified_at', 'resolution', 'evidence_url'].join(','),
    ...evidence.runs.map((r) =>
      [
        'run',
        r.id,
        r.suite,
        `v${r.deliverableVersion} ${r.deliverableTitle}`,
        '',
        r.total,
        r.passed,
        r.failed,
        r.skipped,
        r.tester ? (r.tester.kind === 'person' ? r.tester.name : `agent:${r.tester.key}`) : '',
        r.executedAt,
        '',
        '',
        r.evidenceUrl,
      ]
        .map(cell)
        .join(','),
    ),
    ...evidence.defects.map((d) =>
      [
        'defect',
        d.id,
        d.severity,
        d.status,
        d.title,
        '',
        '',
        '',
        '',
        d.assigneeId,
        d.created_at,
        d.verified_at,
        d.resolution,
        d.evidence_url,
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
      'Content-Disposition': `attachment; filename="${slug}-qa-evidence.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
