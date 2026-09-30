import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-059 "Template detail" — one WhatsApp template with everything the
 * panel knows about it: the registry row, Meta's status and the Admin's
 * switch, the parameters it fills, its delivery performance (the
 * `crm.whatsapp_template_performance` view), every recorded change, and the
 * campaigns that carry it. Read-only; the doors stay on Settings ›
 * Communication.
 */
export type TemplateDetail = {
  id: string;
  situationKey: string;
  templateName: string;
  languageCode: string;
  status: string;
  active: boolean;
  parameters: string[];
  createdAt: string;
  updatedAt: string;
  performance: { sent: number; delivered: number; read: number; replied: number; failed: number } | null;
  versions: { id: string; status: string; active: boolean; parameters: string[]; changeReason: string | null; recordedAt: string }[];
  campaigns: { id: string; name: string; status: string; recipients: number; sent: number; createdAt: string }[];
};

export async function getTemplateDetail(templateId: string): Promise<TemplateDetail | null> {
  const supabase = await createClient();
  const { data: t, error } = await supabase
    .schema('crm')
    .from('whatsapp_templates')
    .select('id, situation_key, template_name, language_code, status, active, parameters, created_at, updated_at')
    .eq('id', templateId)
    .maybeSingle();
  if (error) unreadable('getTemplateDetail', error);
  if (!t) return null;

  const [perf, versions, campaigns] = await Promise.all([
    supabase.schema('crm').from('whatsapp_template_performance').select('sent, delivered, read, replied, failed').eq('template_id', templateId).maybeSingle(),
    supabase
      .schema('crm')
      .from('whatsapp_template_versions')
      .select('id, status, active, parameters, change_reason, recorded_at')
      .eq('template_id', templateId)
      .order('recorded_at', { ascending: false })
      .limit(100),
    supabase
      .schema('crm')
      .from('campaigns')
      .select('id, name, status, recipients_count, sent_count, created_at')
      .eq('template_id', templateId)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);
  if (perf.error) unreadable('getTemplateDetail.performance', perf.error);
  if (versions.error) unreadable('getTemplateDetail.versions', versions.error);
  if (campaigns.error) unreadable('getTemplateDetail.campaigns', campaigns.error);

  return {
    id: t.id,
    situationKey: t.situation_key,
    templateName: t.template_name,
    languageCode: t.language_code,
    status: t.status,
    active: t.active,
    parameters: t.parameters ?? [],
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    performance: perf.data
      ? { sent: perf.data.sent ?? 0, delivered: perf.data.delivered ?? 0, read: perf.data.read ?? 0, replied: perf.data.replied ?? 0, failed: perf.data.failed ?? 0 }
      : null,
    versions: (versions.data ?? []).map((v) => ({ id: v.id, status: v.status, active: v.active, parameters: v.parameters ?? [], changeReason: v.change_reason, recordedAt: v.recorded_at })),
    campaigns: (campaigns.data ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status, recipients: c.recipients_count, sent: c.sent_count, createdAt: c.created_at })),
  };
}
