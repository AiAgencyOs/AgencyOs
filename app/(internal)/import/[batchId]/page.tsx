import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getImportBatch, importRelationshipPreview } from '@/lib/import/queries';
import { reactivationStatus, type StagedClassification, type StagedRecord } from '@/lib/import/staged';
import { requireInternal } from '@/lib/auth/session';
import { IconArrowLeft } from '@/ui';
import { can } from '@/lib/authz/permissions';

import { CommitButton } from '../forms';

export const metadata: Metadata = { title: 'Import batch' };

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
/** What each stored class is called on screen. */
const RELATIONSHIP_LABELS: Readonly<Record<string, string>> = {
  client: 'Current clients',
  active_deal: 'Live deals',
  nurture: 'Asked us to come back',
  lost: 'Previously lost',
  previously_quoted: 'Previously quoted',
  previously_replied: 'Previously replied',
  has_conversation: 'Have written to us',
  cold: 'Known, no history',
  unknown: 'New to us',
};

export default async function ImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const context = await requireInternal(`/import/${batchId}`);
  if (!can(context.role, 'organization.settings')) redirect('/dashboard');

  const batch = await getImportBatch(batchId);
  if (!batch) notFound();

  const { summary } = batch;
  // G-211 — refuses on a failed read rather than showing an empty preview,
  // because "nobody in this file is a client" is the most dangerous sentence
  // this surface could say when the database did not answer.
  const relationships = await importRelationshipPreview(batchId);
  const consented = new Set(batch.contactsWithConsent);
  const groups = new Map<StagedClassification, StagedRecord[]>();
  for (const r of batch.records) {
    const g = groups.get(r.classification) ?? [];
    g.push(r);
    groups.set(r.classification, g);
  }
  const order: StagedClassification[] = ['exact', 'new', 'probable', 'conflict', 'unmatched'];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link
          href="/import"
          className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground"
        >
          <IconArrowLeft size={14} />
          All imports
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{batch.source_label}</h1>
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
          {summary.total} records · consent provenance {summary.consentProvenance} — a message is not consent.
        </p>
      </div>

      {/*
        Who these people already are — G-211, and it goes ABOVE the identity
        counts deliberately.
        `Importable / Pending / Manual review` answer "can we file this row?".
        This answers "may we write to this person?", which is the question that
        matters before a campaign and the one nobody could see the answer to.
      */}
      {relationships.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Who is already in this file</h2>
          <p className="text-xs text-muted">
            From what this system has recorded, not from a guess. A client, a live deal, or somebody
            who asked us to come back on a date is never written to by a campaign.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {relationships.map((r) => (
              <div key={r.relationship} className="rounded-lg border border-line bg-surface px-3 py-2">
                <div className="text-lg font-semibold tabular">{r.records}</div>
                <div className="text-xs text-muted">
                  {RELATIONSHIP_LABELS[r.relationship] ?? r.relationship}
                  {r.contactable ? null : ' · never contacted'}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Importable', summary.autoImportable],
          ['Committed', summary.committed],
          ['Pending', summary.pending],
          ['Manual review', summary.manualReview],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className="text-lg font-semibold tabular">{value}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </div>

      {order.map((cls) => {
        const rows = groups.get(cls);
        if (!rows || rows.length === 0) return null;
        return (
          <div key={cls} className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              {CLASS_LABEL[cls]} <span className="text-muted">({rows.length})</span>
            </h2>
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <div className="flex flex-col">
                    <span className="font-medium">{r.display_name}</span>
                    <span className="text-xs text-muted">
                      {r.phone ? <code>{r.phone}</code> : 'no phone — not importable'} · {r.message_count} msgs
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 text-xs">
                    {r.committed_at ? (
                      (() => {
                        const status = reactivationStatus(r, r.committed_contact_id !== null && consented.has(r.committed_contact_id));
                        return (
                          <>
                            <span className="text-success">
                              committed{' '}
                              {r.committed_lead_id ? (
                                <a href={`/leads/${r.committed_lead_id}`} className="underline hover:text-foreground">
                                  → lead
                                </a>
                              ) : null}
                            </span>
                            {status.applicable ? (
                              status.eligible ? (
                                <span className="text-muted">reactivation: eligible</span>
                              ) : (
                                <span className="text-warning" title={status.reason}>
                                  reactivation: blocked — no consent
                                </span>
                              )
                            ) : null}
                          </>
                        );
                      })()
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
