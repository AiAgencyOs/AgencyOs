import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

// approvals.request_approval is SECURITY DEFINER granted to authenticated, and
// its only gate was tenant (the org check). Its siblings decide_approval and
// cancel_request each also check authority; request_approval was left without
// one, so a client (the lowest-privilege portal role) could raise into the
// staff approval queue, forge a requester, flood it, and inject text into the
// internal WhatsApp announcement (20260815400000). Both request_approval and
// the config read it calls, resolve_policy, now carry the is_internal() gate,
// each exempting the identity-less service-role/agent path.
//
// This pins the gate on the LAST definition of each function, so a future
// verbatim regeneration that drops the injected line fails here rather than
// silently reopening the queue to clients while service-role scripts stay green.

const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** The comment-stripped body of the LAST migration that defines <qualifiedName>. */
function effectiveDefinition(qualifiedName: string): string | null {
  const marker = `function ${qualifiedName}(`;
  let found: string | null = null;
  for (const f of files) {
    const code = sqlCode(readFileSync(dir + f, 'utf8'));
    const idx = code.toLowerCase().lastIndexOf(marker);
    if (idx < 0) continue;
    const rest = code.slice(idx + marker.length);
    const nextIdx = rest.toLowerCase().indexOf('create or replace function');
    found = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
  }
  return found;
}

describe('the approval queue is staff-and-agent territory, not a client surface', () => {
  test('request_approval refuses a caller with an identity that is not internal', () => {
    const body = effectiveDefinition('approvals.request_approval');
    assert.ok(body, 'no definition of approvals.request_approval found');
    // The gate: an actor with an identity must be internal; the no-actor
    // (service-role / agent) path is exempt.
    assert.match(
      body!,
      /v_actor is not null and not \(select core\.is_internal\(\)\)/i,
      'request_approval must refuse a non-internal caller (a client), exempting the identity-less service role',
    );
  });

  test('resolve_policy only returns config to an internal caller (or the no-org service role)', () => {
    const body = effectiveDefinition('approvals.resolve_policy');
    assert.ok(body, 'no definition of approvals.resolve_policy found');
    assert.match(
      body!,
      /core\.current_organization_id\(\) is null or core\.is_internal\(\)/i,
      'resolve_policy must gate its read on is_internal(), so a client cannot read the queue’s policy config',
    );
  });
});
