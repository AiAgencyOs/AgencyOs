/**
 * Boot-time configuration validation.
 *
 * `register` runs once, before the server accepts a request, and must complete
 * first. Calling `serverEnv()` here forces the full parse AND the
 * production-config check (src/lib/env.ts) to happen at startup — so a
 * deployment missing CRON_SECRET, or carrying a test base-URL override, or
 * pointed at http://localhost, refuses to start with every offending variable
 * named, rather than booting and then 503-ing its cron heartbeat or 500-ing a
 * request three layers deep.
 *
 * Guarded to the Node.js runtime: `register` is called in every runtime
 * (Node and Edge), and secrets belong only to the server. In development and
 * test the same call still runs, catching a malformed value the moment the
 * dev server starts rather than on the first API hit.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { serverEnv, assertProductionConfig } = await import('@/lib/env');
    serverEnv(); // shape of every variable
    assertProductionConfig(); // completeness, in production only
  }
}
