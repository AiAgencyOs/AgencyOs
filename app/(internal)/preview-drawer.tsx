'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { EntityPreview } from '@/lib/admin/entity-preview-types';
import { Badge, buttonClass, DetailList, DetailRow, Drawer, Skeleton, StatusBadge } from '@/ui';

import { previewEntityAction } from './preview-actions';

/**
 * The shared quick-preview drawer — SCR-002 "Quick preview drawer" (bucket
 * F, stream F-A), one component for the /search page and the ⌘K palette.
 * It reads the entity's header through `previewEntityAction` when opened
 * — name, status chip, subtitle, facts — under the record's own capability
 * and RLS, and offers "Open" to the record's page. A refusal is shown as
 * the reader's own sentence, never as an empty panel.
 *
 * `PreviewDrawerProvider` mounts one drawer; `usePreview()` hands any
 * descendant an `open(group, id)`; `PreviewButton` is the usual trigger.
 */
type Target = { group: string; id: string };

const PreviewContext = createContext<{ open: (target: Target) => void } | null>(null);

export function usePreview() {
  return useContext(PreviewContext);
}

export function PreviewDrawerProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [preview, setPreview] = useState<EntityPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    setError(null);
    previewEntityAction(target.group, target.id)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setPreview(r.data);
        else setError(r.error.message);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'The preview could not be read.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const open = useCallback((t: Target) => setTarget(t), []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <PreviewContext.Provider value={value}>
      {children}
      <Drawer
        open={target !== null}
        onClose={() => setTarget(null)}
        title={preview?.name ?? (loading ? 'Reading…' : 'Preview')}
        description={preview ? `${preview.group}${preview.subtitle ? ` · ${preview.subtitle}` : ''}` : target ? target.group : undefined}
        footer={
          preview ? (
            <Link href={preview.href} className={buttonClass('primary', 'sm')} onClick={() => setTarget(null)}>
              Open {preview.group.toLowerCase()}
            </Link>
          ) : undefined
        }
      >
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : error ? (
          <p className="text-[13px] text-danger">{error}</p>
        ) : preview ? (
          <div className="flex flex-col gap-4">
            {preview.status ? (
              <div>
                <StatusBadge status={preview.status} />
              </div>
            ) : null}
            {preview.facts.length > 0 ? (
              <DetailList>
                {preview.facts.map((f) => (
                  <DetailRow key={f.label} label={f.label} value={f.value} />
                ))}
              </DetailList>
            ) : (
              <p className="text-[13px] text-muted">Nothing more is recorded on this record yet.</p>
            )}
            <p className="text-[11px] text-faint">
              <Badge tone="neutral">{preview.group}</Badge> <span className="font-mono">{preview.id.slice(0, 8)}</span>
            </p>
          </div>
        ) : null}
      </Drawer>
    </PreviewContext.Provider>
  );
}

/** The "Preview" trigger a result row carries. Renders nothing outside a provider. */
export function PreviewButton({ group, id, className }: { group: string; id: string; className?: string }) {
  const ctx = usePreview();
  if (!ctx) return null;
  return (
    <button type="button" onClick={() => ctx.open({ group, id })} className={className ?? buttonClass('ghost', 'sm')}>
      Preview
    </button>
  );
}
