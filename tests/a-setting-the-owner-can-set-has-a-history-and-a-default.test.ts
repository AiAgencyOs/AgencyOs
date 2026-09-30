import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_FUNNEL_MIN_LEADS_TO_NAME_LEAK,
  DEFAULT_MEETING_OFFER_HORIZON_DAYS,
  funnelMinLeadsToNameLeak,
  meetingOfferHorizonDays,
} from '../src/lib/admin/operational-defaults.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIGRATION = 'supabase/migrations/20261003100000_two_more_settings_a_horizon_and_a_sample_floor.sql';

/**
 * Configurability audit B-3 and B-4 (two constants that became the owner's)
 * and F-1 (each Settings form says where its value's history is).
 */
describe('B-3 · how far ahead a meeting time is offered', () => {
  it('unset reads as the old constant of 7', () => {
    assert.equal(meetingOfferHorizonDays({}), DEFAULT_MEETING_OFFER_HORIZON_DAYS);
    assert.equal(meetingOfferHorizonDays(null), 7);
  });

  it('a set value is read as whole days', () => {
    assert.equal(meetingOfferHorizonDays({ meeting_offer_horizon_days: '14' }), 14);
    assert.equal(meetingOfferHorizonDays({ meeting_offer_horizon_days: 60 }), 60);
  });

  it('an unusable value is 7, never zero or a season', () => {
    for (const bad of ['0', '61', '1,4', 'two weeks', '', -1]) {
      assert.equal(meetingOfferHorizonDays({ meeting_offer_horizon_days: bad }), 7, String(bad));
    }
  });

  it('the booking reader takes the setting, and the constant is gone', () => {
    const booking = read('src/lib/scheduling/booking.ts');
    assert.doesNotMatch(booking, /DEFAULT_HORIZON_DAYS/);
    assert.match(booking, /meetingOfferHorizonDays\(await readOperationalSettings\(\)\)/);
  });
});

describe('B-4 · how many leads before the funnel names a leak', () => {
  it('unset reads as the old constant of 20', () => {
    assert.equal(funnelMinLeadsToNameLeak({}), DEFAULT_FUNNEL_MIN_LEADS_TO_NAME_LEAK);
    assert.equal(funnelMinLeadsToNameLeak(undefined), 20);
  });

  it('a set value is read as whole leads', () => {
    assert.equal(funnelMinLeadsToNameLeak({ funnel_min_leads_to_name_leak: '50' }), 50);
    assert.equal(funnelMinLeadsToNameLeak({ funnel_min_leads_to_name_leak: 5 }), 5);
  });

  it('an unusable value is 20 — never a floor of one that would name a leak from a single lead', () => {
    for (const bad of ['0', '1', '4', '501', '2,0', 'lots', '']) {
      assert.equal(funnelMinLeadsToNameLeak({ funnel_min_leads_to_name_leak: bad }), 20, String(bad));
    }
  });

  it('the funnel reader uses the setting, and the report states the number in force', () => {
    const reader = read('src/lib/admin/sales-funnel.ts');
    assert.match(reader, /funnelMinLeadsToNameLeak\(await readOperationalSettings\(\)\)/);
    assert.match(reader, /if \(counts\.leads >= minLeadsToNameLeak\)/);
    assert.doesNotMatch(read('app/(internal)/sales-funnel/page.tsx'), /MIN_LEADS_TO_NAME_A_LEAK/);
  });
});

describe('the door knows both keys', () => {
  const migration = read(MIGRATION);
  const settings = read('src/lib/admin/settings.ts');

  it('the database whitelist names them, with a range each, and the type and hint know them', () => {
    for (const key of ['meeting_offer_horizon_days', 'funnel_min_leads_to_name_leak']) {
      assert.match(migration, new RegExp(`'${key}'`), key);
      assert.match(migration, new RegExp(`if p_key = '${key}' then`), `${key} is validated`);
      assert.match(settings, new RegExp(`'${key}'`), `${key} is a typed key`);
      assert.match(settings, new RegExp(`${key}: '`), `${key} has a hint`);
    }
    assert.match(migration, /< 1 or v_value::numeric > 60/);
    assert.match(migration, /< 5 or v_value::numeric > 500/);
  });

  it('is redefined from the latest body — every earlier key survives', () => {
    for (const key of ['quotation_validity_days', 'outreach_window_end_hour', 'calendar_verified_calendar', 'meeting_reminder_minutes', 'reactivation_max_per_run', 'negotiation_max_rounds', 'project_group_identifier']) {
      assert.match(migration, new RegExp(`'${key}'`), key);
    }
    assert.match(migration, /'organization\.setting_set'/, 'the door still audits');
  });

  it('is idempotent and owner-or-ops only', () => {
    assert.match(migration, /create or replace function core\.set_organization_setting/);
    assert.match(migration, /not in \('owner', 'ops_admin'\)/);
  });

  it('is the newest redefinition of the door', () => {
    const latest = readdirSync(join(process.cwd(), 'supabase/migrations'))
      .filter((f) => read(`supabase/migrations/${f}`).includes('create or replace function core.set_organization_setting'))
      .sort()
      .pop();
    assert.equal(latest, MIGRATION.split('/').pop());
  });
});

describe('F-1 · every Settings form has a history, from one shared component', () => {
  const component = read('app/(internal)/settings/setting-history.tsx');
  const loader = read('app/(internal)/settings/setting-history-entries.ts');

  it('the history is the audit trail read through the audit read door, not a table of its own', () => {
    assert.match(read('src/lib/admin/settings-history.ts'), /readAuditLog\(/);
    assert.match(loader, /readSettingHistory\(\)/);
    assert.match(component, /History/);
    assert.match(loader, /LAST_FEW/);
  });

  it('the Communication page shows it beside the two new keys and the sending window', () => {
    const page = read('app/(internal)/settings/communication/page.tsx');
    assert.match(page, /historyOf\('meeting_offer_horizon_days'\)/);
    assert.match(page, /historyOf\('outreach_window_start_hour', 'outreach_window_end_hour'\)/);
    assert.match(page, /historyOf\('reactivation_max_per_run'\)/);
  });

  it('the Commercial page shows it beside the funnel floor, validity, pricing and limits', () => {
    const page = read('app/(internal)/settings/commercial/page.tsx');
    assert.match(page, /historyOf\('funnel_min_leads_to_name_leak'\)/);
    assert.match(page, /historyOf\('quotation_validity_days'\)/);
    assert.match(page, /historyOf\('pricing_day_rate_rupees'/);
    assert.match(page, /historyOf\('negotiation_max_rounds'/);
  });

  it('the General page uses the shared loader rather than its own copy', () => {
    const page = read('app/(internal)/settings/page.tsx');
    assert.match(page, /loadSettingHistory\(\)/);
    assert.doesNotMatch(page, /readSettingHistory/);
    assert.match(page, /historyOf\('quotation_contact_email'/);
  });
});
