import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  PHASE_FOUR_EVENT_MAP,
  isEventLiveInCatalog,
  phase4EventFor,
} from '../src/lib/events/phase4-event-map.ts';

/**
 * P4-INFRA-04 — the spec-name → real-event-name mapping.
 *
 * Impl §8 / ORCH §19 name Phase 4 events (`UIDesignReady`,
 * `M2PaymentVerified`, ...) that do not exist as literal strings anywhere in
 * this codebase and are not going to be renamed to match — that would be a
 * breaking, migration-adjacent change for a cosmetic win. `phase4-event-map.ts`
 * is the alternative: a small, explicit table translating each spec name to
 * the real event this codebase actually fires.
 *
 * A translation table that silently rots is worse than none — a reader would
 * trust a mapping pointing at a name `catalog.ts` no longer carries. This is
 * the drift guard: every entry the table claims is "documented in the
 * catalog" is re-checked against `SUBSCRIPTIONS` on every test run, so a
 * rename or removal in `catalog.ts` fails here rather than being discovered
 * by whoever reads the stale mapping next.
 */
describe('P4-INFRA-04 — the Phase 4 spec-event-name map does not drift from the catalog', () => {
  test('every spec event named in Impl §8 / ORCH §19 has a row', () => {
    const specNames = [
      'UIDesignReady',
      'UIDesignQAPassed',
      'AdminUIApproved',
      'ClientUIApproved',
      'PrototypeBuildReady',
      'PrototypeQAPassed',
      'AdminPrototypeApproved',
      'ClientPrototypeApproved',
      'Phase4Completed',
      'M2PaymentVerified',
    ];
    for (const name of specNames) {
      assert.ok(phase4EventFor(name), `no mapping row for spec event "${name}"`);
    }
    assert.equal(PHASE_FOUR_EVENT_MAP.length, specNames.length);
  });

  test('a row claiming documentedInCatalog: true really is a live SUBSCRIPTIONS key', () => {
    // The drift guard. If a future refactor renames or removes
    // `project.ui_version_admin_reviewed` (or any other real event this table
    // points at) from `catalog.ts`'s SUBSCRIPTIONS, this fails immediately
    // instead of leaving a mapping that points at nothing.
    for (const entry of PHASE_FOUR_EVENT_MAP) {
      if (!entry.documentedInCatalog) continue;
      assert.ok(
        entry.realEventName,
        `${entry.specName} claims documentedInCatalog but names no realEventName`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(SUBSCRIPTIONS, entry.realEventName as string),
        `${entry.specName} maps to "${entry.realEventName}", which is no longer a key of catalog.ts's SUBSCRIPTIONS`,
      );
      assert.equal(
        isEventLiveInCatalog(entry.realEventName as string),
        true,
        `isEventLiveInCatalog disagrees with SUBSCRIPTIONS for "${entry.realEventName}"`,
      );
    }
  });

  test('a row honestly marked documentedInCatalog: false is NOT silently live', () => {
    // The one deliberate exception (PrototypeQAPassed / project.prototype_qa_reviewed)
    // must stay an honest gap, not quietly become "documented" without this
    // table being updated to say so — and not vanish from the catalog entirely
    // (it's still a real producer, just with no subscriber yet).
    const undocumented = PHASE_FOUR_EVENT_MAP.filter((e) => !e.documentedInCatalog);
    assert.ok(undocumented.length >= 1, 'expected at least the PrototypeQAPassed gap to be named');
    for (const entry of undocumented) {
      assert.equal(
        isEventLiveInCatalog(entry.realEventName as string),
        false,
        `${entry.specName} is marked documentedInCatalog: false but "${entry.realEventName}" IS a live SUBSCRIPTIONS key now — flip the flag and update the note`,
      );
    }
  });

  test('no two rows silently disagree about which real event they share', () => {
    // AdminPrototypeApproved and ClientPrototypeApproved are DELIBERATELY the
    // same real event (project.deliverable_decided) per the module's own
    // docblock. This pins that it is exactly those two, not a wider drift.
    const bySharedEvent = new Map<string, string[]>();
    for (const entry of PHASE_FOUR_EVENT_MAP) {
      if (!entry.realEventName) continue;
      const list = bySharedEvent.get(entry.realEventName) ?? [];
      list.push(entry.specName);
      bySharedEvent.set(entry.realEventName, list);
    }
    const shared = [...bySharedEvent.entries()].filter(([, names]) => names.length > 1);
    assert.deepEqual(
      shared.map(([event, names]) => [event, names.sort()]),
      [['project.deliverable_decided', ['AdminPrototypeApproved', 'ClientPrototypeApproved']]],
    );
  });

  test('phase4EventFor answers null for an unknown spec name', () => {
    assert.equal(phase4EventFor('SomethingNoSpecNames'), null);
  });
});
