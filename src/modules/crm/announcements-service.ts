import 'server-only';

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
 *
 * Drafting goes through `crm.create_announcement` (20261006500200), which
 * checks the project belongs to the organization, takes the client from the
 * project, and audits `announcement.drafted`.
 */
export async function createAnnouncement(input: CreateAnnouncementInput): Promise<Result<{ announcementId: string }>> {
  const parsed = createAnnouncementSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid announcement.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to write announcements.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('create_announcement', {
    p_title: parsed.data.title,
    p_body: parsed.data.body,
    p_audience: parsed.data.audience,
    ...(parsed.data.projectId ? { p_project_id: parsed.data.projectId } : {}),
    ...(parsed.data.clientAccountId ? { p_client_account_id: parsed.data.clientAccountId } : {}),
    ...(parsed.data.templateId ? { p_template_id: parsed.data.templateId } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'createAnnouncement', detail: error.message }));
    return err('INTERNAL', 'Could not save the announcement.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'drafted':
      return row.id ? ok({ announcementId: row.id }) : err('INTERNAL', 'Could not save the announcement.');
    case 'project_not_found':
      return err('NOT_FOUND', 'That project is not in this organization.');
    case 'client_not_found':
      return err('NOT_FOUND', 'That client is not in this organization.');
    case 'client_not_on_project':
      return err('VALIDATION', 'That project belongs to a different client. Name the project alone and its client follows.');
    case 'template_not_found':
      return err('NOT_FOUND', 'That template is not in this organization.');
    case 'bad_title':
      return err('VALIDATION', 'A title is 1 to 160 characters.');
    case 'bad_body':
      return err('VALIDATION', 'A body is 1 to 5000 characters.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: owner only.');
    default:
      return err('INTERNAL', `The database refused the announcement (${row?.outcome ?? 'no answer'}).`);
  }
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
