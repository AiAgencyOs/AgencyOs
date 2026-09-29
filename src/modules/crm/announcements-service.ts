import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  createAnnouncementSchema,
  setAnnouncementStatusSchema,
  type CreateAnnouncementInput,
  type SetAnnouncementStatusInput,
} from './announcements-schema';

/**
 * The announcement doors — `organization.settings` (owner), the capability
 * every other Settings › Communication door uses; RLS's owner-only policies
 * decide again. Creating is an insert with a named audit row; publishing
 * and archiving go through `crm.set_announcement_status`, which stamps the
 * moment and audits inside the transaction. Nothing here sends anything.
 */
export async function createAnnouncement(input: CreateAnnouncementInput): Promise<Result<{ announcementId: string }>> {
  const parsed = createAnnouncementSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid announcement.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to write announcements.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('announcements')
    .insert({
      organization_id: context.organizationId,
      title: parsed.data.title,
      body: parsed.data.body,
      audience: parsed.data.audience,
      created_by: context.userId,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'createAnnouncement', detail: error.message }));
    return err('INTERNAL', 'Could not save the announcement.');
  }
  if (!data) return err('FORBIDDEN', 'The database refused the announcement.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'announcement.drafted',
    subjectType: 'announcement',
    subjectId: data.id,
    after: { title: parsed.data.title, audience: parsed.data.audience },
  });

  return ok({ announcementId: data.id });
}

export async function setAnnouncementStatus(input: SetAnnouncementStatusInput): Promise<Result<{ status: string }>> {
  const parsed = setAnnouncementStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid status.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to publish announcements.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_announcement_status', {
    p_organization_id: context.organizationId,
    p_announcement_id: parsed.data.announcementId,
    p_status: parsed.data.status,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAnnouncementStatus', detail: error.message }));
    return err('INTERNAL', 'The status could not be changed.');
  }

  const outcome = (data as { outcome: string }[] | null)?.[0]?.outcome ?? 'no answer';
  switch (outcome) {
    case 'published':
    case 'archived':
      return ok({ status: outcome });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: owner only.');
    case 'not_found':
      return err('NOT_FOUND', 'Announcement not found.');
    case 'not_a_draft':
      return err('CONFLICT', 'Only a draft can be published.');
    case 'already_archived':
      return err('CONFLICT', 'Already archived.');
    default:
      return err('INTERNAL', `The database refused the change (${outcome}).`);
  }
}
