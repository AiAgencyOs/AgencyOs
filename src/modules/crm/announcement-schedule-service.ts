import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { scheduleAnnouncementSchema, type ScheduleAnnouncementInput } from './announcement-schedule-schema';

/**
 * SCR-059 — schedule a draft announcement. `organization.settings` (owner),
 * like every announcement door; `crm.schedule_announcement` asks
 * `core.is_owner()` again, refuses a moment in the past and audits.
 */
export async function scheduleAnnouncement(input: ScheduleAnnouncementInput): Promise<Result<{ scheduled: boolean }>> {
  const parsed = scheduleAnnouncementSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid schedule.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to schedule announcements.');

  let scheduledFor: string | null = null;
  if (parsed.data.scheduledFor) {
    const at = new Date(parsed.data.scheduledFor);
    if (Number.isNaN(at.getTime())) return err('VALIDATION', 'That is not a date and time.');
    scheduledFor = at.toISOString();
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('schedule_announcement', {
    p_announcement_id: parsed.data.announcementId,
    p_scheduled_for: scheduledFor,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'scheduleAnnouncement', detail: error.message }));
    return err('INTERNAL', 'Could not schedule the announcement.');
  }
  const outcome = (Array.isArray(data) ? data[0] : data)?.outcome ?? 'no answer';
  switch (outcome) {
    case 'scheduled':
      return ok({ scheduled: true });
    case 'unscheduled':
      return ok({ scheduled: false });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: owner only.');
    case 'not_found':
      return err('NOT_FOUND', 'Announcement not found.');
    case 'not_a_draft':
      return err('CONFLICT', 'Only a draft can be scheduled.');
    case 'in_the_past':
      return err('VALIDATION', 'Pick a moment in the future.');
    default:
      return err('INTERNAL', `The database refused (${outcome}).`);
  }
}
