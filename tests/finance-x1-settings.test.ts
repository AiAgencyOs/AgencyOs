import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  categoryLabel,
  filterableCategories,
  isOffered,
  offeredCategories,
  offeredFor,
  STARTING_EXPENSE_CATEGORIES,
  type ExpenseCategory,
} from '../src/modules/finance/expense-categories.ts';
import { expenseCategoryOutcomeMessage } from '../src/modules/finance/expense-category-outcome.ts';
import { recordExpenseSchema } from '../src/modules/finance/schema.ts';
import {
  currentReturnPeriod,
  filingCheck,
  GST_SETUP_DEFAULTS,
  gstSetupFrom,
  parseGstSetup,
  windowMonths,
} from '../src/modules/finance/gst-settings.ts';
import { resolveTaxPeriod } from '../src/modules/finance/tax-report.ts';

/**
 * PDF gap X1, owner decisions 6 (expense categories) and 9 (GST setup): the
 * pure halves the Settings forms, the expense screens, the tax page and the
 * GSTR export route all read.
 */

describe('the owner’s expense categories', () => {
  const withRetired: ExpenseCategory[] = STARTING_EXPENSE_CATEGORIES.map((c) => (c.key === 'tooling' ? { ...c, retired: true } : c)).concat([{ key: 'legal', label: 'Legal', retired: false, sortOrder: 70 }]);

  test('starts from the six the owner named, in their order', () => {
    assert.deepEqual(STARTING_EXPENSE_CATEGORIES.map((c) => c.key), ['infrastructure', 'ai', 'tooling', 'vendor', 'contractor', 'other']);
  });

  test('a new expense is offered the active categories only', () => {
    const keys = offeredCategories(withRetired).map((c) => c.key);
    assert.ok(keys.includes('legal'));
    assert.ok(!keys.includes('tooling'));
    assert.equal(isOffered(withRetired, 'tooling'), false);
    assert.equal(isOffered(withRetired, 'legal'), true);
  });

  test('an old expense keeps its retired category: editing it never silently re-files it', () => {
    const offered = offeredFor(withRetired, 'tooling');
    assert.ok(offered.some((c) => c.key === 'tooling' && c.retired));
    assert.equal(offeredFor(withRetired, 'legal').some((c) => c.key === 'tooling'), false);
  });

  test('a filter offers every category, retired included, so old expenses stay findable', () => {
    assert.equal(filterableCategories(withRetired).length, withRetired.length);
  });

  test('a label is the owner’s word; a key the list never held reads as words, never blank', () => {
    assert.equal(categoryLabel(withRetired, 'legal'), 'Legal');
    assert.equal(categoryLabel(withRetired, 'ai'), 'AI');
    assert.equal(categoryLabel(withRetired, 'domain_names'), 'Domain names');
  });

  test('an expense may be filed under any key of the list, not only the old six', () => {
    const base = { description: 'Counsel', amountMinor: 1000, incurredOn: '2026-10-01' };
    assert.equal(recordExpenseSchema.safeParse({ ...base, category: 'legal' }).success, true);
    assert.equal(recordExpenseSchema.safeParse({ ...base, category: 'Legal Fees' }).success, false);
    assert.equal(recordExpenseSchema.safeParse({ ...base, category: '' }).success, false);
  });

  test('every answer of the door is said in words', () => {
    assert.match(expenseCategoryOutcomeMessage('added', 'Legal').message ?? '', /"Legal" added/);
    assert.match(expenseCategoryOutcomeMessage('retired', '').message ?? '', /already filed under it keeps it/);
    assert.equal(expenseCategoryOutcomeMessage('last_active', '').status, 'error');
    assert.equal(expenseCategoryOutcomeMessage('exists', 'AI').status, 'error');
    assert.equal(expenseCategoryOutcomeMessage('forbidden', '').status, 'error');
    assert.equal(expenseCategoryOutcomeMessage(undefined, '').status, 'error');
  });
});

describe('the GST setup', () => {
  test('unset means the owner’s decision: regular, monthly, calendar month', () => {
    const s = gstSetupFrom({});
    assert.deepEqual({ r: s.registrationType, f: s.filingFrequency, p: s.periodBasis }, { r: 'regular', f: 'monthly', p: 'calendar_month' });
    assert.deepEqual(s.explicit, { registrationType: false, filingFrequency: false, periodBasis: false });
    assert.deepEqual(GST_SETUP_DEFAULTS, { registrationType: 'regular', filingFrequency: 'monthly', periodBasis: 'calendar_month' });
    assert.equal(gstSetupFrom(null).filingFrequency, 'monthly');
  });

  test('a saved value is read back and marked as the owner’s; a value outside the vocabulary reads as the default', () => {
    const s = gstSetupFrom({ gst_filing_frequency: 'quarterly', gst_registration_type: 'nonsense' });
    assert.equal(s.filingFrequency, 'quarterly');
    assert.equal(s.explicit.filingFrequency, true);
    assert.equal(s.registrationType, 'regular');
    assert.equal(s.explicit.registrationType, false);
  });

  test('a posted setup is validated against the closed vocabulary', () => {
    assert.equal(parseGstSetup({ registrationType: 'regular', filingFrequency: 'monthly', periodBasis: 'calendar_month' }).ok, true);
    assert.equal(parseGstSetup({ registrationType: 'bogus', filingFrequency: 'monthly', periodBasis: 'calendar_month' }).ok, false);
    assert.equal(parseGstSetup({ registrationType: 'regular', filingFrequency: 'weekly', periodBasis: 'calendar_month' }).ok, false);
    assert.equal(parseGstSetup({ registrationType: 'regular', filingFrequency: 'monthly', periodBasis: 'financial_year' }).ok, false);
  });

  test('the return due next is the last COMPLETE month (or quarter)', () => {
    assert.deepEqual(currentReturnPeriod({ filingFrequency: 'monthly' }, new Date('2026-10-01T05:00:00Z')), { value: '2026-09', label: 'September 2026' });
    assert.equal(currentReturnPeriod({ filingFrequency: 'monthly' }, new Date('2026-01-15T00:00:00Z')).value, '2025-12');
    assert.deepEqual(currentReturnPeriod({ filingFrequency: 'quarterly' }, new Date('2026-10-01T05:00:00Z')), { value: '2026-Q3', label: 'Q3 2026' });
    assert.equal(currentReturnPeriod({ filingFrequency: 'quarterly' }, new Date('2026-02-01T00:00:00Z')).value, '2025-Q4');
  });

  test('the export is for the window the saved setup files; the default setup files one calendar month', () => {
    const setup = gstSetupFrom({});
    const month = resolveTaxPeriod('2026-09', new Date('2026-10-01'));
    const quarter = resolveTaxPeriod('2026-Q3', new Date('2026-10-01'));
    const fy = resolveTaxPeriod('FY2026', new Date('2026-10-01'));
    assert.equal(windowMonths(month), 1);
    assert.equal(windowMonths(quarter), 3);
    assert.equal(filingCheck(setup, month, 'GSTR-1').ok, true);
    const q = filingCheck(setup, quarter, 'GSTR-3B');
    assert.equal(q.ok, false);
    assert.match(q.ok ? '' : q.message, /files monthly.*one calendar month/);
      assert.equal(windowMonths(fy), 12);
  });

  test('a quarterly filer exports a quarter, not a month', () => {
    const setup = gstSetupFrom({ gst_filing_frequency: 'quarterly' });
    assert.equal(filingCheck(setup, resolveTaxPeriod('2026-Q3', new Date('2026-10-01')), 'GSTR-1').ok, true);
    const m = filingCheck(setup, resolveTaxPeriod('2026-09', new Date('2026-10-01')), 'GSTR-1');
    assert.equal(m.ok, false);
    assert.match(m.ok ? '' : m.message, /quarterly.*one calendar quarter/);
  });

  test('a composition taxpayer is told GSTR-1 and GSTR-3B are not its returns', () => {
    const setup = gstSetupFrom({ gst_registration_type: 'composition' });
    const r = filingCheck(setup, resolveTaxPeriod('2026-09', new Date('2026-10-01')), 'GSTR-3B');
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.message, /composition taxpayer.*does not file GSTR-3B/);
  });
});
