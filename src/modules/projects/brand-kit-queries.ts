import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type BrandRule = { id: string; title: string; rule: string; createdAt: string };

/** SCR-038 — the written brand rules of a project, oldest first. */
export async function readBrandRules(projectId: string): Promise<BrandRule[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('brand_rules').select('id, title, rule, created_at').eq('project_id', projectId).order('created_at', { ascending: true }).limit(200);
  if (error) unreadable('readBrandRules', error);
  return (data ?? []).map((r) => ({ id: r.id, title: r.title, rule: r.rule, createdAt: r.created_at }));
}
