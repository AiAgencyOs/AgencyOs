import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { region } from './_region.ts';
import {
  parseBankCsv,
  parseStatementAmount,
  parseStatementDate,
  proposeMatches,
  splitCsvRecord,
  type MatchCandidate,
} from '../src/modules/finance/bank-csv.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * The bank CSV import — SCR-053, owner decision 2026-09-29. The parser and
 * the proposer are pure so this file can pin the rules: a line is read as
 * the bank printed it, an unreadable row is reported and skipped rather
 * than guessed, and a match is PROPOSED — at most one candidate per line,
 * one line per candidate — and never written.
 */
describe('reading the file', () => {
  it('splits a record with quoted commas and doubled quotes', () => {
    assert.deepEqual(splitCsvRecord('2026-09-10,"NEFT CR, ACME ""RETAIL"" PVT",45000.00,NEFT-8891'), [
      '2026-09-10',
      'NEFT CR, ACME "RETAIL" PVT',
      '45000.00',
      'NEFT-8891',
    ]);
  });

  it('reads the dates banks print', () => {
    assert.equal(parseStatementDate('2026-09-10'), '2026-09-10');
    assert.equal(parseStatementDate('10/09/2026'), '2026-09-10');
    assert.equal(parseStatementDate('10-09-26'), '2026-09-10');
    assert.equal(parseStatementDate('10 Sep 2026'), '2026-09-10');
    assert.equal(parseStatementDate('10-Sept-2026'), '2026-09-10');
    assert.equal(parseStatementDate('31/02/2026'), null, 'February has no 31st');
    assert.equal(parseStatementDate('yesterday'), null);
  });

  it('reads amounts in minor units, with separators, signs, brackets and Cr/Dr', () => {
    assert.equal(parseStatementAmount('45,000.00'), 4_500_000);
    assert.equal(parseStatementAmount('₹ 1,200'), 120_000);
    assert.equal(parseStatementAmount('-1200.5'), -120_050);
    assert.equal(parseStatementAmount('(1200)'), -120_000);
    assert.equal(parseStatementAmount('1200 Dr'), -120_000);
    assert.equal(parseStatementAmount('1200 Cr'), 120_000);
    assert.equal(parseStatementAmount('12.345'), null, 'a third decimal is not paise');
    assert.equal(parseStatementAmount('abc'), null);
    assert.equal(parseStatementAmount(''), null);
  });

  it('reads a whole file by header name, in any order and case', () => {
    const csv = [
      'Reference,Description,Amount,Date',
      'NEFT-8891,NEFT CR ACME RETAIL PVT LTD,"45,000.00",10/09/2026',
      'UPI-1,UPI/priya@upi,1200.00,11/09/2026',
      ',BANK CHARGES,-118.00,12/09/2026',
    ].join('\n');
    const { lines, errors } = parseBankCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0], {
      lineNo: 2,
      date: '2026-09-10',
      description: 'NEFT CR ACME RETAIL PVT LTD',
      amountMinor: 4_500_000,
      reference: 'NEFT-8891',
    });
    assert.equal(lines[2]!.reference, null);
    assert.equal(lines[2]!.amountMinor, -11_800);
  });

  it('honours separate credit and debit columns', () => {
    const csv = ['Txn Date,Narration,Debit,Credit,Ref No', '10/09/2026,NEFT CR ACME,,45000,NEFT-8891', '11/09/2026,CHARGES,118,,'].join('\n');
    const { lines, errors } = parseBankCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(lines[0]!.amountMinor, 4_500_000);
    assert.equal(lines[1]!.amountMinor, -11_800);
  });

  it('reports an unreadable row with its line number and keeps the rest', () => {
    const csv = ['date,description,amount,reference', 'someday,NEFT CR,100,', '2026-09-10,,100,', '2026-09-10,OK,ten,', '2026-09-10,OK,10.00,'].join('\n');
    const { lines, errors } = parseBankCsv(csv);
    assert.equal(lines.length, 1);
    assert.equal(errors.length, 3);
    assert.match(errors[0]!, /^Line 2: /);
    assert.match(errors[1]!, /^Line 3: no description/);
    assert.match(errors[2]!, /^Line 4: the amount/);
  });

  it('refuses a file without the four columns, naming what is missing', () => {
    const { lines, errors } = parseBankCsv('foo,bar\n1,2');
    assert.equal(lines.length, 0);
    assert.match(errors[0]!, /no date, description, amount column/);
    assert.deepEqual(parseBankCsv('   \n').errors, ['The file is empty.']);
  });

  it('strips a BOM and tolerates CRLF and blank lines', () => {
    const { lines, errors } = parseBankCsv('﻿date,description,amount\r\n2026-09-10,A,1\r\n\r\n2026-09-11,B,2\r\n');
    assert.deepEqual(errors, []);
    assert.equal(lines.length, 2);
  });
});

describe('proposing matches', () => {
  const pay = (id: string, amountMinor: number, reference: string | null): MatchCandidate => ({
    kind: 'payment',
    id,
    amountMinor,
    reference,
    label: id,
    invoiceNumber: 'INV-1',
  });

  it('prefers a reference that agrees with the amount over an amount alone', () => {
    const lines = [
      { id: 'L1', amountMinor: 4_500_000, reference: 'NEFT-8891', description: 'NEFT CR ACME' },
      { id: 'L2', amountMinor: 4_500_000, reference: null, description: 'NEFT CR SOMEBODY' },
    ];
    const candidates = [pay('P-a', 4_500_000, 'neft8891'), pay('P-b', 4_500_000, 'other001')];
    const [first, second] = proposeMatches(lines, candidates);
    assert.equal(first!.candidate?.id, 'P-a');
    assert.equal(first!.reason, 'reference_and_amount');
    // P-a is taken, so the amount-only line gets the one that is left.
    assert.equal(second!.candidate?.id, 'P-b');
    assert.equal(second!.reason, 'amount');
  });

  it('finds the reference inside the description when the bank put it there', () => {
    const lines = [{ id: 'L1', amountMinor: 120_000, reference: null, description: 'UPI/pay_NEFT8891xyz/priya' }];
    const [p] = proposeMatches(lines, [pay('P-a', 120_000, 'pay_NEFT8891xyz')]);
    assert.equal(p!.candidate?.id, 'P-a');
  });

  it('proposes nothing between two records of the same amount, and says so', () => {
    const lines = [{ id: 'L1', amountMinor: 100_000, reference: null, description: 'x' }];
    const [p] = proposeMatches(lines, [pay('P-a', 100_000, null), pay('P-b', 100_000, null)]);
    assert.equal(p!.candidate, null);
    assert.equal(p!.reason, 'ambiguous');
    assert.equal(p!.sameAmount.length, 2);
  });

  it('proposes nothing when no record has the amount', () => {
    const [p] = proposeMatches([{ id: 'L1', amountMinor: 1, reference: null, description: 'x' }], [pay('P-a', 2, null)]);
    assert.equal(p!.candidate, null);
    assert.equal(p!.reason, 'none');
  });

  it('never offers one record to two lines', () => {
    const lines = [
      { id: 'L1', amountMinor: 100_000, reference: null, description: 'a' },
      { id: 'L2', amountMinor: 100_000, reference: null, description: 'b' },
    ];
    const [first, second] = proposeMatches(lines, [pay('P-a', 100_000, null)]);
    assert.equal(first!.candidate?.id, 'P-a');
    assert.equal(second!.candidate, null);
  });

  it('ignores a short reference that would match everything', () => {
    const lines = [{ id: 'L1', amountMinor: 5, reference: '12', description: 'x 12 y' }];
    const [p] = proposeMatches(lines, [pay('P-a', 7, '12')]);
    assert.equal(p!.candidate, null);
  });
});

describe('the door behind the panel', () => {
  const migration = read('supabase/migrations/20260930100000_the_bill_is_sent_and_chased_and_the_bank_is_read.sql');

  it('is a real table with RLS forced, tenancy triggers and no delete grant', () => {
    assert.match(migration, /create table if not exists finance\.bank_statement_lines/);
    assert.match(migration, /alter table finance\.bank_statement_lines force row level security/);
    assert.match(migration, /core\.enforce_parent_org\('reconciliation_id', 'finance\.reconciliations'\)/);
    assert.match(migration, /core\.enforce_parent_org\('item_id', 'finance\.reconciliation_items'\)/);
    assert.match(migration, /grant select, insert, update on finance\.bank_statement_lines to authenticated, service_role/);
    assert.doesNotMatch(migration, /grant[^;]*delete[^;]*bank_statement_lines/);
  });

  it('confirming a match writes the same reconciliation_item the hand-typed path writes, audited', () => {
    const body = region(migration, 'create or replace function finance.confirm_bank_line_match', 'comment on function finance.confirm_bank_line_match');
    assert.match(body, /insert into finance\.reconciliation_items/);
    assert.match(body, /'matched', v_pay\.id/);
    assert.match(body, /'bank_statement_line\.matched'/);
    assert.match(body, /set status = 'confirmed', item_id = v_item/);
  });

  it('the header records the owner reversal', () => {
    assert.match(migration, /Decision: reversed by the owner on 2026-09-29/);
  });
});
