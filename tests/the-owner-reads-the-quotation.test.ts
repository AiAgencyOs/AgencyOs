import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  announcementFor,
  approvalRequestedEventSchema,
  quotationApprovalPayloadSchema,
} from '../src/modules/crm/schema.ts';

/**
 * The owner reads the quotation, not a reference to it — Document 09 §14.
 *
 * What the owner used to receive was a title, a total and a code. Enough to
 * know a decision existed; not enough to make one. The scope — the part that
 * tells you whether the customer app was quoted and the driver app forgotten —
 * was only in AgencyOS, which is fine as a destination and wrong as a
 * precondition, because every minute of an approval is the client waiting.
 *
 * The database half of this change is one field added to the approval payload
 * in `sales.submit_proposal`; §J of `scripts/verify-quotations.mjs` proves it
 * against a real Postgres. What is here is the wording — which is the whole
 * feature — and the two things that must not move while it changes: the
 * unauthored price guard, and ADM-74's boundary.
 */

const EVENT = approvalRequestedEventSchema.parse({
  reference: '7QK3M2',
  subjectType: 'proposal',
  subjectId: '4b0f6d1a-9c3e-4a2b-8f7d-2e5a1c9b3d84',
  summary: 'Quotation v2 — Delivery app',
  amountMinor: 7_000_000,
  requiredRole: 'owner',
  slaDueAt: null,
});

const PAYLOAD = {
  version: 2,
  title: 'Delivery app',
  currency: 'INR',
  subtotal_minor: 7_000_000,
  discount_minor: 0,
  tax_minor: 0,
  total_minor: 7_000_000,
  valid_until: null,
  items: [
    { description: 'Customer app', quantity: 1, amount_minor: 4_000_000 },
    { description: 'Driver app', quantity: 1, amount_minor: 3_000_000 },
  ],
};

const payloadWith = (over: Record<string, unknown>) => ({ ...PAYLOAD, ...over });

describe('A. the owner can see what they are approving', () => {
  test('the announcement lists what the quotation covers', () => {
    const body = announcementFor(EVENT, true, PAYLOAD);

    assert.match(body, /What it covers:/);
    assert.match(body, /• Customer app — ₹40,000/);
    assert.match(body, /• Driver app — ₹30,000/);
  });

  test('and the total, which is what it always had', () => {
    assert.match(announcementFor(EVENT, true, PAYLOAD), /Total: ₹70,000/);
  });

  test('the title and version open it', () => {
    assert.match(announcementFor(EVENT, true, PAYLOAD), /Delivery app — v2/);
  });

  test('a quantity of one is not printed, because "×1" is noise', () => {
    assert.ok(!/×1\b/.test(announcementFor(EVENT, true, PAYLOAD)));
  });

  test('a quantity that is not one is, because it is the reason for the number', () => {
    const body = announcementFor(
      EVENT,
      true,
      payloadWith({ items: [{ description: 'Screens', quantity: 12, amount_minor: 1_200_000 }] }),
    );
    assert.match(body, /• Screens ×12 — ₹12,000/);
  });
});

describe('B. an empty column is not a fact somebody entered', () => {
  test('no discount line when there is no discount', () => {
    const body = announcementFor(EVENT, true, PAYLOAD);
    assert.ok(!/Discount/.test(body), 'a zero discount was announced as one');
    assert.ok(!/Subtotal/.test(body), 'a subtotal equal to the total was announced twice');
    assert.ok(!/Tax/.test(body));
  });

  test('but a real discount is spelled out with the subtotal it came off', () => {
    const body = announcementFor(
      EVENT,
      true,
      payloadWith({ discount_minor: 500_000, total_minor: 6_500_000 }),
    );
    assert.match(body, /Subtotal: ₹70,000/);
    assert.match(body, /Discount: −₹5,000/);
    assert.match(body, /Total: ₹65,000/);
  });

  test('tax the same way', () => {
    const body = announcementFor(
      EVENT,
      true,
      payloadWith({ tax_minor: 1_260_000, total_minor: 8_260_000 }),
    );
    assert.match(body, /Tax: ₹12,600/);
  });

  test('validity appears only when the quotation has one', () => {
    assert.ok(!/Valid until/.test(announcementFor(EVENT, true, PAYLOAD)));
    assert.match(
      announcementFor(EVENT, true, payloadWith({ valid_until: '2026-09-15' })),
      /Valid until 2026-09-15/,
    );
  });
});

describe('C. a long quotation says what it left out', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    description: `Line ${i + 1}`,
    quantity: 1,
    amount_minor: 100_000,
  }));

  test('it stops at twelve lines', () => {
    const body = announcementFor(EVENT, true, payloadWith({ items: many }));
    assert.match(body, /• Line 12 —/);
    assert.ok(!/• Line 13 —/.test(body));
  });

  test('and says how many it did not show, because a silent cut reads as complete', () => {
    const body = announcementFor(EVENT, true, payloadWith({ items: many }));
    assert.match(body, /…and 18 more lines — the full scope is in AgencyOS\./);
  });

  test('one hidden line is not "1 lines"', () => {
    const body = announcementFor(EVENT, true, payloadWith({ items: many.slice(0, 13) }));
    assert.match(body, /…and 1 more line — /);
  });

  test('the whole thing still fits in a WhatsApp body', () => {
    const body = announcementFor(
      EVENT,
      true,
      payloadWith({
        items: many.map((i) => ({ ...i, description: i.description.padEnd(120, ' x') })),
      }),
    );
    assert.ok(body.length < 4096, `the announcement is ${body.length} characters`);
  });
});

describe('D. the summary is not said twice', () => {
  test('the summary submit_proposal generates is dropped — the block already says it', () => {
    const body = announcementFor(EVENT, true, PAYLOAD);
    assert.equal(
      body.split('Delivery app').length - 1,
      1,
      'the title appears twice: once as the summary and once as the quotation',
    );
  });

  test('a summary a person typed is theirs and stays', () => {
    const body = announcementFor(
      { ...EVENT, summary: 'Repriced after the call — he pushed back on the driver app.' },
      true,
      PAYLOAD,
    );
    assert.match(body, /he pushed back on the driver app/);
    assert.match(body, /Delivery app — v2/);
  });
});

describe('E. the price is still a person’s', () => {
  test('an agent-raised request states no price at all', () => {
    const body = announcementFor(EVENT, false, PAYLOAD);

    assert.ok(!/₹/.test(body), 'an unauthored announcement carries currency');
    assert.ok(!/70,000|40,000|30,000/.test(body), 'an unauthored announcement carries an amount');
    assert.ok(!/What it covers/.test(body), 'an unauthored announcement carries priced scope');
  });

  test('and still lands, rather than being refused at the row and never arriving', () => {
    const body = announcementFor(EVENT, false, PAYLOAD);

    assert.match(body, /needs a decision/);
    assert.match(body, /It carries an amount — open it in AgencyOS to see it\./);
    assert.match(body, /Reference 7QK3M2\./);
  });
});

describe('F. an older or broken payload falls back rather than failing', () => {
  test('no payload at all is the announcement that shipped before this', () => {
    const body = announcementFor(EVENT, true, null);
    assert.match(body, /Quotation v2 — Delivery app/);
    assert.match(body, /₹70,000/);
    assert.ok(!/What it covers/.test(body));
  });

  test('a payload from before the items were recorded still renders its totals', () => {
    const { items: _items, ...older } = PAYLOAD;
    const body = announcementFor(EVENT, true, older);
    assert.match(body, /Delivery app — v2/);
    assert.match(body, /Total: ₹70,000/);
    assert.ok(!/What it covers/.test(body), 'a payload with no items claimed to cover something');
  });

  test('junk does not throw and does not lose the announcement', () => {
    for (const junk of [{ version: 'two' }, [], 'nope', 0, { items: [{}] }]) {
      const body = announcementFor(EVENT, true, junk);
      assert.match(body, /Reference 7QK3M2\./, `lost the announcement for ${JSON.stringify(junk)}`);
    }
  });

  test('the schema is what decides that, not a try/catch around the render', () => {
    assert.equal(quotationApprovalPayloadSchema.safeParse({}).success, false);
    assert.equal(quotationApprovalPayloadSchema.safeParse(PAYLOAD).success, true);
  });
});

describe('G. only a quotation gets this', () => {
  test('another subject with the same payload is untouched', () => {
    const body = announcementFor({ ...EVENT, subjectType: 'deliverable' }, true, PAYLOAD);
    assert.ok(!/What it covers/.test(body), 'a deliverable was announced as a quotation');
    assert.match(body, /₹70,000/);
  });
});

describe('H. ADM-74 is not widened by any of this', () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL(
        '../supabase/migrations/20260823200000_the_owner_reads_the_quote_not_a_reference.sql',
        import.meta.url,
      ),
    ),
    'utf8',
  );

  test('the message still sends the approver to AgencyOS', () => {
    assert.match(announcementFor(EVENT, true, PAYLOAD), /Decide it in AgencyOS\./);
  });

  test('and never invites a reply that would settle anything', () => {
    const body = announcementFor(EVENT, true, PAYLOAD);
    assert.ok(!/reply/i.test(body), 'the announcement invites a reply');
    assert.ok(!/\bYES\b|\bNO\b|approve by/i.test(body));
  });

  test('nothing in the migration settles an approval', () => {
    const sql = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .replace(/comment on [\s\S]*?';/gi, '');

    assert.ok(sql.length > 500, 'the strip removed the whole file');
    assert.ok(!/decide_approval/.test(sql), 'a path into decide_approval appeared');
    assert.ok(!/state\s*=\s*'approved'/.test(sql));
  });

  test('and the boundary is written down where the next reader will look', () => {
    assert.match(migration, /ADM-74/);
  });
});

describe('I. the wiring', () => {
  const handlers = readFileSync(
    fileURLToPath(new URL('../src/modules/crm/handlers.ts', import.meta.url)),
    'utf8',
  );
  const migration = readFileSync(
    fileURLToPath(
      new URL(
        '../supabase/migrations/20260823200000_the_owner_reads_the_quote_not_a_reference.sql',
        import.meta.url,
      ),
    ),
    'utf8',
  );

  test('the handler reads the payload off the row and passes it on', () => {
    assert.match(handlers, /\.select\('requested_by_id, payload'\)/);
    assert.match(
      handlers,
      /announcementFor\(event, Boolean\(request\?\.requested_by_id\), request\?\.payload \?\? null\)/,
    );
  });

  test('it is still scoped to the job’s organization', () => {
    assert.match(handlers, /\.eq\('organization_id', job\.organization_id\)/);
  });

  test('the event shape was not widened to carry a second copy of the payload', () => {
    const catalog = readFileSync(
      fileURLToPath(new URL('../src/modules/crm/schema.ts', import.meta.url)),
      'utf8',
    );
    const event = catalog.slice(catalog.indexOf('approvalRequestedEventSchema'));
    assert.ok(
      !/items:/.test(event.slice(0, event.indexOf('});'))),
      'the items were added to the event as well as the row',
    );
  });

  test('submit_proposal was carried forward, not regenerated (D16)', () => {
    for (const kept of [
      'security invoker',
      "'no_policy'::text",
      "'already_pending'::text",
      'for share',
      'approval_request_id = v_approval.request_id',
    ]) {
      assert.ok(migration.includes(kept), `the carry-forward lost: ${kept}`);
    }
  });

  test('the items are ordered, so two announcements of one quotation read alike', () => {
    assert.match(migration, /order by i\.position, i\.created_at/);
  });
});

describe('J. one composition, not two', () => {
  const handlers = readFileSync(
    fileURLToPath(new URL('../src/modules/crm/handlers.ts', import.meta.url)),
    'utf8',
  );

  test('the announcement is composed once and used for both the row and the wire', () => {
    const announce = handlers.slice(
      handlers.indexOf('export async function handleApprovalRequested'),
      handlers.indexOf('export async function', handlers.indexOf('handleApprovalRequested') + 40),
    );

    // Comments stripped first: the comment above the composition *names* the
    // call it replaced, and counting that would make this test fail for
    // documenting itself.
    const code = announce.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const compositions = code.match(/announcementFor\(/g) ?? [];
    assert.equal(
      compositions.length,
      1,
      `the handler composes the announcement ${compositions.length} times; the row and the provider must get the same words`,
    );
  });

  test('and the provider is handed that same body', () => {
    assert.match(handlers, /const body = announcementFor\(event, Boolean\(request\?\.requested_by_id\), request\?\.payload \?\? null\);/);
    assert.match(handlers, /p_body: body,/);
    assert.match(handlers, /\n {4}body,\n/);
  });
});
