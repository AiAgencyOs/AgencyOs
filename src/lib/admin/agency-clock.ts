import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/db/server';

import { clockFor, type AgencyClock } from './clock';

/**
 * What time it is where the agency is.
 *
 * Every date and time in the admin panel was rendered with a bare
 * `new Intl.DateTimeFormat('en-IN', …)`, which formats in the **runtime's**
 * zone. On a developer's laptop that is the agency's zone and the bug is
 * invisible; on Vercel the runtime is UTC, so an agency in Asia/Kolkata read
 * every screen five and a half hours behind. A message sent at 00:13 showed as
 * 6:43 pm — and, worse, landed under **yesterday's** date divider, because the
 * grouping is derived from the same wrong reading.
 *
 * The organisation already stores the answer. `core.organizations.timezone` is
 * set on the Settings page, validated against Postgres's IANA list, and the
 * follow-up worker has always used it (`timeZone: zone`) — so the system knew
 * the right zone and only the screens did not.
 *
 * A global `TZ` on the deployment would have silenced this in one line and been
 * wrong in principle: the timezone is per organisation, which is exactly why it
 * is a column rather than a config value.
 *
 * `cache()` makes this one read per request however many components ask.
 */

/** Falls back to UTC — visibly wrong in one place beats silently wrong everywhere. */
const FALLBACK = 'UTC';

export const getAgencyTimeZone = cache(async (): Promise<string> => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('organizations')
    .select('timezone')
    .limit(1)
    .maybeSingle();

  // Deliberately not `unreadable()`: a clock that cannot be read is not a
  // reason to refuse a page. The times render in UTC and the Settings page
  // says the timezone is unset, which is the honest pair.
  if (error) return FALLBACK;

  return data?.timezone ?? FALLBACK;
});

/**
 * The zone dates are DISPLAYED in for this request: the signed-in person's
 * own preference (core.user_preferences.timezone, bucket E decision E3) when
 * they have set one, else the organisation's. `cache()` resolves it once per
 * request — the internal layout asks first, every page and component after
 * it gets the same answer without a second read.
 *
 * The preference row is read under RLS, which admits only the caller's own
 * row: with no session there is no row, and the organisation's zone stands.
 * A table PostgREST cannot see yet, or any other failed read, is not a reason
 * to refuse a page — the organisation's zone stands for the same reason the
 * fallback above is UTC.
 */
export const getDisplayTimeZone = cache(async (): Promise<string> => {
  const supabase = await createClient();

  const [preference, organization] = await Promise.all([
    supabase.schema('core').from('user_preferences').select('timezone').limit(1).maybeSingle(),
    getAgencyTimeZone(),
  ]);

  if (preference.error) return organization;
  const own = preference.data?.timezone?.trim();
  return own && own.length > 0 ? own : organization;
});

/**
 * The clock for this request. Defaults to the display zone above — the
 * person's preference, else the organisation's; an explicit `timeZone` pins
 * it (a PDF rendered in the agency's zone regardless of who pressed print).
 */
export async function agencyClock(timeZone?: string): Promise<AgencyClock> {
  return clockFor(timeZone ?? (await getDisplayTimeZone()));
}

export { clockFor, type AgencyClock } from './clock';
