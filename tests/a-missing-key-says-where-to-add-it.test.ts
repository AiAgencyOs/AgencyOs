import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SECRET_SLOTS } from '../src/lib/secrets/registry.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * A missing key says where to add it (stream H-3).
 *
 * Screens used to tell an owner to "set GITHUB_TOKEN in the deployment
 * environment" — true, and no longer the whole truth now that Keys & secrets
 * holds them. Each screen that says a vault-manageable key is missing names the
 * vault first, keeps the environment as the alternative, and where it is JSX
 * links to /security/keys.
 */

const SCREENS_WITH_A_LINK = [
  'app/(internal)/projects/[projectId]/repository/github-panel.tsx',
  'app/(internal)/settings/communication/page.tsx',
  'app/(internal)/operations/page.tsx',
  'app/(internal)/meetings/page.tsx',
  'app/(internal)/agents/page.tsx',
  'app/(internal)/invoices/[invoiceId]/email-send-panel.tsx',
  'app/(internal)/projects/[projectId]/design/design-forms.tsx',
  'app/(internal)/dashboard/page.tsx',
  'app/(internal)/settings/page.tsx',
];

const SENTENCES = [
  'src/lib/admin/production-readiness-eval.ts',
  'src/lib/admin/whatsapp-verify.ts',
  'src/lib/admin/whatsapp-readiness.ts',
  'src/lib/email/transport.ts',
];

describe('a screen that says a key is missing links to where it is added', () => {
  for (const file of SCREENS_WITH_A_LINK) {
    it(`${file} links to /security/keys`, () => {
      assert.match(read(file), /href=(?:"|\{`)\/security\/keys/);
    });
  }

  it('the repository panel offers the vault first and the environment as the alternative', () => {
    const s = read('app/(internal)/projects/[projectId]/repository/github-panel.tsx');
    assert.match(s, /add <code>GITHUB_TOKEN<\/code> under/);
    assert.match(s, /or set it in the deployment environment/);
    assert.doesNotMatch(s, /set <code>GITHUB_TOKEN<\/code> \(with/);
  });
});

describe('a sentence that says a key is missing names the vault', () => {
  for (const file of SENTENCES) {
    it(`${file} mentions Keys & secrets`, () => {
      assert.match(read(file), /Keys & secrets/);
    });
  }

  it('the readiness remediation never tells anyone to set a vault-manageable key in the environment alone', () => {
    const s = read('src/lib/admin/production-readiness-eval.ts');
    const remediations = [...s.matchAll(/remediation:\s*([^\n]+)/g)].map((m) => m[1]!);
    const storable = SECRET_SLOTS.filter((x) => x.storage !== 'env_only').map((x) => x.key);
    for (const line of remediations) {
      const namesVaultKey = storable.some((k) => line.includes(k)) || /provider API key|missing values/.test(line);
      if (namesVaultKey && /deployment environment/.test(line)) assert.match(line, /Keys & secrets/, line);
    }
  });
});
