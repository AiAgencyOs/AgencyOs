import { createAdminClient } from '@/lib/db/admin';
import { buildFigmaExport } from '@/modules/projects/figma-export';
import { authorise, preflight, reply, replyError } from '@/modules/projects/figma-route';

export const OPTIONS = preflight;

/** The Figma plugin reads one project's finalized screens and selected direction. Read-only; the signed code is the only authority. */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const auth = authorise(request, projectId);
  if ('response' in auth) return auth.response;
  const payload = await buildFigmaExport(createAdminClient(), { organizationId: auth.claim.organizationId, projectId });
  if (!payload) return replyError('NOT_FOUND', 'That project was not found.');
  return reply(200, payload);
}
