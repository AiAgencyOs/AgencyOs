import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_OUTREACH_WINDOW,
  DEFAULT_QUOTATION_VALIDITY_DAYS,
  outreachWindow,
  quotationValidityDays,
} from '../src/lib/admin/operational-defaults.ts';
import { commercialTermsFor, COMMERCIAL_TERMS, quotationSectionsFor } from '../src/modules/sales/quotation-standards.ts';
import { intoSendingWindow, nextSendAt } from '../src/modules/crm/follow-up-rhythms.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Configurability audit B-1 and B-2: two constants became the owner's. The
 * promise in each direction — a set value is read, an unset or unusable one
 * means exactly what the code did before, never zero.
 */
describe('B-1 · how long a quotation stands', () => {
  it('unset reads as the old constant', () => {
    assert.equal(quotationValidityDays({}), DEFAULT_QUOTATION_VALIDITY_DAYS);
    assert.equal(quotationValidityDays(null), 15);
  });

  it('a set value is read as a whole number of days', () => {
    assert.equal(quotationValidityDays({ quotation_validity_days: '30' }), 30);
    assert.equal(quotationValidityDays({ quotation_validity_days: 7 }), 7);
  });

  it('an unusable value is the default, never zero or a year', () => {
    for (const bad of ['0', '91', '1,5', 'thirty', '', ' ', -3]) {
      assert.equal(quotationValidityDays({ quotation_validity_days: bad }), 15, String(bad));
    }
  });

  it('the clause prints the configured number, and the other clauses are untouched', () => {
    const terms = commercialTermsFor(30);
    assert.equal(terms[0], 'This quotation is valid for 30 days from its date.');
    assert.deepEqual(terms.slice(1), COMMERCIAL_TERMS.slice(1));
    assert.deepEqual(commercialTermsFor(), COMMERCIAL_TERMS);
  });

  it('quotationSectionsFor carries it through, and omitting it changes nothing', () => {
    const withIt = quotationSectionsFor(500_000_00, 0, { understanding: 'One build.' }, [], { validityDays: 21 });
    const without = quotationSectionsFor(500_000_00, 0, { understanding: 'One build.' }, []);
    assert.ok(withIt && without, 'a document with an understanding renders');
    assert.match(withIt.commercialTerms[0] ?? '', /21 days/);
    assert.deepEqual(without.commercialTerms, COMMERCIAL_TERMS);
  });
});

describe('B-2 · when follow-ups may be sent', () => {
  it('unset reads as ADM-69\'s 10–19', () => {
    assert.deepEqual(outreachWindow({}), DEFAULT_OUTREACH_WINDOW);
    assert.deepEqual(outreachWindow(undefined), { startHour: 10, endHour: 19 });
  });

  it('a set pair is read', () => {
    assert.deepEqual(outreachWindow({ outreach_window_start_hour: '9', outreach_window_end_hour: '17' }), { startHour: 9, endHour: 17 });
  });

  it('a half-set or inverted pair is the default — never a window that sends at 03:00', () => {
    assert.deepEqual(outreachWindow({ outreach_window_start_hour: '9' }), DEFAULT_OUTREACH_WINDOW);
    assert.deepEqual(outreachWindow({ outreach_window_start_hour: '17', outreach_window_end_hour: '9' }), DEFAULT_OUTREACH_WINDOW);
    assert.deepEqual(outreachWindow({ outreach_window_start_hour: '10', outreach_window_end_hour: '10' }), DEFAULT_OUTREACH_WINDOW);
    assert.deepEqual(outreachWindow({ outreach_window_start_hour: '-1', outreach_window_end_hour: '24' }), DEFAULT_OUTREACH_WINDOW);
  });

  it('the window moves a send the same way the constants did, on the configured hours', () => {
    // A Tuesday at 07:30 in Kolkata (02:00 UTC).
    const early = new Date('2026-09-29T02:00:00Z');
    const defaultDue = intoSendingWindow(early, 'Asia/Kolkata');
    const customDue = intoSendingWindow(early, 'Asia/Kolkata', { startHour: 8, endHour: 20 });
    // Default opens at 10:00 IST = 04:30 UTC; custom opens at 08:00 IST = 02:30 UTC.
    assert.equal(defaultDue.toISOString(), '2026-09-29T04:30:00.000Z');
    assert.equal(customDue.toISOString(), '2026-09-29T02:30:00.000Z');
  });

  it('nextSendAt passes the window through', () => {
    const triggeredAt = new Date('2026-09-29T02:00:00Z');
    const a = nextSendAt({ triggeredAt, rhythm: 'sales_active', attemptsSoFar: 0, timeZone: 'Asia/Kolkata' });
    const b = nextSendAt({ triggeredAt, rhythm: 'sales_active', attemptsSoFar: 0, timeZone: 'Asia/Kolkata', window: { startHour: 8, endHour: 20 } });
    assert.ok(a && b);
    assert.ok(b.getTime() <= a.getTime(), 'an earlier opening never sends later');
  });
});

describe('the door knows both keys', () => {
  const migration = read('supabase/migrations/20260929110000_two_more_settings_the_owner_can_set.sql');
  const settings = read('src/lib/admin/settings.ts');

  it('the database whitelist names them, with a range each', () => {
    for (const key of ['quotation_validity_days', 'outreach_window_start_hour', 'outreach_window_end_hour']) {
      assert.match(migration, new RegExp(`'${key}'`), key);
      assert.match(migration, new RegExp(`if p_key = '${key}' then`), `${key} is validated`);
      assert.match(settings, new RegExp(`'${key}'`), `${key} is a typed key`);
    }
  });

  it('is redefined from the latest body, not the original — G-242\'s calendar keys survive', () => {
    assert.match(migration, /'calendar_verified_calendar'/);
    assert.match(migration, /'meeting_reminder_minutes'/);
    assert.match(migration, /'reactivation_max_per_run'/);
  });

  it('the worker reads the window per organization and passes it to every due-time computation', () => {
    const worker = read('src/modules/crm/follow-up-worker.ts');
    assert.match(worker, /outreachWindowFor\(/);
    const passes = worker.match(/window: await outreachWindowFor\(|window,\n|zone, window\)|await agencyOutreachWindow\(admin, seq\.organization_id\)/g) ?? [];
    assert.ok(passes.length >= 4, `expected the window at every call site, found ${passes.length}`);
  });
});
