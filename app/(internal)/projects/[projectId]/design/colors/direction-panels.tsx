'use client';

import { useActionState } from 'react';

import { recordColorVariantAction, recordThemeDirectionAction } from '@/modules/projects/design-direction-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-033 — a person records a theme direction and a colour variant beside
 * the generated ones (migration 20261001130000). Thin wrappers over the
 * server actions; the 2–3 ceiling and the finalized-baseline rule are the
 * database's and its refusal is shown verbatim. "Generate" has no door for
 * a person: the agent draws on the finalized screen baseline (a job), so
 * the panel says so rather than offering a button that would enqueue
 * nothing.
 */

export function RecordDirectionPanel({ projectId, nextIndex, limit, taken }: { projectId: string; nextIndex: number; limit: number | null; taken: number }) {
  const [state, action, pending] = useActionState(recordThemeDirectionAction, IDLE_STATE);
  const full = limit !== null && taken >= limit;
  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="text-[13px] font-medium">
        Record a theme direction{' '}
        <span className="font-normal text-muted">
          — {taken} of {limit ?? '2–3'} recorded{full ? '; the ceiling is reached' : ''}
        </span>
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[6rem_1fr]">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Option</label>
          <input name="optionIndex" type="number" min={1} max={5} defaultValue={nextIndex} required className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Name</label>
          <input name="name" required maxLength={120} className={inputClass} placeholder="e.g. Quiet editorial" />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Direction</label>
        <textarea name="directionSummary" required maxLength={2000} rows={3} className={textareaClass} placeholder="What the direction is, in a few sentences." />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || full} className={buttonClass('primary', 'sm')}>
          {pending ? 'Recording…' : 'Record direction'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
      <p className="text-xs text-muted">Generation is the design agent&apos;s, drawn on the finalized screen baseline; a person records a direction here beside those, under the same ceiling.</p>
    </form>
  );
}

export function RecordVariantPanel({ projectId, themes }: { projectId: string; themes: { id: string; name: string; nextIndex: number }[] }) {
  const [state, action, pending] = useActionState(recordColorVariantAction, IDLE_STATE);
  if (themes.length === 0) return null;
  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="text-[13px] font-medium">Record a colour variant</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_6rem_1fr]">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Direction</label>
          <select name="themeOptionId" className={selectClass} required>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (next palette {t.nextIndex})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Palette</label>
          <input name="optionIndex" type="number" min={1} max={5} defaultValue={themes[0]?.nextIndex ?? 1} required className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Name</label>
          <input name="paletteName" required maxLength={120} className={inputClass} placeholder="e.g. Warm neutrals" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Primary</label>
          <input name="primaryHex" required pattern="#[0-9a-fA-F]{6}" className={inputClass} placeholder="#1A2B3C" />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Secondary</label>
          <input name="secondaryHex" pattern="#[0-9a-fA-F]{6}" className={inputClass} placeholder="optional" />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Accent</label>
          <input name="accentHex" pattern="#[0-9a-fA-F]{6}" className={inputClass} placeholder="optional" />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Contrast notes</label>
        <input name="contrastNotes" maxLength={2000} className={inputClass} placeholder="Optional — what was checked, not a WCAG claim" />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Recording…' : 'Record variant'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
