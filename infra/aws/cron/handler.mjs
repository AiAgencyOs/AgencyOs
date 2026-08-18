// AgencyOS cron tick — the AWS half of the external scheduler.
//
// EventBridge Scheduler fires this once a minute; it makes ONE POST to
// /api/jobs/run carrying the app's CRON_SECRET bearer AND the Vercel Protection
// Bypass header, so it passes BOTH doors — Vercel Deployment Protection at the
// edge, and the runner's own auth in the app (see docs/deployment/
// cron-external-trigger.md). It does NO job logic: the existing runner and
// outbox own all of that. One clock, no second queue or job system.
//
// Secrets are read from Secrets Manager at RUNTIME, never held in the Lambda's
// environment (env vars are readable via GetFunctionConfiguration). SECRET_ARN —
// itself not a secret — names a JSON secret holding PROD_URL, CRON_SECRET and
// VERCEL_AUTOMATION_BYPASS_SECRET.

/**
 * Builds the single POST the tick makes. Pure — separated so it can be
 * unit-tested with no AWS and no network. Throws on the two values that make a
 * tick impossible; the bypass header is optional, because a deployment without
 * Deployment Protection needs none (and a wrong header there would 302).
 *
 * @param {{PROD_URL?: string, CRON_SECRET?: string, VERCEL_AUTOMATION_BYPASS_SECRET?: string}} config
 * @returns {{url: string, method: string, headers: Record<string, string>}}
 */
export function buildTickRequest(config) {
  const base = String(config?.PROD_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('PROD_URL is not set in the secret');
  if (!config?.CRON_SECRET) throw new Error('CRON_SECRET is not set in the secret');

  const headers = { Authorization: `Bearer ${config.CRON_SECRET}` };
  if (config.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers['x-vercel-protection-bypass'] = config.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  return { url: `${base}/api/jobs/run`, method: 'POST', headers };
}

/**
 * Reads the JSON secret at runtime. The AWS SDK is imported dynamically so this
 * module can be loaded (for buildTickRequest) without the SDK installed — the
 * Lambda nodejs20.x runtime provides @aws-sdk/* natively. Not cached: an
 * every-minute GetSecretValue is a rounding error in cost and keeps a rotated
 * secret from being served stale by a warm container.
 */
async function loadConfig() {
  const arn = process.env.SECRET_ARN;
  if (!arn) throw new Error('SECRET_ARN is not set on the function');
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(out.SecretString ?? '{}');
}

export const handler = async () => {
  const req = buildTickRequest(await loadConfig());
  const res = await fetch(req.url, { method: req.method, headers: req.headers });
  // A tick that could not reach the runner must be LOUD: a thrown error marks the
  // invocation failed, so the CloudWatch alarm and the schedule's dead-letter
  // queue fire. A clock that silently stops mattering is the failure mode this
  // exists to make observable (Phase 3). The runner is idempotent, so the next
  // minute — or a redriven DLQ message — catches up with no double-run.
  if (!res.ok) throw new Error(`tick failed: HTTP ${res.status}`);
  return { ok: true, status: res.status };
};
