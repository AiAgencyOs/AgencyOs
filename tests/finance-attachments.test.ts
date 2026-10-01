import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Uploaded payment proof and expense receipts (owner decision 5 of 2026-10-01:
 * "Upload allowed, under the project file rules and credentials guard; links
 * still allowed"). Storage is unreachable on the local stack, so the storage
 * client is a FAKE here, in the way the project-file doors are exercised:
 * these tests run the real service code with only the session, the database
 * client and the bucket stubbed.
 */

const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const INVOICE = '33333333-3333-4333-8333-333333333333';

let role: 'owner' | 'finance' | 'member' = 'owner';
let storageReachable = true;
let uploadError: { message: string } | null = null;
let insertError: { code?: string; message: string } | null = null;

const seen = {
  uploads: [] as { bucket: string; path: string; size: number }[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; patch: Record<string, unknown> }[],
  signed: [] as string[],
};

const stubClient = {
  storage: {
    from(bucket: string) {
      return {
        async list() {
          return storageReachable ? { data: [], error: null } : { data: null, error: { message: 'fetch failed' } };
        },
        async upload(path: string, file: File) {
          if (uploadError) return { data: null, error: uploadError };
          seen.uploads.push({ bucket, path, size: file.size });
          return { data: { path }, error: null };
        },
        async createSignedUrl(path: string) {
          seen.signed.push(path);
          return storageReachable ? { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null } : { data: null, error: { message: 'fetch failed' } };
        },
      };
    },
  },
  schema() {
    return {
      from(table: string) {
        return {
          insert(row: Record<string, unknown>) {
            seen.inserts.push({ table, row });
            return { select: () => ({ single: async () => (insertError ? { data: null, error: insertError } : { data: { id: row.id }, error: null }) }) };
          },
          update(patch: Record<string, unknown>) {
            seen.updates.push({ table, patch });
            const chain = { eq: () => chain, select: () => ({ maybeSingle: async () => (insertError ? { data: null, error: insertError } : { data: { id: 'x' }, error: null }) }) };
            return chain;
          },
        };
      },
    };
  },
};

mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role, userId: USER, organizationId: ORG }) },
});
mock.module('@/lib/db/server', { exports: { createClient: async () => stubClient } });
mock.module('@/lib/env', { exports: { serverEnv: () => ({ SUPABASE_FILES_BUCKET: 'project-files' }), clientEnv: {} } });

const { recordExpense, recordPaymentSubmission, updateExpense } = await import('../src/modules/finance/service.ts');
const { attachmentProblem, financeObjectPath, hasChosenFile, signFinanceAttachment } = await import('../src/modules/finance/attachment.ts');
const { claimProofHref, expenseReceiptHref, proofIsImage } = await import('../src/modules/finance/attachment-links.ts');

const pdf = (name = 'receipt.pdf', size = 2048) => new File([new Uint8Array(size).fill(65)], name, { type: 'application/pdf' });

beforeEach(() => {
  role = 'owner';
  storageReachable = true;
  uploadError = null;
  insertError = null;
  seen.uploads.length = 0;
  seen.inserts.length = 0;
  seen.updates.length = 0;
  seen.signed.length = 0;
});

const expense = { category: 'tooling', description: 'Figma seat', amountMinor: 120000, incurredOn: '2026-10-01' };
const claim = { invoiceId: INVOICE, amountMinor: 50000, method: 'upi' as const, reference: 'UTR123456' };

describe('the object key', () => {
  test('is under the tenant folder, then finance, the kind and the record, with a safe name', () => {
    const p = financeObjectPath({ organizationId: ORG, kind: 'expense-receipt', recordId: 'abc', name: '../../etc/pass wd?.pdf' });
    assert.ok(p.startsWith(`${ORG}/finance/expense-receipt/abc/`), p);
    assert.doesNotMatch(p, /\.\.|\?/);
    assert.equal(p.split('/')[0], ORG, 'the bucket policy checks the first folder');
  });
});

describe('the project file rules apply', () => {
  test('a file over 50 MB is refused before storage is touched', async () => {
    const big = { name: 'huge.pdf', size: 51 * 1024 * 1024, type: 'application/pdf', slice: () => new Blob([]) } as unknown as File;
    assert.match((await attachmentProblem(big, 'expense-receipt')) ?? '', /limit is 50 MB/);
  });

  test('a credentials file is refused by its name', async () => {
    const env = new File(['A=1'], '.env', { type: 'text/plain' });
    assert.match((await attachmentProblem(env, 'claim-proof')) ?? '', /environment file/);
    const key = new File(['x'], 'server.pem');
    assert.match((await attachmentProblem(key, 'claim-proof')) ?? '', /key or certificate/);
  });

  test('a small text file with a secret inside is refused by what is in it', async () => {
    const txt = new File(['bank notes\npassword: hunter2hunter2\n'], 'notes.txt', { type: 'text/plain' });
    assert.match((await attachmentProblem(txt, 'expense-receipt')) ?? '', /password|key/i);
  });

  test('an ordinary receipt passes', async () => {
    assert.equal(await attachmentProblem(pdf(), 'expense-receipt'), null);
  });

  test('an empty file input is not a chosen file', () => {
    assert.equal(hasChosenFile(new File([], 'x.pdf')), false);
    assert.equal(hasChosenFile(null), false);
    assert.equal(hasChosenFile(pdf()), true);
  });
});

describe('recording an expense with an uploaded receipt', () => {
  test('stores the object under the tenant folder, then the row carries its path and the file name', async () => {
    const r = await recordExpense(expense, pdf('Figma Oct.pdf'));
    assert.equal(r.ok, true);
    assert.equal(seen.uploads.length, 1);
    assert.equal(seen.uploads[0]!.bucket, 'project-files');
    const row = seen.inserts[0]!.row;
    assert.equal(seen.inserts[0]!.table, 'expenses');
    assert.equal(row.receipt_storage_path, seen.uploads[0]!.path);
    assert.ok(String(row.receipt_storage_path).startsWith(`${ORG}/finance/expense-receipt/${row.id}/`));
    assert.equal(row.receipt_file_name, 'Figma Oct.pdf');
  });

  test('a link alone still works and writes no path', async () => {
    const r = await recordExpense({ ...expense, receiptUrl: 'https://drive.example/receipt' });
    assert.equal(r.ok, true);
    assert.equal(seen.uploads.length, 0);
    const row = seen.inserts[0]!.row;
    assert.equal(row.receipt_url, 'https://drive.example/receipt');
    assert.equal('receipt_storage_path' in row, false);
  });

  test('when storage cannot be reached nothing is uploaded and NO row is written', async () => {
    storageReachable = false;
    const r = await recordExpense(expense, pdf());
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /Storage is not reachable, so nothing was uploaded/);
    assert.equal(seen.inserts.length, 0);
  });

  test('when storage refuses the upload no row claims a body', async () => {
    uploadError = { message: 'quota' };
    const r = await recordExpense(expense, pdf());
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /nothing was saved: quota/);
    assert.equal(seen.inserts.length, 0);
  });

  test('a credentials file is refused and nothing is stored', async () => {
    const r = await recordExpense(expense, new File(['x'], 'credentials.json'));
    assert.equal(r.ok, false);
    assert.equal(seen.uploads.length, 0);
    assert.equal(seen.inserts.length, 0);
  });

  test('the finance role reads money but may not record it, so no file is stored for it either', async () => {
    role = 'finance';
    const r = await recordExpense(expense, pdf());
    assert.equal(r.ok, false);
    assert.equal(seen.uploads.length, 0);
  });

  test('a category the owner’s list refuses comes back in words, not as "could not record"', async () => {
    insertError = { code: '23514', message: 'expense category "legal" is not an active category of this organization' };
    const r = await recordExpense({ ...expense, category: 'legal' });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /not on the list any more/);
  });
});

describe('editing an expense', () => {
  test('a new file replaces the stored one; no file leaves the row’s receipt columns untouched', async () => {
    const withFile = await updateExpense({ ...expense, expenseId: '44444444-4444-4444-8444-444444444444' }, pdf('new.pdf'));
    assert.equal(withFile.ok, true);
    assert.equal(seen.updates[0]!.patch.receipt_file_name, 'new.pdf');
    const without = await updateExpense({ ...expense, expenseId: '44444444-4444-4444-8444-444444444444' });
    assert.equal(without.ok, true);
    assert.equal('receipt_storage_path' in seen.updates[1]!.patch, false);
  });
});

describe('recording a payment claim with an uploaded proof', () => {
  test('the proof is stored first and the claim row carries its path', async () => {
    const r = await recordPaymentSubmission(claim, new File([new Uint8Array(100)], 'screenshot.png', { type: 'image/png' }));
    assert.equal(r.ok, true);
    const row = seen.inserts[0]!.row;
    assert.equal(seen.inserts[0]!.table, 'payment_submissions');
    assert.ok(String(row.proof_storage_path).startsWith(`${ORG}/finance/claim-proof/${row.id}/`));
    assert.equal(row.proof_file_name, 'screenshot.png');
    assert.equal(r.ok ? r.data.submissionId : '', row.id);
  });

  test('storage unreachable: no claim is recorded against a proof that never landed', async () => {
    storageReachable = false;
    const r = await recordPaymentSubmission(claim, pdf('proof.pdf'));
    assert.equal(r.ok, false);
    assert.equal(seen.inserts.length, 0);
  });

  test('a link alone is recorded as before', async () => {
    const r = await recordPaymentSubmission({ ...claim, proofUrl: 'https://img.example/p.png' });
    assert.equal(r.ok, true);
    assert.equal(seen.inserts[0]!.row.proof_url, 'https://img.example/p.png');
    assert.equal('proof_storage_path' in seen.inserts[0]!.row, false);
  });
});

describe('opening a stored file', () => {
  test('a signed URL is minted per request, under the object key', async () => {
    const r = await signFinanceAttachment(stubClient as never, `${ORG}/finance/claim-proof/x/p.png`);
    assert.equal(r.ok, true);
    assert.deepEqual(seen.signed, [`${ORG}/finance/claim-proof/x/p.png`]);
  });

  test('storage down is said, not hidden', async () => {
    storageReachable = false;
    const r = await signFinanceAttachment(stubClient as never, 'x/y');
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /not reachable/);
  });

  test('the link a screen opens is the uploaded file when there is one, else the pasted link', () => {
    assert.equal(claimProofHref({ id: 'c1', proofUrl: 'https://x/y.png', proofFileName: 'p.png' }), '/api/finance/attachment/claim-proof/c1');
    assert.equal(claimProofHref({ id: 'c1', proofUrl: 'https://x/y.png' }), 'https://x/y.png');
    assert.equal(claimProofHref({ id: 'c1', proofUrl: null }), null);
    assert.equal(expenseReceiptHref({ id: 'e1', receiptUrl: null, receiptFileName: 'r.pdf' }), '/api/finance/attachment/expense-receipt/e1');
    assert.equal(proofIsImage('/api/finance/attachment/claim-proof/c1', 'shot.PNG'), true);
    assert.equal(proofIsImage('/api/finance/attachment/claim-proof/c1', 'shot.pdf'), false);
  });
});
