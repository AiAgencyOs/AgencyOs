import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  SALES_ACTIVITY_KINDS,
  SALES_ACTIVITY_LABELS,
  recordSalesActivitySchema,
} from '../src/modules/crm/schema.ts';

/**
 * The six sales activities — gap G-010, decision ADM-10 §7.
 *
 * §7 keeps the pipeline at four stages and moves contacted, sample sent, demo
 * sent, offer sent, follow-up and advance requested *out* of it, to be
 * "recorded as a timestamped activity on the lead". The 2026-08-14 audit found
 * the stage half exact and the activity half never built: `lead_activities.kind`
 * admitted seven values, none of them these, and four of the six appeared
 * nowhere in the repository at all.
 *
 * These tests pin both halves of the fix — the vocabulary and the fact that the
 * audit log stops calling them notes — and pin what was deliberately *not*
 * changed, because that is where a later edit would do harm quietly.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120000_the_six_the_pipeline_let_go.sql');
const rules = read('../docs/business-os/02-business-rules.md');

describe('A. the six are the six ADM-10 names, and no more', () => {
  test('exactly six, in §7 order', () => {
    assert.deepEqual(
      [...SALES_ACTIVITY_KINDS],
      ['contacted', 'sample_sent', 'demo_sent', 'offer_sent', 'follow_up', 'advance_requested'],
    );
  });

  test('and every one of them is named in the business rules §7', () => {
    // The decision is the requirement. If a kind here is not in the document,
    // it was invented — which is the one thing ADM-10 forbids about this list.
    const section = rules.slice(rules.indexOf('## 7.'), rules.indexOf('## 8.'));
    for (const phrase of ['contacted', 'sample sent', 'demo sent', 'offer sent', 'follow-up', 'advance requested']) {
      assert.ok(section.toLowerCase().includes(phrase), `§7 does not name "${phrase}"`);
    }
  });

  test('each reads as something before it reaches a screen', () => {
    for (const kind of SALES_ACTIVITY_KINDS) {
      assert.ok(SALES_ACTIVITY_LABELS[kind]?.length, `${kind} has no label`);
    }
  });
});

describe('B. the database admits them', () => {
  test('the CHECK carries all six', () => {
    for (const kind of SALES_ACTIVITY_KINDS) {
      assert.match(migration, new RegExp(`'${kind}'`), `the kind CHECK omits ${kind}`);
    }
  });

  test('and still carries the seven it shipped with', () => {
    // The migration replaces the constraint rather than extending it, so the
    // original seven are re-listed by hand — exactly the place a value gets
    // dropped without anybody noticing until a write fails in production.
    for (const kind of [
      'note', 'status_change', 'message_in', 'message_out', 'call', 'agent_run', 'assignment',
    ]) {
      assert.match(migration, new RegExp(`'${kind}'`), `the kind CHECK dropped ${kind}`);
    }
  });
});

describe('C. the audit log stops calling them notes', () => {
  test('each of the six audits as what it is', () => {
    for (const [kind, action] of [
      ['contacted', 'lead.contacted'],
      ['sample_sent', 'lead.sample_sent'],
      ['demo_sent', 'lead.demo_sent'],
      ['offer_sent', 'lead.offer_sent'],
      ['follow_up', 'lead.follow_up_recorded'],
      ['advance_requested', 'lead.advance_requested'],
    ] as const) {
      assert.match(
        migration,
        new RegExp(`when '${kind}'\\s+then '${action.replace('.', '\\.')}'`),
        `${kind} is not audited as ${action}`,
      );
    }
  });

  test('and the seven older kinds still audit as lead.note_added', () => {
    // Deliberately unchanged. It is wrong for an assignment and is not this
    // change's to fix; correcting it alters what the audit log says about
    // behaviour nobody is touching, which deserves its own review.
    assert.match(migration, /else 'lead\.note_added'/);
  });

  test('the rest of the audit function is the live definition, untouched', () => {
    // The first draft of this migration regenerated the whole function from an
    // older copy and silently dropped the `proposals` branch, which would have
    // made every proposal write raise "no vocabulary for table". Pinned so a
    // future regeneration fails here rather than in production.
    for (const marker of [
      "when 'proposals' then",
      "'proposal.drafted'",
      'security invoker',
      'new.qualification is distinct from old.qualification',
    ]) {
      assert.ok(migration.includes(marker), `the live audit function lost: ${marker}`);
    }
  });
});

describe('D. what the recorder accepts', () => {
  test('a kind outside the six is refused', () => {
    for (const junk of ['note', 'demo', 'DEMO_SENT', '']) {
      assert.equal(
        recordSalesActivitySchema.safeParse({
          leadId: '00000000-0000-4000-8000-000000000001',
          kind: junk,
        }).success,
        false,
        `"${junk}" was accepted as a sales activity`,
      );
    }
  });

  test('the body is optional, because the act is the record', () => {
    const parsed = recordSalesActivitySchema.safeParse({
      leadId: '00000000-0000-4000-8000-000000000001',
      kind: 'demo_sent',
    });
    assert.equal(parsed.success, true);
  });

  test('and a stage is never accepted here — a deal has one, a lead has a history', () => {
    const parsed = recordSalesActivitySchema.safeParse({
      leadId: '00000000-0000-4000-8000-000000000001',
      kind: 'demo_sent',
      stage: 'proposal',
    });
    // Zod strips unknown keys rather than refusing, so the assertion is that
    // the stage does not survive into what gets written.
    assert.equal(parsed.success, true);
    assert.ok(!('stage' in (parsed.success ? parsed.data : {})), 'a stage reached the activity recorder');
  });
});

/**
 * G-114, ADM-72 — the accepted quotation is visible, not only auditable.
 *
 * ADM-72 ruled that a project may be created without an accepted quotation:
 * Document 10 §2's "should not be created" governs a moment ADM-13 never
 * gated, and every project predating quotations stays valid. Eight of its nine
 * requirements were already met by existing code. The ninth was not —
 * `proposal_id` was written by conversion since G-017 and read by nothing, so
 * the state was auditable and invisible, and requirement 5 asked for both.
 */
describe('E. whether a project has an accepted quotation is visible', () => {
  const page = read('../app/(internal)/projects/[projectId]/page.tsx');
  const queries = read('../src/modules/projects/queries.ts');

  test('the project detail actually selects proposal_id', () => {
    // The column existed and was never read. A surface cannot show what the
    // query does not fetch, which is how this stayed invisible for a fortnight.
    assert.match(queries, /DETAIL_SELECT[\s\S]{0,200}proposal_id/);
  });

  test('and the page states the absence rather than staying silent', () => {
    // Both branches say something. Silence would leave a reader guessing
    // whether a quotation exists and was not shown, or does not exist — the
    // ambiguity ADM-72 requirement 5 exists to remove.
    assert.match(page, /No accepted quotation is linked to this project/);
    assert.match(page, /Accepted quotation/);
  });

  test('and it does not gate anything on the quotation', () => {
    // ADM-72 is explicit: no fourth ADM-13 start condition, and no creation
    // gate. Showing the state must not quietly become enforcing it.
    assert.ok(
      !/proposal_id[\s\S]{0,120}(notFound|redirect|throw)/.test(page),
      'the project page refuses something when no quotation is linked',
    );
  });
});

/**
 * G-013 parts 1–2, ADM-12 — the list the Admin maintains.
 *
 * §5.3: *"AgencyOS may send samples, demos and past work only from a list the
 * Admin maintains. The list is empty until the Admin fills it; until then
 * AgencyOS sends nothing from it."*
 *
 * ADM-12's decision record claimed since 2026-08-13 that this table was built.
 * It was not. These tests are written against §5.3 rather than against that
 * record, which is the point of the gap.
 */
describe('F. the portfolio list', () => {
  const migration = read('../supabase/migrations/20260814120001_a_list_the_admin_maintains.sql');
  const page = read('../app/(internal)/portfolio/page.tsx');

  test('the three kinds are §5.3’s own words, and there is no fourth', async () => {
    const { PORTFOLIO_KINDS } = await import('../src/modules/crm/schema.ts');
    assert.deepEqual([...PORTFOLIO_KINDS], ['sample', 'demo', 'past_work']);
    assert.match(migration, /check \(kind in \('sample', 'demo', 'past_work'\)\)/);
  });

  test('the Admin maintains it — write is admin-only in the database too', () => {
    // Two layers, per ARCHITECTURE §8.1: the capability check in the service
    // and core.is_admin() in RLS. A caller that forgets the first meets the
    // second.
    assert.match(migration, /create policy portfolio_items_write[\s\S]{0,300}core\.is_admin\(\)/);
    assert.match(migration, /create policy portfolio_items_select[\s\S]{0,300}core\.is_internal\(\)/);
  });

  test('nothing is seeded — an empty configuration table is not a feature', () => {
    // ADM-73 established the principle and §5.3 states it outright. Inventing
    // three plausible portfolio items would be the fabrication ADM-76 refused
    // for qualification dates.
    assert.ok(
      !/insert into crm\.portfolio_items/i.test(migration),
      'the migration seeds portfolio content, which §5.3 says only the Admin supplies',
    );
  });

  test('and the empty state says the list is empty rather than looking finished', () => {
    assert.match(page, /The list is empty, so AgencyOS has nothing it may send/);
    assert.match(page, /Nothing is sent from this list yet/);
  });

  test('an item must carry something sendable', () => {
    // §5.3's list holds things that may be *sent*. An entry nobody could send
    // would satisfy the schema and not the rule.
    assert.match(migration, /url\s+text not null/);
  });
});
