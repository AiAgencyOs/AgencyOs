import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { nextCronOccurrence } from './cron';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The suite scheduler — SCR-048, run from the cron tick beside the other
 * sweeps. Reads every active schedule whose `next_run_at` has passed,
 * computes the occurrence after now in that organization's zone with the
 * same pure parser the form used, and hands both to `qa.fire_suite_schedule`,
 * which opens the run and advances the schedule under a row lock. The
 * database decides again whether the schedule is due; this only proposes.
 *
 * What "run" means here: the panel has no test runner, so a fired schedule
 * is an OPEN run — a person or an agent fills and closes it. Nothing here
 * claims a suite passed.
 */
export type SuiteScheduleOutcome = { due: number; fired: number; skipped: number; failedRun: boolean };

export async function runSuiteSchedules(admin: Admin, limit = 50): Promise<SuiteScheduleOutcome> {
  const outcome: SuiteScheduleOutcome = { due: 0, fired: 0, skipped: 0, failedRun: false };
  const now = new Date();

  const { data: due, error } = await admin
    .schema('qa')
    .from('suite_schedules')
    .select('id, organization_id, cron, next_run_at')
    .eq('active', true)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(limit);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'runSuiteSchedules.read', detail: error.message }));
    return { ...outcome, failedRun: true };
  }
  outcome.due = (due ?? []).length;
  if (outcome.due === 0) return outcome;

  const orgIds = [...new Set((due ?? []).map((s) => s.organization_id))];
  const { data: orgs, error: orgError } = await admin.schema('core').from('organizations').select('id, timezone').in('id', orgIds);
  if (orgError) {
    console.error(JSON.stringify({ level: 'error', scope: 'runSuiteSchedules.timezones', detail: orgError.message }));
    return { ...outcome, failedRun: true };
  }
  const zoneByOrg = new Map((orgs ?? []).map((o) => [o.id, o.timezone ?? 'UTC']));

  for (const s of due ?? []) {
    const next = nextCronOccurrence(s.cron, now, zoneByOrg.get(s.organization_id) ?? 'UTC');
    if (!next) {
      // An expression that never comes round again: pause it rather than
      // fire it every tick against a null.
      await admin.schema('qa').from('suite_schedules').update({ active: false }).eq('id', s.id);
      outcome.skipped += 1;
      continue;
    }
    const { data, error: fireError } = await admin.schema('qa').rpc('fire_suite_schedule', { p_schedule_id: s.id, p_next_run_at: next.toISOString() });
    if (fireError) {
      console.error(JSON.stringify({ level: 'error', scope: 'runSuiteSchedules.fire', scheduleId: s.id, detail: fireError.message }));
      outcome.failedRun = true;
      continue;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; run_id: string | null } | undefined;
    if (row?.outcome === 'fired') outcome.fired += 1;
    else outcome.skipped += 1;
  }
  return outcome;
}
