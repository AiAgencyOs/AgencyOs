#!/usr/bin/env node
/**
 * Marks every unpublished outbox event published, on the ISOLATED verification database only.
 *
 * Every lead a verification step plants leaves a `lead.created` event (the router and the classifier subscribe to it), and nothing in the
 * steps before the app-driven chain ticks the dispatcher, so by the time that chain starts the unpublished backlog is far larger than one
 * dispatch batch. The chain's first scripts dispatch one batch of the OLDEST events and look for their own among them; the backlog is not
 * theirs and not what they measure, so it is cleared once, here, before they run. Refuses to touch anything but `.env.verify.local`'s
 * database: on a real one an unpublished event is work somebody is owed.
 */
import { resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: false });
if (!target.isolated) fail('refusing: this clears unpublished events, and the target is not the isolated verification database (.env.verify.local).');

const res = await fetch(`${target.url}/rest/v1/outbox_events?published_at=is.null`, {
  method: 'PATCH',
  headers: {
    apikey: target.serviceKey,
    Authorization: `Bearer ${target.serviceKey}`,
    'Content-Type': 'application/json',
    'Content-Profile': 'core',
    'Accept-Profile': 'core',
    Prefer: 'return=headers-only,count=exact',
  },
  body: JSON.stringify({ published_at: new Date().toISOString() }),
});
if (!res.ok) fail(`could not clear the backlog: HTTP ${res.status} ${await res.text()}`);
console.log(`cleared ${res.headers.get('content-range')?.split('/')[1] ?? '?'} unpublished event(s) on ${target.file}`);
