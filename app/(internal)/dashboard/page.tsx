import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { capabilitiesFor } from '@/lib/authz/permissions';

export const metadata: Metadata = { title: 'Dashboard · AgencyOS' };

/**
 * Placeholder. Feature 5 (Owner Dashboard) replaces this with real content;
 * for now it proves the auth gate, claims, and capability model end to end.
 */
export default async function DashboardPage() {
  const context = await requireInternal('/dashboard');
  const capabilities = capabilitiesFor(context.role);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted">Signed in as {context.email}</p>
      </div>

      <dl className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Role', value: context.role ?? '—' },
          { label: 'Organisation', value: context.organizationId?.slice(0, 8) ?? '—' },
          { label: 'Capabilities', value: String(capabilities.length) },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
          >
            <dt className="text-xs uppercase tracking-wide text-muted">{item.label}</dt>
            <dd className="mt-1 font-mono text-sm">{item.value}</dd>
          </div>
        ))}
      </dl>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Your capabilities</h2>
        <ul className="flex flex-wrap gap-2">
          {capabilities.map((capability) => (
            <li
              key={capability}
              className="rounded-md border border-black/10 px-2 py-1 font-mono text-xs text-muted dark:border-white/15"
            >
              {capability}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
