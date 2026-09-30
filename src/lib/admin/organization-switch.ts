import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * The organisation selector — SCR-001 (bucket F, stream F-A; migration
 * 20261001100000 §4).
 *
 * A person may hold active memberships in more than one organisation, and
 * the token hook always chose the highest-ranked one. `switchOrganization`
 * records the one they chose (`core.user_preferences.current_organization_id`,
 * through `core.switch_organization`, audited as `organization.switched` in
 * the organisation being left) and then refreshes the session so the hook
 * re-runs and the NEXT request carries the new claims. Nothing here changes
 * a claim by hand: the hook stays the only thing that stamps one.
 *
 * `listMyOrganizations` goes through `core.list_my_organizations` because
 * `memberships_select` is scoped to the current organisation — a person
 * cannot see their other memberships through the table.
 */

export type MyOrganization = { organizationId: string; name: string; role: string; isCurrent: boolean };

export async function listMyOrganizations(): Promise<MyOrganization[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('list_my_organizations');
  if (error) unreadable('listMyOrganizations', error);
  return ((data ?? []) as { organization_id: string; name: string; role: string; is_current: boolean }[]).map((r) => ({
    organizationId: r.organization_id,
    name: r.name,
    role: r.role,
    isCurrent: r.is_current,
  }));
}

export const switchOrganizationSchema = z.object({ organizationId: z.uuid() });

export async function switchOrganization(input: { organizationId: string }): Promise<Result<{ organizationId: string }>> {
  const parsed = switchOrganizationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Choose an organisation.');
  await requireInternal();

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('switch_organization', { p_organization_id: parsed.data.organizationId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'switchOrganization', detail: error.message }));
    return err('INTERNAL', 'The organisation could not be switched.');
  }
  const outcome = (data as { outcome: string }[] | null)?.[0]?.outcome ?? 'no answer';
  switch (outcome) {
    case 'switched':
      break;
    case 'unchanged':
      return ok({ organizationId: parsed.data.organizationId });
    case 'not_a_member':
      return err('FORBIDDEN', 'You hold no active membership of that organisation.');
    case 'unauthenticated':
      return err('UNAUTHORIZED', 'Sign in again to switch organisation.');
    case 'no_organization':
      return err('FORBIDDEN', 'No organisation on this session.');
    default:
      return err('INTERNAL', `The database refused the switch (${outcome}).`);
  }

  // The choice is recorded; the token still names the old organisation until
  // the hook runs again. Refreshing re-mints it now, so the redirect that
  // follows lands in the chosen organisation rather than one request late.
  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) {
    console.error(JSON.stringify({ level: 'warn', scope: 'switchOrganization', detail: `recorded but token refresh failed: ${refreshError.message}` }));
    return err('INTERNAL', 'The switch was recorded but the session could not be refreshed — sign out and back in.');
  }
  return ok({ organizationId: parsed.data.organizationId });
}
