'use client';

import { useRef, useState } from 'react';

import { Callout, IconAlert, buttonClass } from '@/ui';

/**
 * "Preview impact before saving" for any high-risk setting form — SCR-071.
 *
 * The wrapped form keeps its own action and its own door; this only moves a
 * pause in front of it. The first submit is caught before the action runs
 * (native validation has already passed) and shows what the change touches —
 * counts the server computed from real rows and handed in as sentences. The
 * person then confirms (the form is submitted for real) or goes back to
 * editing. Nothing is saved before the confirmation, and no second write path
 * exists.
 */
export function ImpactGate({ title, effects, children }: { title: string; effects: readonly string[]; children: React.ReactNode }) {
  const [previewing, setPreviewing] = useState(false);
  const confirmed = useRef(false);
  const pending = useRef<HTMLFormElement | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div
        onSubmitCapture={(event) => {
          if (confirmed.current) {
            confirmed.current = false;
            setPreviewing(false);
            return;
          }
          event.preventDefault();
          pending.current = event.target instanceof HTMLFormElement ? event.target : null;
          setPreviewing(true);
        }}
      >
        {children}
      </div>
      {previewing ? (
        <Callout tone="warning" icon={<IconAlert size={16} />} title={title}>
          <ul className="list-disc pl-4 text-[13px]">
            {effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass('primary', 'sm')}
              onClick={() => {
                confirmed.current = true;
                pending.current?.requestSubmit();
              }}
            >
              Confirm and save
            </button>
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setPreviewing(false)}>
              Keep editing
            </button>
          </div>
        </Callout>
      ) : null}
    </div>
  );
}
