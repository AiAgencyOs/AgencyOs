'use client';

import { useState } from 'react';

import { buttonClass } from '@/ui';

/**
 * Copies a record's id to the clipboard — SCR-002's "copy reference".
 *
 * The clipboard API is only available in a secure context and may refuse;
 * the button says so rather than pretending. Nothing here reaches the
 * server: the id was already on the page.
 */
export function CopyIdButton({ id, label = 'Copy ID' }: { id: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1500);
  };

  return (
    <button type="button" onClick={copy} className={buttonClass('ghost', 'sm')} title={id} aria-label={`${label} ${id}`}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Clipboard refused' : label}
    </button>
  );
}
