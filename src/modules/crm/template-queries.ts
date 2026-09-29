import 'server-only';

import { ilikeAny } from '@/lib/db/search';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The registered WhatsApp templates and their history — SCR-057, SCR-059.
 *
 * `crm.whatsapp_templates` is what Settings → Communication writes;
 * `crm.whatsapp_template_versions` is the trail its trigger keeps (every
 * change, with who and why). Both are RLS-scoped and readable by every
 * internal role; neither had a reader outside the settings form until now.
 */

export type WhatsAppTemplateRow = {
  id: string;
  situationKey: string;
  templateName: string;
  languageCode: string;
  status: string;
  parameters: string[];
  active: boolean;
  updatedAt: string;
};

export async function listWhatsAppTemplates(q?: string): Promise<WhatsAppTemplateRow[]> {
  const supabase = await createClient();

  let query = supabase
    .schema('crm')
    .from('whatsapp_templates')
    .select('id, situation_key, template_name, language_code, status, parameters, active, updated_at')
    .order('situation_key', { ascending: true })
    .order('language_code', { ascending: true })
    .limit(500);
  // Search within domain (bucket G-3): the template's name or its situation, server-side.
  if (q) query = query.or(ilikeAny(['template_name', 'situation_key'], q));
  const { data, error } = await query;

  if (error) unreadable('listWhatsAppTemplates', error);

  return (data ?? []).map((t) => ({
    id: t.id,
    situationKey: t.situation_key,
    templateName: t.template_name,
    languageCode: t.language_code,
    status: t.status,
    parameters: t.parameters ?? [],
    active: t.active,
    updatedAt: t.updated_at,
  }));
}

export type WhatsAppTemplateVersionRow = {
  id: string;
  templateId: string;
  templateName: string;
  languageCode: string;
  status: string;
  parameters: string[];
  active: boolean;
  changeReason: string | null;
  changedBy: string | null;
  recordedAt: string;
};

/** Every recorded change to a template, newest first. */
export async function listWhatsAppTemplateVersions(limit = 100): Promise<WhatsAppTemplateVersionRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('whatsapp_template_versions')
    .select('id, template_id, template_name, language_code, status, parameters, active, change_reason, changed_by, recorded_at')
    .order('recorded_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listWhatsAppTemplateVersions', error);

  return (data ?? []).map((v) => ({
    id: v.id,
    templateId: v.template_id,
    templateName: v.template_name,
    languageCode: v.language_code,
    status: v.status,
    parameters: v.parameters ?? [],
    active: v.active,
    changeReason: v.change_reason,
    changedBy: v.changed_by,
    recordedAt: v.recorded_at,
  }));
}
