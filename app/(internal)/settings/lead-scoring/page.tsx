import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeadScoreWeightHistory, readLeadScoreWeights } from '@/modules/crm/lead-score-weights';
import { Badge, Card, CardHeader, EmptyState } from '@/ui';

import { WeightsForm } from './weights-form';

export const metadata: Metadata = { title: 'Lead scoring' };

/**
 * Lead scoring weights (P1-CRM-019/020). The factors are the model and live in code; how many points each is worth is data an owner or ops admin sets here.
 * Every save is a new, numbered version with a reason, the database refuses a set whose positive weights do not add up to 100, and a score that was stored
 * keeps the version that produced it. The score is a prioritisation aid: a person can still override a lead's score or heat, and nothing here changes a
 * lead's status or sends anything.
 */
export default async function LeadScoringPage() {
  const context = await requireInternal('/settings/lead-scoring');
  const mayEdit = can(context, 'organization.settings');
  const inForce = await readLeadScoreWeights();
  const history = await listLeadScoreWeightHistory();
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Weights in force"
          description={inForce.source === 'default' ? 'No set has been saved: the built-in defaults apply.' : `Version ${inForce.version}${inForce.reason ? `, saved because: ${inForce.reason}` : ''}.`}
          actions={<Badge tone={inForce.source === 'default' ? 'neutral' : 'success'}>{inForce.source === 'default' ? 'Defaults' : `Version ${inForce.version}`}</Badge>}
        />
        <div className="px-4 pb-4 sm:px-5">
          <WeightsForm weights={inForce.weights} readOnly={!mayEdit} />
        </div>
      </Card>
      <Card>
        <CardHeader title="History" description="Every saved set, newest first. A saved set is never edited." />
        <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
          {history.length === 0 ? <EmptyState title="Nothing saved yet" description="The defaults have always applied." /> : null}
          {history.map((h) => (
            <details key={h.version} className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <summary className="cursor-pointer">
                Version {h.version} · {new Date(h.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · {h.reason}
              </summary>
              <pre className="mt-2 overflow-x-auto text-xs">{JSON.stringify(h.weights, null, 2)}</pre>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
