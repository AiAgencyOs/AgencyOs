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

/** The clock for this request's organisation. */
export async function agencyClock(): Promise<AgencyClock> {
  return clockFor(await getAgencyTimeZone());
}

export { clockFor, type AgencyClock } from './clock';
