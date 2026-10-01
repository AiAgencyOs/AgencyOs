import 'server-only';

import { createClient } from '@/lib/db/server';

import { CARRIED_LEAD_FILE_CATEGORY } from '@/modules/crm/lead-files-schema';
import { addProjectFile } from '@/modules/projects/service';

/**
 * Owner decision 11 — the links kept on a lead become visible on the project
 * its deal became: each is copied ONCE as a project file link, through the
 * ordinary project file link door (`addProjectFile`), from the app after the
 * project exists. The WON handoff function is not touched.
 *
 * Once, and idempotently, because of the claim: `crm.claim_lead_file_carry`
 * flips the link's `carried_to_project_id` from null in one atomic update, so
 * a second click, a repairing re-run or two concurrent conversions each get
 * 'already_carried' for a link somebody already claimed. A copy that fails
 * hands its claim back, so the next conversion tries that link again — the
 * link is never marked carried without a copy behind it.
 *
 * Returns how many links were copied now. It never throws and never fails the
 * conversion: the project is the durable outcome (same posture as the
 * onboarding checklist), a shortfall is logged, and re-running conversion
 * repairs it.
 */
export async function carryLeadFilesToProject(leadId: string, projectId: string): Promise<{ copied: number; failed: number }> {
  const supabase = await createClient();
  const { data: files, error } = await supabase
    .schema('crm')
    .from('lead_files')
    .select('id, title, url')
    .eq('lead_id', leadId)
    .is('carried_to_project_id', null)
    .order('added_at', { ascending: true });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'carryLeadFilesToProject.read', detail: error.message }));
    return { copied: 0, failed: 0 };
  }

  let copied = 0;
  let failed = 0;
  for (const file of files ?? []) {
    const { data: claim, error: claimError } = await supabase.schema('crm').rpc('claim_lead_file_carry', { p_file_id: file.id, p_project_id: projectId });
    const outcome = (Array.isArray(claim) ? claim[0] : claim) as { outcome?: string } | undefined;
    if (claimError || outcome?.outcome !== 'claimed') {
      if (claimError || (outcome?.outcome !== 'already_carried')) failed += 1;
      continue;
    }

    const added = await addProjectFile({
      projectId,
      category: CARRIED_LEAD_FILE_CATEGORY,
      title: file.title,
      url: file.url,
      description: 'Carried over from the lead when the deal was won.',
    });
    if (added.ok) {
      copied += 1;
      continue;
    }
    failed += 1;
    console.error(JSON.stringify({ level: 'error', scope: 'carryLeadFilesToProject.copy', detail: `lead file ${file.id} not copied to project ${projectId}: ${added.error.message}` }));
    await supabase.schema('crm').rpc('release_lead_file_carry', { p_file_id: file.id, p_project_id: projectId });
  }
  return { copied, failed };
}
