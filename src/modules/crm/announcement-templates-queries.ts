import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { AnnouncementTemplateKind } from './announcement-templates-schema';
import type { AnnouncementAudience } from './announcements-schema';

export type AnnouncementTemplateRow = {
  id: string;
  name: string;
  kind: AnnouncementTemplateKind;
  audience: AnnouncementAudience;
  titleTemplate: string;
  bodyTemplate: string;
  active: boolean;
  updatedAt: string;
};

/** The organization's announcement templates, active first then by name. RLS scopes to the organization. */
export async function listAnnouncementTemplates(): Promise<AnnouncementTemplateRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('announcement_templates')
    .select('id, name, kind, audience, title_template, body_template, active, updated_at')
    .order('active', { ascending: false })
    .order('name', { ascending: true })
    .limit(100);
  if (error) unreadable('listAnnouncementTemplates', error);
  return (data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind === 'milestone' ? 'milestone' : 'general',
    audience: t.audience === 'clients' ? 'clients' : 'internal',
    titleTemplate: t.title_template,
    bodyTemplate: t.body_template,
    active: t.active,
    updatedAt: t.updated_at,
  }));
}
