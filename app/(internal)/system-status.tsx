'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { cx, TONE_DOT } from '@/ui';

import { readSystemStatusAction, type SystemStatus } from './system-status-actions';

/** Re-read on this cadence: a heartbeat that stops should show within a few minutes, not on the next sign-in. */
const POLL_MS = 5 * 60 * 1000;

/**
 * The header's system-status dot — the shared rule "help/status in header"
 * (bucket F). A dot beside the bell, coloured by the readiness evaluator's
 * own sentence (green ready, amber awaiting verification, red not ready),
 * the sentence itself as the title and the accessible name, and a link to
 * the page that explains it. Fetched after paint so the layout stays free
 * of database reads; grey until the first answer, never green on its own
 * say-so.
 */
export function SystemStatusDot({ canOpen }: { canOpen: boolean }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      readSystemStatusAction()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          if (!cancelled) setStatus({ tone: 'danger', text: 'System status could not be read.', href: '/production-readiness' });
        });
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const label = status ? `System status: ${status.text}` : 'System status: reading…';
  const dot = (
    <span
      aria-hidden
      className={cx('block h-2.5 w-2.5 rounded-full ring-2 ring-surface', status ? TONE_DOT[status.tone] : 'bg-neutral-400')}
    />
  );
  const skin = 'hidden h-10 w-8 shrink-0 items-center justify-center rounded-lg sm:flex';

  return canOpen ? (
    <Link href={status?.href ?? '/production-readiness'} aria-label={label} title={label} className={cx(skin, 'hover:bg-surface-hover')}>
      {dot}
    </Link>
  ) : (
    <span role="status" aria-label={label} title={label} className={skin}>
      {dot}
    </span>
  );
}
