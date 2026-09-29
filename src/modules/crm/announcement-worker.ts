import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Scheduled announcements — SCR-059, run from the cron tick. One call to
 * `crm.publish_due_announcements` (service role): every draft whose
 * `scheduled_for` has passed becomes published, audited as by the
 * schedule. It records; it sends nothing — an announcement is a record of
 * what was announced, and WhatsApp broadcast is a campaign, not this.
 */
export type AnnouncementOutcome = { published: number; failed: boolean };

export async function publishDueAnnouncements(admin: Admin): Promise<AnnouncementOutcome> {
  const { data, error } = await admin.schema('crm').rpc('publish_due_announcements', { p_limit: 50 });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'publishDueAnnouncements', detail: error.message }));
    return { published: 0, failed: true };
  }
  const rows = (Array.isArray(data) ? data : []) as { announcement_id: string; organization_id: string; title: string }[];
  for (const row of rows) {
    console.error(JSON.stringify({ level: 'info', scope: 'announcementPublished', announcementId: row.announcement_id, organizationId: row.organization_id }));
  }
  return { published: rows.length, failed: false };
}
