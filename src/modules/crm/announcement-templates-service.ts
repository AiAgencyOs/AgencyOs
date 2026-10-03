import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { saveAnnouncementTemplateSchema, type SaveAnnouncementTemplateInput } from './announcement-templates-schema';

type Row = { outcome?: string; id?: string | null };
const first = (data: unknown) => (Array.isArray(data) ? data[0] : data) as Row | undefined;

/**
 * Announcement templates — `organization.settings` (owner), the capability
 * announcements themselves use; `crm.save_announcement_template` asks
 * `is_owner()` again and audits. Nothing here sends anything.
 */
export async function saveAnnouncementTemplate(input: SaveAnnouncementTemplateInput): Promise<Result<{ templateId: string; created: boolean }>> {
  const parsed = saveAnnouncementTemplateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid template.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to write announcement templates.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('save_announcement_template', {
    p_name: parsed.data.name,
    p_kind: parsed.data.kind,
    p_audience: parsed.data.audience,
    p_title_template: parsed.data.titleTemplate,
    p_body_template: parsed.data.bodyTemplate,
    p_active: parsed.data.active,
    ...(parsed.data.templateId ? { p_template_id: parsed.data.templateId } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'saveAnnouncementTemplate', detail: error.message }));
    return err('INTERNAL', 'Could not save the template.');
  }
  const row = first(data);
  switch (row?.outcome) {
    case 'created':
    case 'updated':
      return row.id ? ok({ templateId: row.id, created: row.outcome === 'created' }) : err('INTERNAL', 'Could not save the template.');
    case 'name_taken':
      return err('CONFLICT', 'A template with that name already exists.');
    case 'not_found':
      return err('NOT_FOUND', 'That template is not in this organization.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: owner only.');
    default:
      return err('VALIDATION', `The template was refused (${row?.outcome ?? 'no answer'}).`);
  }
}

/** The owner's button for a met milestone the trigger did not draft for. */
export async function draftMilestoneAnnouncement(milestoneId: string): Promise<Result<{ announcementId: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(milestoneId)) return err('VALIDATION', 'That is not a milestone.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to draft announcements.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('draft_milestone_announcement', { p_milestone_id: milestoneId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'draftMilestoneAnnouncement', detail: error.message }));
    return err('INTERNAL', 'Could not draft the announcement.');
  }
  const row = first(data);
  switch (row?.outcome) {
    case 'drafted':
      return row.id ? ok({ announcementId: row.id }) : err('INTERNAL', 'Could not draft the announcement.');
    case 'already_drafted':
      return err('CONFLICT', 'This milestone already has an announcement.');
    case 'no_template':
      return err('CONFLICT', 'There is no active milestone template to draft from. Write one under Announcement templates first.');
    case 'not_met':
      return err('CONFLICT', 'Only a met milestone is announced.');
    case 'not_client_visible':
      return err('CONFLICT', 'This milestone is internal; nothing is announced for it.');
    case 'not_found':
      return err('NOT_FOUND', 'Milestone not found.');
    default:
      return err('FORBIDDEN', 'The database refused: owner only.');
  }
}
