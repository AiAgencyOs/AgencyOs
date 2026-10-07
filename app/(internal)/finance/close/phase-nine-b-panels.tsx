import { FINANCE_AGENTS } from '@/modules/finance/phase-nine-proposals';
import { readPhaseNineBControls } from '@/modules/finance/phase-nine-b-queries';
import { cadenceSentence } from '@/modules/finance/phase-nine-b-view';
import { Badge, Card, CardHeader, humanize } from '@/ui';

import { PhaseNineBForm } from './phase-nine-b-form';

/**
 * Phase 9B controls for the finance control centre: the reconciliation schedule (an Admin's cadence, opened by the runner, never closed by it) and the
 * per-organization pause of the three finance agents. The database refuses anyone who is not an Admin; this component only shows the current state.
 *
 * Wiring (the parent adds ONE line to app/(internal)/finance/close/page.tsx, below the projects card): `<PhaseNineBPanels />`
 * (import { PhaseNineBPanels } from './phase-nine-b-panels').
 */
export async function PhaseNineBPanels() {
  const { schedules, dueItems, automation } = await readPhaseNineBControls();
  const pausedBy = new Map(automation.map((a) => [a.agentKey, a]));
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title="Reconciliation schedule" description="When a bank reconciliation period is opened for you. Admin only. It is opened, never closed, by the runner." />
        {schedules.length === 0 ? <p className="text-[13px] text-muted">No schedule is set, so nothing is opened automatically.</p> : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span>{cadenceSentence(s.unit, s.count)} from {s.anchorDate}, source: {s.source}</span>
                <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? 'On' : 'Off'}</Badge>
              </li>
            ))}
          </ul>
        )}
        {dueItems.length > 0 ? (
          <ul className="flex flex-col gap-1 text-[13px] text-muted">
            {dueItems.map((d) => (
              <li key={d.id}>{d.periodStart} to {d.periodEnd}: {d.state === 'opened' ? 'opened' : 'waiting for the account’s open period to be closed'}</li>
            ))}
          </ul>
        ) : null}
        <PhaseNineBForm
          door="set_reconciliation_schedule"
          submit="Set the schedule"
          intro="One schedule per receiving account (leave the account blank for the organization-wide one)."
          fields={[
            { kind: 'text', name: 'accountId', label: 'Receiving account id (optional)' },
            { kind: 'select', name: 'cadenceUnit', label: 'Unit', options: [['day', 'days'], ['week', 'weeks'], ['month', 'months']] },
            { kind: 'number', name: 'cadenceCount', label: 'Every how many', required: true },
            { kind: 'date', name: 'anchorDate', label: 'First period starts on', required: true },
            { kind: 'text', name: 'source', label: 'Source (for example: bank statement)', required: true },
            { kind: 'select', name: 'enabled', label: 'State', options: [['true', 'On'], ['false', 'Off']] },
          ]}
        />
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <CardHeader title="Finance automation" description="Pause or resume the finance agents for this organization. Admin only; a reason is required." />
        <ul className="flex flex-col gap-1 text-[13px]">
          {['all', ...FINANCE_AGENTS].map((key) => {
            const c = pausedBy.get(key);
            return (
              <li key={key} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{key === 'all' ? 'All finance agents' : humanize(key)}</span>
                <Badge tone={c?.paused ? 'danger' : 'success'}>{c?.paused ? 'Paused' : 'Running'}</Badge>
                {c?.paused ? <span className="text-muted">{c.reason}</span> : null}
              </li>
            );
          })}
        </ul>
        <PhaseNineBForm
          door="set_automation_paused"
          submit="Apply"
          fields={[
            { kind: 'select', name: 'agentKey', label: 'Agent', options: [['all', 'All finance agents'], ...FINANCE_AGENTS.map((a): [string, string] => [a, humanize(a)])] },
            { kind: 'select', name: 'paused', label: 'Action', options: [['true', 'Pause'], ['false', 'Resume']] },
            { kind: 'text', name: 'reason', label: 'Why', required: true },
          ]}
        />
      </Card>
    </div>
  );
}
