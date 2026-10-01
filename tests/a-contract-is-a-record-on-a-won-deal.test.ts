import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addLeadFileSchema, CARRIED_LEAD_FILE_CATEGORY } from '../src/modules/crm/lead-files-schema.ts';
import { PROJECT_FILE_CATEGORIES } from '../src/modules/projects/schema.ts';
import { canMoveContract, createContractSchema, nextContractStatuses, updateContractStatusSchema } from '../src/modules/sales/contract-schema.ts';

const ID = '00000000-0000-4000-8000-0000000000aa';

describe('a contract moves draft to sent to signed, and a signed one is a record', () => {
  it('the allowed moves', () => {
    assert.deepEqual([...nextContractStatuses('draft')], ['sent', 'signed']);
    assert.deepEqual([...nextContractStatuses('sent')], ['signed', 'draft']);
    assert.deepEqual([...nextContractStatuses('signed')], []);
  });

  it('canMoveContract agrees', () => {
    assert.equal(canMoveContract('draft', 'sent'), true);
    assert.equal(canMoveContract('sent', 'draft'), true);
    assert.equal(canMoveContract('signed', 'draft'), false);
    assert.equal(canMoveContract('draft', 'draft'), false);
  });
});

describe('recording a contract asks only what the decision names', () => {
  it('a draft needs a deal and a title, and no signer or date', () => {
    const ok = createContractSchema.safeParse({ opportunityId: ID, title: 'MSA' });
    assert.equal(ok.success, true);
    if (ok.success) assert.equal(ok.data.status, 'draft');
  });

  it('a signed contract must say who signed and the day', () => {
    assert.equal(createContractSchema.safeParse({ opportunityId: ID, title: 'MSA', status: 'signed' }).success, false);
    assert.equal(createContractSchema.safeParse({ opportunityId: ID, title: 'MSA', status: 'signed', signerName: 'A. Rao' }).success, false);
    assert.equal(createContractSchema.safeParse({ opportunityId: ID, title: 'MSA', status: 'signed', signerName: 'A. Rao', signedOn: '2026-10-04' }).success, true);
  });

  it('a signed date on an unsigned contract is refused', () => {
    assert.equal(createContractSchema.safeParse({ opportunityId: ID, title: 'MSA', status: 'sent', signedOn: '2026-10-04' }).success, false);
  });

  it('the file link must be a web link, or empty', () => {
    assert.equal(createContractSchema.safeParse({ opportunityId: ID, title: 'MSA', fileUrl: 'javascript:alert(1)' }).success, false);
    assert.equal(createContractSchema.safeParse({ opportunityId: ID, title: 'MSA', fileUrl: '' }).success, true);
    assert.equal(createContractSchema.safeParse({ opportunityId: ID, title: 'MSA', fileUrl: 'https://drive.example/x' }).success, true);
  });

  it('moving a contract to signed carries the same demand', () => {
    assert.equal(updateContractStatusSchema.safeParse({ contractId: ID, status: 'signed' }).success, false);
    assert.equal(updateContractStatusSchema.safeParse({ contractId: ID, status: 'signed', signerName: 'A. Rao', signedOn: '2026-10-04' }).success, true);
    assert.equal(updateContractStatusSchema.safeParse({ contractId: ID, status: 'sent' }).success, true);
  });
});

describe('a lead file is a titled web link', () => {
  it('accepts https and http links, refuses anything else', () => {
    assert.equal(addLeadFileSchema.safeParse({ leadId: ID, title: 'Brief', url: 'https://x.example/brief.pdf' }).success, true);
    assert.equal(addLeadFileSchema.safeParse({ leadId: ID, title: 'Brief', url: 'ftp://x.example/brief.pdf' }).success, false);
    assert.equal(addLeadFileSchema.safeParse({ leadId: ID, title: 'Brief', url: 'not a link' }).success, false);
    assert.equal(addLeadFileSchema.safeParse({ leadId: ID, title: '  ', url: 'https://x.example' }).success, false);
  });

  it('a carried link lands in a real project file category', () => {
    assert.ok((PROJECT_FILE_CATEGORIES as readonly string[]).includes(CARRIED_LEAD_FILE_CATEGORY));
  });
});
