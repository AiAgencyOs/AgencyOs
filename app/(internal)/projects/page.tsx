import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjects } from '@/modules/projects/queries';

export const metadata: Metadata = { title: 'Projects · AgencyOS' };

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function money(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

/** Delivery pipeline. Same two-layer gate as the other internal pages. */
export default async function ProjectsPage() {
  const context = await requireInternal('/projects');
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const projects = await listProjects();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted">
          {projects.length === 0
            ? 'No projects yet. Winning a deal on a lead creates one.'
            : `${projects.length} project${projects.length === 1 ? '' : 's'}.`}
        </p>
      </div>

      {projects.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
          <table className="w-full min-w-[42rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left dark:border-white/15">
                {['Project', 'Status', 'Budget', 'Created'].map((h) => (
                  <th key={h} className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-b border-black/5 last:border-0 dark:border-white/10">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/projects/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{money(p.budget_minor, p.currency)}</td>
                  <td className="px-4 py-3 text-muted">{DATE.format(new Date(p.created_at))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-black/15 px-4 py-8 text-center text-sm text-muted dark:border-white/20">
          Projects created from won deals will appear here.
        </p>
      )}
    </div>
  );
}
