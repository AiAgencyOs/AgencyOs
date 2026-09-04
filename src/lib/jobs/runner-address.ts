import 'server-only';

/**
 * Where the runner lives and how to prove you may call it — G-209.
 *
 * Split from `nudge.ts` so both halves can be tested without a network: the
 * address and the credentials are pure functions of the environment, and they
 * are the part that silently misbehaves when a deployment moves.
 */

/**
 * The app's own origin, from the same variable the rest of the system trusts
 * for it. `NEXT_PUBLIC_APP_URL` is required in production and validated
 * there (https, non-localhost), so this does not re-litigate its shape — it
 * only refuses an absent one.
 *
 * `VERCEL_URL` is the fallback and carries no scheme, which is why it is
 * prefixed rather than used raw.
 */
export function runnerUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const vercel = process.env.VERCEL_URL?.trim();
  const origin = configured || (vercel ? `https://${vercel}` : '');
  if (!origin) return null;
  return `${origin.replace(/\/+$/, '')}/api/jobs/run`;
}

/**
 * The two doors the deployed runner has, exactly as the external cron sends
 * them (`docs/deployment/cron-external-trigger.md`).
 *
 * `CRON_SECRET` is the app's own auth and is required — without it the runner
 * answers 401 and the nudge is pointless. The Vercel protection bypass is
 * added only when set, because a deployment without preview protection does
 * not need it and sending an empty header would be a header that means
 * nothing.
 */
export function runnerAuthHeaders(): Record<string, string> | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return null;

  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  return headers;
}
