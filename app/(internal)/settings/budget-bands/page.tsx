import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { bandLines, describeBudget, STARTING_BANDS } from '@/modules/crm/budget-bands';
import { readBudgetBands } from '@/modules/crm/budget-bands-queries';
import { Card, CardHeader } from '@/ui';

import { BudgetBandsForm } from './bands-form';

export const metadata: Metadata = { title: 'Budget Bands' };

const SAMPLE_MINOR = 7_500_000;

/**
 * Settings › Budget bands (owner decision Q-BAND, round 3): the bands a lead's
 * budget is shown in. Editable by the owner and ops admin through
 * `crm.set_budget_bands`; the lead still shows its figure, and "Not recorded"
 * when it has none.
 */
export default async function BudgetBandsPage() {
  const context = await requireInternal('/settings/budget-bands');
  const [setting, clock] = await Promise.all([readBudgetBands(), agencyClock()]);
  const mayEdit = can(context, 'organization.settings');
  const sample = describeBudget(SAMPLE_MINOR, setting.bands, (m) => `₹${(m / 100).toLocaleString('en-IN')}`);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Budget Bands"
          description={setting.updatedAt ? `Last saved ${clock.dateTime(setting.updatedAt)}.` : 'Nothing saved yet: leads use the starting bands.'}
        />
        <div className="px-4 pb-4 sm:px-5">
          <BudgetBandsForm bandText={bandLines(setting.configured ? setting.bands : STARTING_BANDS)} mayEdit={mayEdit} />
        </div>
      </Card>
      <Card>
        <CardHeader title="How A Lead Shows It" description="The band, then the recorded figure. A lead with no budget reads Not recorded." />
        <p className="px-4 pb-4 text-[13px] sm:px-5">
          A budget of ₹75,000 reads <span className="font-medium">{sample.text}</span>.
        </p>
      </Card>
    </div>
  );
}
