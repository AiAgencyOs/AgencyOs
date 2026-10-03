import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { approvedStatementsBlock } from '../src/modules/sales/approved-statements.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// Found by the first live run: given nothing to say about the agency, the
// agent invented it. The prompt bars that; this is the owner's way of giving
// it the few statements it may say.
describe('A. the statements reach the agent only when the owner wrote them', () => {
  test('no setting, an empty one, or a non-string adds nothing — behaviour is as before', () => {
    assert.equal(approvedStatementsBlock(undefined), '');
    assert.equal(approvedStatementsBlock(null), '');
    assert.equal(approvedStatementsBlock({}), '');
    assert.equal(approvedStatementsBlock({ approved_trust_facts: '' }), '');
    assert.equal(approvedStatementsBlock({ approved_trust_facts: '  \n \n' }), '');
    assert.equal(approvedStatementsBlock({ approved_trust_facts: 42 }), '');
  });

  test('the positive twin: written statements appear, one bullet each, with the limit stated', () => {
    const block = approvedStatementsBlock({ approved_trust_facts: ' Paid in stages. \n\nQuotation first.' });
    assert.match(block, /- Paid in stages\./);
    assert.match(block, /- Quotation first\./);
    assert.match(block, /do not add terms, numbers, guarantees or promises beyond what is written/);
    assert.match(block, /for a colleague to confirm/);
  });

  test('at most twelve statements are ever passed on', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Statement ${i + 1}`).join('\n');
    const block = approvedStatementsBlock({ approved_trust_facts: many });
    assert.equal((block.match(/^- /gm) ?? []).length, 12);
    assert.ok(!block.includes('Statement 13'));
  });

  test('the reply workflow appends the block to the model input', () => {
    const w = read('app/api/jobs/run/workflows.ts');
    assert.match(w, /salesFile \+\s*approvedStatementsBlock\(org\?\.settings\)/);
  });
});

describe('B. the key is the owner\'s, validated and audited at the database', () => {
  const m = read('supabase/migrations/20261010100000_the_owner_decides_what_the_agent_says_and_what_language_the_terms_print_in.sql');
  const region = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

  test('whitelisted in the door, with a length and line limit', () => {
    const door = region(m, 'create or replace function core.set_organization_setting(', 'create or replace function core.org_setting_write_is_sanctioned');
    assert.match(door, /'approved_trust_facts',[\s\S]*'quotation_translate_standards'\s*\) then/);
    assert.match(door, /p_key = 'quotation_translate_standards' and v_value <> 'on'/);
    assert.match(door, /char_length\(v_value\) > 1500/);
    assert.match(door, /array_length\(string_to_array\(v_value, E'\\n'\), 1\) > 12/);
    assert.match(door, /char_length\(l\) > 240/);
    assert.match(door, /core\.record_audit\(/);
  });

  test('and in the guard that refuses a direct write of a whitelisted key', () => {
    const guard = region(m, 'create or replace function core.org_setting_write_is_sanctioned', 'notify pgrst');
    assert.match(guard, /'approved_trust_facts',\s*'quotation_translate_standards'\s*\];/);
  });

  test('the form, the action and the catalogue exist', () => {
    assert.match(read('app/(internal)/settings/actions.ts'), /setOrganizationSetting\('approved_trust_facts'/);
    assert.match(read('app/(internal)/settings/forms.tsx'), /export function TrustFactsForm/);
    assert.match(read('src/lib/admin/settings-catalogue.ts'), /setting\('approved_trust_facts'/);
    assert.match(read('app/(internal)/settings/communication/page.tsx'), /id="trust-facts"/);
  });
});
