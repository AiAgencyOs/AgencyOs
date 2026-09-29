import { Fragment } from 'react';

import { ROLES } from '@/lib/auth/claims';
import { CAPABILITIES, can } from '@/lib/authz/permissions';
import { IconCheck } from '@/ui';

/**
 * The capability model, rendered — SCR-069. Roles across, capabilities down,
 * each cell answered by the same `can()` every page and service calls, so
 * this table cannot drift from what is enforced. Read-only: the matrix is
 * code (`src/lib/authz/permissions.ts`), changed by a review, not a screen.
 * RLS is the other half and is not summarised here; the checks above are
 * its evidence.
 */
export function PermissionMatrix() {
  const groups = new Map<string, string[]>();
  for (const cap of CAPABILITIES) {
    const group = cap.split('.')[0] ?? cap;
    groups.set(group, [...(groups.get(group) ?? []), cap]);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2 font-normal sm:px-5">Capability</th>
            {ROLES.map((r) => (
              <th key={r} className="px-2 py-2 text-center font-normal">
                {r.replace('_', ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([group, caps]) => (
            <Fragment key={group}>
              <tr className="border-b border-line bg-surface-sunken">
                <td colSpan={ROLES.length + 1} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted sm:px-5">
                  {group}
                </td>
              </tr>
              {caps.map((cap) => (
                <tr key={cap} className="border-b border-line">
                  <td className="px-4 py-1.5 font-mono text-xs sm:px-5">{cap}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="px-2 py-1.5 text-center">
                      {can(r, cap as (typeof CAPABILITIES)[number]) ? (
                        <span className="inline-flex text-success" aria-label={`${r} may ${cap}`}>
                          <IconCheck size={14} />
                        </span>
                      ) : (
                        <span className="text-faint" aria-label={`${r} may not ${cap}`}>
                          ·
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
