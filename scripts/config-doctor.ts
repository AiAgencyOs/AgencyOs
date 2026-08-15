#!/usr/bin/env node
/**
 * config-doctor — is this environment fit to deploy?
 *
 *   npm run config:doctor                 # check the current environment as-is
 *   npm run config:doctor -- --production # check it as if NODE_ENV=production
 *
 * The runbook's "required in production" table, made runnable. It reports, per
 * variable, whether it is set and well-shaped, and — under production rules —
 * what is missing or unsafe. It shares the exact schema and rules the app
 * enforces at boot (src/lib/env-schema.ts).
 *
 * For every SERVER secret, a green run here means the startup check
 * (src/instrumentation.ts) will pass — both read process.env at runtime. The
 * one exception is NEXT_PUBLIC_APP_URL: Next.js inlines NEXT_PUBLIC_* at BUILD
 * time, so the app checks the value baked into the build while this script
 * checks the value in the current shell. Run this in the SAME environment the
 * build uses (on Vercel, the project's env), or the two can disagree.
 *
 * It NEVER prints a value and NEVER invents one: the production blanks are
 * ADM-60's, the owner's to fill. A missing secret is reported by name, not
 * guessed. Set variables are shown only as "set", never echoed and without
 * their length — this output is safe to paste into an issue.
 */

import { clientSchema, serverSchema, productionConfigProblems } from '../src/lib/env-schema.ts';

const assumeProduction = process.argv.includes('--production');
const raw = process.env;

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

console.log(`\nconfig-doctor — checking the environment${assumeProduction ? ' under PRODUCTION rules' : ''}\n`);

// Parse under the requested mode. NODE_ENV drives the production rules; the
// flag lets an operator dry-run production checks from a laptop.
const serverRaw = { ...raw };
if (assumeProduction) serverRaw.NODE_ENV = 'production';

const client = clientSchema.safeParse(raw);
const server = serverSchema.safeParse(serverRaw);

let fatal = 0;

console.log('Public (browser-visible) variables:');
if (client.success) {
  console.log(`  ${g('✓')} all present and well-formed`);
} else {
  for (const issue of client.error.issues) {
    fatal += 1;
    console.log(`  ${r('✗')} ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
}

console.log('\nServer secrets — shape only, never values:');
if (server.success) {
  const optionalKeys = [
    'CRON_SECRET', 'ANTHROPIC_API_KEY', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET',
    'ALERT_WEBHOOK_URL', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_GRAPH_BASE_URL', 'ANTHROPIC_BASE_URL',
  ] as const;
  console.log(`  ${g('✓')} SUPABASE_SERVICE_ROLE_KEY set, NODE_ENV=${server.data.NODE_ENV}`);
  for (const k of optionalKeys) {
    const v = server.data[k as keyof typeof server.data];
    console.log(v ? `  ${g('✓')} ${k} ${dim('(set)')}` : `  ${y('○')} ${k} ${dim('(unset)')}`);
  }
} else {
  for (const issue of server.error.issues) {
    fatal += 1;
    console.log(`  ${r('✗')} ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
}

if (server.success) {
  const appUrl = client.success ? client.data.NEXT_PUBLIC_APP_URL : (raw.NEXT_PUBLIC_APP_URL ?? '');
  const problems = productionConfigProblems(server.data, appUrl);
  console.log(`\nProduction readiness${assumeProduction || server.data.NODE_ENV === 'production' ? '' : ' (not in production; run with --production to force)'}:`);
  if (server.data.NODE_ENV !== 'production' && !assumeProduction) {
    console.log(`  ${dim('— skipped —')}`);
  } else if (problems.length === 0) {
    console.log(`  ${g('✓')} every production-required value is present and safe`);
  } else {
    for (const p of problems) {
      fatal += 1;
      console.log(`  ${r('✗')} ${p.variable}: ${p.problem}`);
    }
  }
}

if (fatal > 0) {
  console.error(`\n${r(`✖ ${fatal} problem(s) — this environment is not ready to deploy.`)}\n`);
  process.exit(1);
}
console.log(`\n${g('✔ The environment satisfies every check that was in scope.')}\n`);
