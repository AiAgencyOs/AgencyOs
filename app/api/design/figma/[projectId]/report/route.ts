import { z } from 'zod';

import { createAdminClient } from '@/lib/db/admin';
import { authorise, preflight, reply } from '@/modules/projects/figma-route';

export const OPTIONS = preflight;

const reportSchema = z.object({
  fileKey: z.string().regex(/^[A-Za-z0-9_-]{5,64}$/).nullable().optional(),
  pageId: z.string().max(40).nullable().optional(),
  pageName: z.string().max(200).nullable().optional(),
  frames: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        screenId: z.string().uuid().nullable(),
        name: z.string().min(1).max(240),
        // Figma node ids look like "12:34" (or "I12:34;5:6" inside instances).
        nodeId: z.string().regex(/^[A-Za-z0-9:;_-]{1,40}$/),
      }),
    )
    .min(1)
    .max(400),
});

/** The plugin reports what it built. A record only: nothing is linked to a screen or a theme by it - a person does that, verified. */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const auth = authorise(request, projectId);
  if ('response' in auth) return auth.response;

  const text = await request.text();
  if (text.length > 200_000) return reply(413, { error: 'That report is too large.' });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return reply(400, { error: 'The report is not valid JSON.' });
  }
  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) return reply(400, { error: 'The report does not have the expected shape.' });

  const { data, error } = await createAdminClient().schema('projects').rpc('record_figma_import', {
    p_organization_id: auth.claim.organizationId,
    p_project_id: projectId,
    p_file_key: (parsed.data.fileKey ?? null) as unknown as string,
    p_page_id: (parsed.data.pageId ?? null) as unknown as string,
    p_page_name: (parsed.data.pageName ?? null) as unknown as string,
    p_frames: parsed.data.frames as unknown as never,
  });
  if (error) return reply(500, { error: 'The report could not be recorded.' });
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.outcome !== 'recorded') return reply(404, { error: 'That project was not found.' });
  return reply(200, { ok: true, importId: row.import_id });
}
