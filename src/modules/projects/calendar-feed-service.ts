import 'server-only';

import { randomBytes } from 'node:crypto';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { createCalendarFeedSchema, revokeCalendarFeedSchema, type CreateCalendarFeedInput, type RevokeCalendarFeedInput } from './calendar-feed-schema';

/**
 * Calendar feed tokens — SCR-022 (migration 20261001120000). One's own
 * only: `calendar_feed_tokens_write` binds every row to `auth.uid()`, so a
 * colleague's feed cannot be made or revoked from here. `project.read` is
 * what it takes to see the calendar, and so to subscribe to it.
 */
export async function createCalendarFeed(input: CreateCalendarFeedInput): Promise<Result<{ feedId: string; token: string }>> {
  const parsed = createCalendarFeedSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid project.');

  const context = await requireInternal();
  if (!can(context, 'project.read')) return err('FORBIDDEN', 'You do not have permission to read this project.');
  if (!context.organizationId || !context.userId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  // One live feed per person per project: a second click returns the same URL.
  const { data: existing, error: existingError } = await supabase
    .schema('projects')
    .from('calendar_feed_tokens')
    .select('id, token')
    .eq('project_id', parsed.data.projectId)
    .eq('user_id', context.userId)
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    console.error(JSON.stringify({ level: 'error', scope: 'createCalendarFeed.existing', detail: existingError.message }));
    return err('INTERNAL', 'Could not read your calendar feeds.');
  }
  if (existing) return ok({ feedId: existing.id, token: existing.token });

  const token = randomBytes(32).toString('base64url');
  const { data, error } = await supabase
    .schema('projects')
    .from('calendar_feed_tokens')
    .insert({ organization_id: context.organizationId, project_id: parsed.data.projectId, user_id: context.userId, token })
    .select('id, token')
    .single();
  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'createCalendarFeed', detail: error?.message }));
    return err('INTERNAL', 'Could not create the calendar feed.');
  }
  return ok({ feedId: data.id, token: data.token });
}

export async function revokeCalendarFeed(input: RevokeCalendarFeedInput): Promise<Result<{ revoked: true }>> {
  const parsed = revokeCalendarFeedSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid feed.');

  const context = await requireInternal();
  if (!can(context, 'project.read')) return err('FORBIDDEN', 'You do not have permission to read this project.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('calendar_feed_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', parsed.data.feedId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'revokeCalendarFeed', detail: error.message }));
    return err('INTERNAL', 'Could not revoke the feed.');
  }
  if (!data) return err('NOT_FOUND', 'That feed is not yours, or is already revoked.');
  return ok({ revoked: true });
}
