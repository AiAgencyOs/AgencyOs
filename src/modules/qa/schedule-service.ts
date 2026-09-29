import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { nextCronOccurrence } from './cron';
import { setSuiteScheduleSchema, type SetSuiteScheduleInput } from './schedule-schema';

/**
 * SCR-048 — set, pause or remove a suite schedule. `project.write` (owner,
 * ops_admin, delivery_lead — the roles the write policy names). The next
 * occurrence is computed here in the agency's zone and written with the
 * row; the tick recomputes it each time it fires the schedule.
 */
export async function setSuiteSchedule(input: SetSuiteScheduleInput): Promise<Result<{ removed: boolean; nextRunAt: string | null }>> {
  const parsed = setSuiteScheduleSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid schedule.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to schedule suites.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  if (parsed.data.remove) {
    const { error } = await supabase.schema('qa').from('suite_schedules').delete().eq('project_id', parsed.data.projectId).eq('suite', parsed.data.suite);
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'setSuiteSchedule.remove', detail: error.message }));
      return err('INTERNAL', 'Could not remove the schedule.');
    }
    await recordAudit({ organizationId: context.organizationId, action: 'suite_schedule.removed', subjectType: 'project', subjectId: parsed.data.projectId, before: { suite: parsed.data.suite } });
    return ok({ removed: true, nextRunAt: null });
  }

  const { data: org, error: orgError } = await supabase.schema('core').from('organizations').select('timezone').limit(1).maybeSingle();
  if (orgError) {
    console.error(JSON.stringify({ level: 'error', scope: 'setSuiteSchedule.timezone', detail: orgError.message }));
    return err('INTERNAL', 'Could not read the agency timezone.');
  }
  const timeZone = org?.timezone ?? 'UTC';
  const next = parsed.data.active ? nextCronOccurrence(parsed.data.cron, new Date(), timeZone) : null;
  if (parsed.data.active && !next) return err('VALIDATION', 'That expression never comes round in the next year.');

  const { data, error } = await supabase
    .schema('qa')
    .from('suite_schedules')
    .upsert(
      {
        organization_id: context.organizationId,
        project_id: parsed.data.projectId,
        deliverable_id: parsed.data.deliverableId,
        suite: parsed.data.suite,
        cron: parsed.data.cron,
        active: parsed.data.active,
        next_run_at: next ? next.toISOString() : null,
        created_by: context.userId,
      },
      { onConflict: 'project_id,suite' },
    )
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setSuiteSchedule', detail: error.message }));
    return err('INTERNAL', 'Could not save the schedule.');
  }
  if (!data) return err('FORBIDDEN', 'The database refused the schedule.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'suite_schedule.set',
    subjectType: 'suite_schedule',
    subjectId: data.id,
    after: { project_id: parsed.data.projectId, suite: parsed.data.suite, cron: parsed.data.cron, active: parsed.data.active, next_run_at: next?.toISOString() ?? null },
  });
  return ok({ removed: false, nextRunAt: next ? next.toISOString() : null });
}
