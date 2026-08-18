import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { listImportBatches } from '@/lib/import/queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

export const metadata: Metadata = { title: 'Import · AgencyOS' };

const WHEN = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Historical-lead import — the owner's review desk.
 *
 * A WhatsApp export is parsed and classified off-database and STAGED (the
 * `import:whatsapp:stage` loader); this is where an owner sees what a batch
 * holds and commits the safe rows. Read the batches RLS-scoped; the batch page
 * does the committing. Gated on `organization.settings` (owner) — the same
 * capability the reactivation surface uses; the database independently admits
 * owner or ops_admin.
 *
 * What this page will never show is a lead that was messaged: staging and
 * committing create identity (contact + lead) only, set no consent, and send
 * nothing.
 */
export default async function ImportPage() {
  const context = await requireInternal('/import');
  if (!can(context.role, 'organization.settings')) redirect('/dashboard');

  const batches = await listImportBatches();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Historical-lead import</h1>
        <p className="text-sm text-muted">
          Batches staged from WhatsApp exports. Only phone-keyed rows can be committed; a name is never
          enough. Committing creates a contact and a lead — it sets no consent and sends nothing, so an
          imported lead is not reactivation-eligible until consent is separately recorded.
        </p>
      </div>

      {batches.length === 0 ? (
        <p className="rounded-lg border border-black/10 px-4 py-8 text-center text-sm text-muted dark:border-white/15">
          No import has been staged. Run <code>npm run import:whatsapp:stage -- --org &lt;id&gt; &lt;export&gt;</code> to
          stage one for review.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {batches.map((b) => (
            <li key={b.id} className="rounded-lg border border-black/10 px-4 py-3 text-sm dark:border-white/15">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <a href={`/import/${b.id}`} className="font-medium underline hover:text-foreground">
                  {b.source_label}
                </a>
                <span className="text-xs text-muted">{WHEN.format(new Date(b.created_at))}</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {b.summary.total} records · {b.summary.autoImportable} importable ({b.summary.committed} committed
                {b.summary.pending > 0 ? `, ${b.summary.pending} pending` : ''}) · {b.summary.manualReview} manual
                review · consent {b.summary.consentProvenance}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
