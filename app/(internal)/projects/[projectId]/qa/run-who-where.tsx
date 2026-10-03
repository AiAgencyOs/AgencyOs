'use client';

import { useId } from 'react';

import { RUN_ENVIRONMENTS } from '@/modules/qa/schema';
import { labelClass, selectClass } from '@/ui';

export type TesterOption = { userId: string; fullName: string };

const ENVIRONMENT_LABEL: Record<(typeof RUN_ENVIRONMENTS)[number], string> = {
  development: 'Development',
  staging: 'Staging',
  production: 'Production',
  other: 'Other',
};

/**
 * SCR-046's "Build / environment" and "Tester": where the build ran, and who
 * ran the suite. Both are optional at the form; the tester defaults to the
 * person recording, and the database refuses an environment outside the list
 * or a tester who is not on the team (`qa.open_test_run`, `qa.record_test_run`).
 */
export function RunWhereAndWhoInputs({ testers, compact = false }: { testers: readonly TesterOption[]; compact?: boolean }) {
  const id = useId();
  const field = compact ? `${selectClass} h-8 text-xs` : selectClass;
  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-env`} className={labelClass}>Environment</label>
        <select id={`${id}-env`} name="environment" defaultValue="" className={field}>
          <option value="">Not recorded</option>
          {RUN_ENVIRONMENTS.map((e) => (
            <option key={e} value={e}>{ENVIRONMENT_LABEL[e]}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-tester`} className={labelClass}>Tester</label>
        <select id={`${id}-tester`} name="testerId" defaultValue="" className={field}>
          <option value="">Me</option>
          {testers.map((t) => (
            <option key={t.userId} value={t.userId}>{t.fullName}</option>
          ))}
        </select>
      </div>
    </>
  );
}
