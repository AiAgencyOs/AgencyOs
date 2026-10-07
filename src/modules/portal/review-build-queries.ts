import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The review builds staff have relayed to this client. The database function decides what a client may see (only a relayed share, only their own
 * project, no commit, hash, run or internal id); nothing here widens it. A failed read is `unreadable`, never "nothing shared yet".
 */
export type ClientReviewBuild = {
  buildVersion: number;
  reviewPlatform: string;
  reviewUrl: string;
  testingInstructions: string;
  label: string;
  sharedAt: string;
};

export async function readClientReviewBuilds(projectId: string): Promise<ClientReviewBuild[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('client_build_shares_for_client' as never, { p_project_id: projectId } as never);
  if (error) unreadable('readClientReviewBuilds', error);
  return (
    (data ?? []) as unknown as {
      build_version: number;
      review_platform: string;
      review_url: string;
      testing_instructions: string;
      label: string;
      shared_at: string;
    }[]
  ).map((r) => ({
    buildVersion: r.build_version,
    reviewPlatform: r.review_platform,
    reviewUrl: r.review_url,
    testingInstructions: r.testing_instructions,
    label: r.label,
    sharedAt: r.shared_at,
  }));
}
