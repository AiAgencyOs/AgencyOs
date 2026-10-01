import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Date changes recorded in the audit trail — SCR-022 "Changes must preserve
 * history and notify affected owners". One read door,
 * `projects.schedule_changes`: a task's due date, a milestone's due date or the
 * project's due date, where a date really moved, with the old and the new date
 * and who moved it. The snapshots are never returned.
 *
 * `mine: true` keeps only the changes that concern the caller and were made by
 * somebody else — that is what the Notifications inbox lists. A failed read
 * refuses (an empty list is an answer, a database that did not reply is not).
 */
export type ScheduleChange = {
  auditId: number;
  changedAt: string;
  kind: 'task' | 'milestone' | 'project';
  subjectId: string;
  projectId: string;
  projectName: string;
  label: string;
  wasOn: string | null;
  nowOn: string | null;
  actorName: string | null;
};

export async function listScheduleChanges(opts: { projectId?: string; mine?: boolean; sinceIso?: string; limit?: number } = {}): Promise<ScheduleChange[]> {
  const supabase = await createClient();
  const args: { p_mine: boolean; p_limit: number; p_project_id?: string; p_since?: string } = { p_mine: opts.mine ?? false, p_limit: opts.limit ?? 50 };
  if (opts.projectId) args.p_project_id = opts.projectId;
  if (opts.sinceIso) args.p_since = opts.sinceIso;
  const { data, error } = await supabase.schema('projects').rpc('schedule_changes', args);
  if (error) unreadable('listScheduleChanges', error);
  type Row = { audit_id: number; changed_at: string; kind: string; subject_id: string; project_id: string; project_name: string; label: string | null; was_on: string | null; now_on: string | null; actor_name: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    auditId: r.audit_id,
    changedAt: r.changed_at,
    kind: r.kind as ScheduleChange['kind'],
    subjectId: r.subject_id,
    projectId: r.project_id,
    projectName: r.project_name,
    label: r.label ?? r.project_name,
    wasOn: r.was_on,
    nowOn: r.now_on,
    actorName: r.actor_name,
  }));
}

export { describeScheduleMove, SCHEDULE_KIND_LABEL, scheduleChangeHref } from './schedule-changes-queries-pure';
