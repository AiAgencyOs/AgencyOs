import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { readFailureQueue } from '@/modules/projects/phase-seven-c-queries';
import { Card, PageHeader } from '@/ui';

import { FailureQueueList } from '../../projects/[projectId]/phase-seven-c-panel';

export const metadata: Metadata = { title: 'Phase 7 failure queue' };

/**
 * Everything wrong in Phase 7 across the organization, right now: failed deployments, failed validations, open incidents, approvals nobody decided for a day, and
 * client actions past their date. DERIVED from the current rows by `projects.p7_failure_queue`: nothing is stored and nothing here acts. Open a project to act.
 */
export default async function PhaseSevenFailuresPage() {
  await requireInternal();
  const items = await readFailureQueue(24);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Phase 7 failure queue" description="What is failing, stuck or overdue in production launch and handover, oldest first." />
      <Card className="p-4">
        <FailureQueueList items={items} />
      </Card>
    </div>
  );
}
