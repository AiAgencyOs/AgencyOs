'use client';

import { useRouter } from 'next/navigation';

import { selectClass } from '@/ui';

/** The period picker: a plain select that navigates, keeping the other filters. */
export function PeriodSelect({
  value,
  options,
  preserve,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  preserve: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const known = options.some((o) => o.value === value);

  return (
    <select
      aria-label="Period"
      className={selectClass}
      value={value}
      onChange={(e) => {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(preserve)) if (v) p.set(k, v);
        if (e.target.value !== 'all') p.set('period', e.target.value);
        const s = p.toString();
        router.push(`/finance/tax${s ? `?${s}` : ''}`);
      }}
    >
      {!known ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
