import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getImportBatch } from '@/lib/import/queries';
import type { StagedClassification, StagedRecord } from '@/lib/import/staged';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

import { CommitButton } from '../forms';

export const metadata: Metadata = { title: 'Import batch · AgencyOS' };

const CLASS_LABEL: Record<StagedClassification, string> = {
  exact: 'Exact — updates an existing contact',
  new: 'New — a safe new contact',
  probable: 'Probable — a name match, needs a human',
  conflict: 'Conflict — matches several, needs a human',
  unmatched: 'Unmatched — no phone key, manual review',
};

/**
 * One staged import batch: the exact/new/probable/conflict/unmatched breakdown,
 * every record, and — for a phone-keyed row not yet committed — a Commit button.
 *
 * The commit reuses crm.commit_import_record: idempotent, phone-keyed only, no
 * consent, no send, audited. A name-only row has no button; even were one
 * forged, the database refuses it. Gated on `organization.settings` (owner).
 */
export default async function ImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const context = await requireInternal(`/import/${batchId}`);
  if (!can(context.role, 'organization.settings')) redirect('/dashboard');

  const batch = await getImportBatch(batchId);
  if (!batch) notFound();

  const { summary } = batch;
  const groups = new Map<StagedClassification, StagedRecord[]>();
  for (const r of batch.records) {
    const g = groups.get(r.classification) ?? [];
    g.push(r);
    groups.set(r.classification, g);
  }
  const order: StagedClassification[] = ['exact', 'new', 'probable', 'conflict', 'unmatched'];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <a href="/import" className="text-xs text-muted underline hover:text-foreground">
          ← all imports
        </a>
        <h1 className="text-xl font-semibold tracking-tight">{batch.source_label}</h1>
        <p className="text-sm text-muted">
          {summary.total} records · consent provenance {summary.consentProvenance} — a message is not consent.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Importable', summary.autoImportable],
          ['Committed', summary.committed],
          ['Pending', summary.pending],
          ['Manual review', summary.manualReview],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
            <div className="text-lg font-semibold tabular-nums">{value}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </div>

      {order.map((cls) => {
        const rows = groups.get(cls);
        if (!rows || rows.length === 0) return null;
        return (
          <div key={cls} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">
              {CLASS_LABEL[cls]} <span className="text-muted">({rows.length})</span>
            </h2>
            <ul className="flex flex-col divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/15">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <div className="flex flex-col">
                    <span className="font-medium">{r.display_name}</span>
                    <span className="text-xs text-muted">
                      {r.phone ? <code>{r.phone}</code> : 'no phone — not importable'} · {r.message_count} msgs
                    </span>
                  </div>
                  <div className="text-xs">
                    {r.committed_at ? (
                      <span className="text-emerald-600 dark:text-emerald-400">committed</span>
                    ) : r.auto_importable ? (
                      <CommitButton recordId={r.id} batchId={batch.id} />
                    ) : (
                      <span className="text-muted">manual review — a name is not enough</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
