import { constantTimeEquals } from './constant-time';

/**
 * The job runner's shared-secret check, lifted out of the route.
 *
 * This is the *same* mechanism `app/api/jobs/run/route.ts` has always used —
 * `Authorization: Bearer <CRON_SECRET>`, compared whole — not a second one.
 * It lives here so the decision can be exercised without booting Next, a
 * Supabase client and an AI provider just to assert that a missing header is
 * a 401.
 *
 * Vercel Cron is the intended caller. When `CRON_SECRET` is present in a
 * project's environment, Vercel attaches exactly this header to every cron
 * invocation, which is why the scheduler needs no credential of its own.
 *
 * Nothing here logs, echoes or otherwise renders the secret. The failure
 * bodies are constants.
 */

export type CronAuth =
  /** The caller presented the configured secret. */
  | { ok: true }
  /**
   * Refused. `status` is 503 when the deployment has no secret configured —
   * the runner is *disabled*, not *forbidden*, and saying so is the honest
   * answer — and 401 for every failure of the presented credential.
   */
  | { ok: false; status: 401 | 503; error: string };

/** The body returned when the deployment never configured a secret. */
export const CRON_DISABLED = 'job runner disabled: CRON_SECRET is not configured';

/** The body returned for every rejected credential, whatever was wrong with it. */
export const CRON_UNAUTHORIZED = 'unauthorized';

/**
 * Decides whether a request may run jobs.
 *
 * @param presented the raw `Authorization` header, or null when absent
 * @param secret    the configured `CRON_SECRET`, or undefined when unset
 *
 * The comparison is against the entire header value, so the `Bearer ` scheme
 * is required by construction: a bare secret, a different scheme, or a
 * differently-cased prefix all fail the same way, and all fail closed. An
 * unset secret refuses everything — a deployment that has not configured the
 * runner is inert rather than open.
 *
 * It is also **constant-time** — gap G-131. This used `!==`, while the two
 * other secret comparisons in this repository (the WhatsApp subscription token
 * and the webhook HMAC) both went through a constant-time helper that
 * documented the tradeoff. Nothing here recorded a reason for the difference,
 * which is what marked it as an oversight rather than a weighed decision.
 */
export function authorizeCronRequest(
  presented: string | null | undefined,
  secret: string | undefined,
): CronAuth {
  if (!secret) return { ok: false, status: 503, error: CRON_DISABLED };
  // `presented` may be null; the helper needs a string, and a null header must
  // reach the same refusal as a wrong one rather than a different branch.
  if (!presented || !constantTimeEquals(presented, `Bearer ${secret}`)) {
    return { ok: false, status: 401, error: CRON_UNAUTHORIZED };
  }
  return { ok: true };
}
