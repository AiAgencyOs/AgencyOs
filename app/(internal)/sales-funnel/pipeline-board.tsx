'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setOpportunityStageAction } from '@/modules/sales/actions';
import { OPPORTUNITY_TRANSITIONS, type OpportunityStage } from '@/modules/sales/schema';
import { Callout, IconAlert, KanbanBoard, type KanbanColumn } from '@/ui';

export type PipelineCard = {
  id: string;
  columnId: OpportunityStage;
  leadId: string;
  name: string;
  valueLabel: string;
};

/**
 * The interactive half of the Sales Pipeline's open-deal board (SCR-005).
 * Scoped to the three OPEN stages only (discovery/proposal/negotiation) —
 * `won` and `lost` are reached through the Lead 360 sales panel's own guarded
 * flow (a mandatory reason+category for lost, the won-gate RPC and a
 * separate `convertToProject` capability/action for won), neither of which a
 * card drag can supply. The write itself is the exact same
 * `setOpportunityStageAction` that panel's stage dropdown already calls —
 * `OPPORTUNITY_TRANSITIONS` is re-checked here only so a card visibly snaps
 * back instead of round-tripping to the server for a move that would just be
 * rejected; the server enforces the same map regardless.
 */
export function PipelineBoard({
  columns,
  deals,
  canWrite,
}: {
  columns: KanbanColumn[];
  deals: PipelineCard[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function handleMove(opportunityId: string, toStage: string) {
    setError(null);
    const deal = deals.find((d) => d.id === opportunityId);
    if (!deal) return;

    const allowed = OPPORTUNITY_TRANSITIONS[deal.columnId] as readonly string[];
    if (!allowed.includes(toStage)) {
      setError(`A deal in ${deal.columnId} can only move to ${allowed.join(' or ') || 'nowhere from here'}.`);
      return;
    }

    const formData = new FormData();
    formData.set('opportunityId', opportunityId);
    formData.set('stage', toStage);
    formData.set('leadId', deal.leadId);

    const result = await setOpportunityStageAction(IDLE_STATE, formData);
    if (result.status === 'error') {
      setError(result.message ?? 'Could not move this deal.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Callout tone="danger" icon={<IconAlert size={16} />}>
          {error}
        </Callout>
      ) : null}
      <KanbanBoard
        columns={columns}
        items={deals}
        disabled={!canWrite}
        onMove={handleMove}
        renderCard={(deal) => (
          <div className="rounded-lg border border-line bg-surface p-3 shadow-xs">
            {/* A drag only starts once the pointer moves past the 6px
                threshold `KanbanBoard`'s `PointerSensor` requires, so an
                ordinary click still reaches this link without any extra
                handling here. */}
            <Link
              href={`/leads/${deal.leadId}`}
              className="block truncate text-[13px] font-medium text-foreground hover:underline"
            >
              {deal.name}
            </Link>
            <p className="mt-1 text-xs text-muted">{deal.valueLabel}</p>
          </div>
        )}
      />
    </div>
  );
}
