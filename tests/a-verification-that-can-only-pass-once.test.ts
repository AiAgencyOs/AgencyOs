import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * A verification that can only pass once is not a verification — G-175.
 *
 * ── what happened ─────────────────────────────────────────────────────────
 *
 * `verify-flow-01.mjs` delivered its webhook messages under provider ids built
 * from a CONSTANT marker: `wamid.zztest-flow01.human.1`, the same string on
 * every run, for ever. `crm.ingest_whatsapp_message` is idempotent on that id —
 * correctly, that is what stops Meta's redeliveries duplicating a customer's
 * words. So the first run of the script on a given database stored the message
 * and every run after it was a REPLAY.
 *
 * The failure mode is the nasty one. A replay does not error. The script's own
 * sender number is fresh each run, so the ingest happily created a contact, a
 * lead and an empty conversation, appended nothing to it, emitted no
 * `message.received`, and queued no `reply.compose`. Section P then waited
 * sixty ticks for a pause that nothing was ever going to write, and reported:
 *
 *     ✗ the conversation is handed to a person — still answering
 *
 * The code it guards was fine. It had been fine the whole time.
 *
 * ── why it did not show up sooner ─────────────────────────────────────────
 *
 * CI runs against a database built from migrations, so the first run is the
 * only run and it always passes. The rot is only visible on a database that
 * has run the script before — which is every developer's machine, and none of
 * CI. A green pipeline and a red laptop, for eight days, over four
 * requirements: the agent handing a conversation to a person, the agent then
 * staying silent, the escalation reaching the internal channel, and the
 * announcement carrying the agent's own reason. Those were the only checks in
 * the repository covering any of it.
 *
 * ── the two strategies, and this is the rule ──────────────────────────────
 *
 * A script that plants inbound messages has to make its fixtures its own. Two
 * ways exist here already and both are sound:
 *
 *   OWN THE TENANT   verify-whatsapp-ingest, verify-whatsapp-webhook and
 *                    verify-requirement-proposal create their own
 *                    organization and DROP it before they start — *"a previous
 *                    interrupted run must not change what this one observes."*
 *                    A constant provider id is safe inside a tenant that no
 *                    longer exists.
 *
 *   KEY PER RUN      verify-media-reading and verify-journey plant into the
 *                    shared demo organization and put a fresh token in every
 *                    provider id. verify-flow-01 does this now.
 *
 * `verify-flow-01` had NEITHER, which is what this test refuses to let happen
 * again. It is asserted over the whole fleet rather than over one file,
 * because the next script to plant a message is the one nobody will remember
 * this about.
 *
 * The empirical half of the proof does not live here — it cannot. It is that
 * every script named below was run TWICE IN A ROW against a database that
 * already held its fixtures, and every one of them passed both times.
 */

const root = new URL('../', import.meta.url);
const scriptsDir = fileURLToPath(new URL('scripts/', root));

/**
 * Comments stripped, always. These assertions are about the ids a script
 * BUILDS, and the docblock that explains the defect quotes the broken shape
 * verbatim — prose satisfying a claim about code is the exact mistake
 * `_code-only.ts` was extracted to stop.
 */
const read = (name: string) => codeOnly(readFileSync(`${scriptsDir}${name}`, 'utf8'));

const scripts = readdirSync(scriptsDir).filter(
  (name) => name.startsWith('verify-') && (name.endsWith('.mjs') || name.endsWith('.ts')),
);

/**
 * Does this script put messages INTO the system, rather than merely reading
 * them? Only those are exposed: a script that names a `wamid` as evidence on
 * an approval, or as the provider reference of an OUTBOUND send, is not
 * touching the ingest's idempotency at all.
 */
function plantsInboundMessages(source: string): boolean {
  return (
    source.includes('/api/webhooks/whatsapp') ||
    source.includes('ingest_whatsapp_message') ||
    source.includes('ingest_group_message')
  );
}

/** The script builds and destroys its own tenant, so a constant id is safe. */
function ownsItsTenant(source: string): boolean {
  return /(?:remove|rest\(\s*'DELETE'|request\(\s*'DELETE')[^\n]*organizations\?slug=eq\./.test(source);
}

/**
 * Every provider-id literal the script constructs.
 *
 * Both quoting styles, because a constant id has no interpolation and is
 * therefore usually written in single quotes — which is exactly the shape
 * being looked for.
 */
function providerIdLiterals(source: string): string[] {
  return [
    ...(source.match(/`wamid\.[^`]*`/g) ?? []),
    ...(source.match(/'wamid\.[^']*'/g) ?? []),
  ];
}

/** Something whose value differs between two runs of the same script. */
const VARIES_PER_RUN = /randomUUID|Date\.now|Math\.random|crypto\.randomUUID/;

/**
 * Is this identifier bound to a constant in this script?
 *
 * Resolved from the script's own source rather than assumed from the name,
 * and that distinction is the whole point. `verify-flow-01` writes
 * `const MARKER = 'zztest-flow01'` — a constant wearing a variable's
 * spelling, which is why the rot was invisible. `verify-delivery-receipts`
 * writes ``const MARK = `zzrcpt-${randomUUID().slice(0, 8)}` `` — a variable
 * with almost the same name and the opposite property. A rule that judged by
 * name would have called one of them wrong.
 *
 * An identifier this cannot resolve is treated as constant, so the failure
 * lands on somebody's screen rather than being waved through.
 */
function resolvesToAConstant(identifier: string, source: string): boolean {
  const binding = new RegExp(`const\\s+${identifier}\\s*=\\s*([^;\n]+)`).exec(source);
  const rightHandSide = binding?.[1];
  if (rightHandSide === undefined) return true;
  return !VARIES_PER_RUN.test(rightHandSide);
}

/**
 * A literal is run-unique when at least one thing it interpolates changes
 * between runs.
 */
function isRunUnique(literal: string, source: string): boolean {
  const slots = literal.match(/\$\{([^}]*)\}/g) ?? [];
  return slots.some((slot) => {
    const expression = slot.slice(2, -1).trim();
    if (VARIES_PER_RUN.test(expression)) return true;
    const identifier = /^[A-Za-z_$][\w$]*$/.exec(expression)?.[0];
    if (identifier) return !resolvesToAConstant(identifier, source);
    // A call or a member expression this cannot read: assume it is derived
    // from something that moves. Anything else would flag every helper.
    return /\(|\./.test(expression);
  });
}

describe('A. a script that plants inbound messages owns its fixtures', () => {
  const planters = scripts.filter((name) => plantsInboundMessages(read(name)));

  test('the fleet is found at all — an empty sweep proves nothing', () => {
    // Without this, a rename of the scripts directory would turn every
    // assertion below into a loop over nothing, and the suite would go green
    // by having stopped looking.
    assert.ok(scripts.length > 40, `only ${scripts.length} verification scripts found`);
    assert.ok(planters.length >= 5, `only ${planters.length} scripts plant inbound messages`);
    assert.ok(planters.includes('verify-flow-01.mjs'), 'verify-flow-01 must be in scope');
  });

  test('each one either drops its own tenant or keys every provider id per run', () => {
    const offenders: string[] = [];

    for (const name of planters) {
      const source = read(name);
      if (ownsItsTenant(source)) continue;

      for (const literal of providerIdLiterals(source)) {
        // A stub Graph API answering with an id of its own is not an ingest
        // key; it never reaches crm.ingest_whatsapp_message.
        if (/stub/i.test(literal)) continue;
        if (!isRunUnique(literal, source)) offenders.push(`${name}: ${literal}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these plant a message under an id that never changes, so the second run is a replay:\n  ${offenders.join('\n  ')}`,
    );
  });
});

describe('B. verify-flow-01, specifically, because it is the one that rotted', () => {
  const source = read('verify-flow-01.mjs');

  test('the run token exists and every provider id goes through it', () => {
    assert.match(source, /const RUN = randomUUID\(\)\.slice\(0, 8\)/);
    assert.match(source, /const wamid = \(suffix\) => `wamid\.\$\{MARKER\}\.\$\{RUN\}\.\$\{suffix\}`/);

    // No caller may build one by hand and miss the token. The helper's own
    // definition is the single literal that mentions MARKER this way.
    const built = source.match(/`wamid\.\$\{MARKER\}[^`]*`/g) ?? [];
    assert.equal(built.length, 1, 'a provider id is being built outside the helper');
  });

  test('the fixtures the INGEST created are registered for cleanup, not just the ones inserted', () => {
    // The other half of the rot. Sections P and Q reach the database through
    // the webhook, so their contact, lead and conversation are made by the
    // ingest — invisible to a cleanup that only knew what it had inserted
    // itself, and left behind on every run.
    assert.match(source, /const humanSeed = one\(await rest\('GET', 'crm',/);
    assert.match(source, /const escSeed = one\(await rest\('GET', 'crm',/);
    assert.match(source, /if \(humanSeed\?\.lead_id\) created\.leads\.push\(humanSeed\.lead_id\);/);
    assert.match(source, /if \(escSeed\?\.lead_id\) created\.leads\.push\(escSeed\.lead_id\);/);
  });

  test('registration happens BEFORE the assertions, so a failing run still tidies up', () => {
    // Registering after the checks would mean the run that fails is exactly
    // the run that leaves debris — and debris is what makes the next run fail
    // worse. This is the ordering that stops one bad run compounding.
    const registered = source.indexOf('created.leads.push(humanSeed.lead_id)');
    const asserted = source.indexOf("'the conversation is handed to a person'");
    assert.ok(registered > 0 && asserted > registered, 'the P fixture is registered after it is asserted on');
  });

  test('and it clears what an earlier run left, so a poisoned database heals itself', () => {
    // Found on a database carrying rows from 24 August that no cleanup had
    // ever been able to reach. A fix that needs somebody to hand-delete rows
    // first is not a fix.
    assert.match(source, /contacts\?organization_id=eq\.\$\{ORG\}&full_name=like\.\$\{MARKER\}\*/);
    assert.match(source, /cleared \$\{residue\.length\} fixture\(s\) an earlier run left behind/);
  });
});
