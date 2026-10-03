import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { codeOnly } from './_code-only.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket G, stream G-2 — SCR-056 puts "GST configuration" on the tax page as
 * a section and "Configure tax profile" as a primary action. The audit had
 * both PARTIAL ("stay on Settings"). The rule for closing them: the SAME
 * form and the SAME door Settings › Finance uses, mounted where the PDF
 * puts them — never a second form, never a second write path — and the
 * profile's gaps (registration type, period basis, filing frequency) said
 * rather than invented.
 */

const TAX_PAGE = 'app/(internal)/finance/tax/page.tsx';
const CARD = 'app/(internal)/finance/tax/gst-configuration-card.tsx';
const FORM = 'app/(internal)/settings/finance/gst-identity-form.tsx';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('SCR-056 · the tax page carries the GST configuration section and the Configure tax profile action', () => {
  const page = read(TAX_PAGE);

  it('mounts the GST configuration card and offers "Configure tax profile" in the header, pointing at it', () => {
    assert.match(page, /import \{ GstConfigurationCard \} from '\.\/gst-configuration-card'/);
    assert.match(page, /<GstConfigurationCard setup=\{gstSetup\} nextReturnLabel=\{nextReturn\.label\} identity=\{gstIdentity\} issues=\{identityIssues\} mayConfigure=\{mayConfigureTax\}/);
    assert.match(page, /href="#gst-configuration"[^>]*>\s*<IconSettings size=\{14\} \/> Configure tax profile/);
  });

  it('gates the form on the door\'s own rule — the owner, through the role union', () => {
    assert.match(page, /const mayConfigureTax = hasRole\(context, 'owner'\)/);
    assert.doesNotMatch(page, /context\.role\b/, 'the primary role alone is never consulted');
  });

  it('reads "effective since" from the audit trail the door writes, never a second table', () => {
    assert.match(page, /readSettingHistory\(\)/);
    assert.match(page, /settingHistory\.get\('gst_identity'\)\?\.\[0\]\?\.at/);
  });

  it('the GSTR callout now sends the reader to the section on this page', () => {
    assert.match(page, /href="#gst-configuration"[^>]*>Configure the tax profile above<\/a>/);
    assert.doesNotMatch(page, /Set it under Settings › Finance/);
  });
});

describe('SCR-056 · one form, one door', () => {
  const card = read(CARD);

  it('the card renders the Settings form itself — imported, not copied', () => {
    assert.match(card, /import \{ GstIdentityForm \} from '\.\.\/\.\.\/settings\/finance\/gst-identity-form'/);
    assert.match(card, /<GstIdentityForm gstin=\{identity\.gstin\} stateCode=\{identity\.stateCode\} defaultSac=\{identity\.defaultSac\} \/>/);
    assert.doesNotMatch(card, /useActionState|setGstIdentityAction|gst-identity-service|'use client'/, 'the card owns no form and no door of its own');
  });

  it('GstIdentityForm is defined exactly once in the app, and Settings › Finance still mounts it', () => {
    const definitions = walk(join(process.cwd(), 'app')).filter((f) => /export function GstIdentityForm\b/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(definitions.map((f) => f.slice(process.cwd().length + 1)), [FORM]);
    assert.match(read('app/(internal)/settings/finance/page.tsx'), /<GstIdentityForm gstin=\{gstIdentity\.gstin\}/);
  });

  it('the form\'s action revalidates the tax page as well as Settings', () => {
    const action = read('src/modules/finance/gst-identity-actions.ts');
    assert.match(action, /revalidatePath\('\/settings\/finance'\)/);
    assert.match(action, /revalidatePath\('\/finance\/tax'\)/);
  });

  it('the door is owner-only and audited in the database (core.set_gst_identity), so the app rule matches it', () => {
    const service = read('src/modules/finance/gst-identity-service.ts');
    assert.match(service, /hasRole\(context, 'owner'\)/);
    assert.match(service, /rpc\('set_gst_identity'/);
    const migration = read('supabase/migrations/20260930160000_the_agency_states_its_own_gst_identity.sql');
    assert.match(migration, /core\.is_owner\(\)/);
    assert.match(migration, /core\.record_audit\(\s*p_organization_id,\s*'organization\.gst_identity_set'/);
  });
});

describe('SCR-056 · the profile says what it holds and what it does not', () => {
  const card = read(CARD);

  it('shows GSTIN, registration state, default SAC, legal name and effective since, each honestly "Not configured" when unset', () => {
    for (const label of ['Legal name', 'GSTIN', 'Registration state', 'Default SAC', 'Effective since']) {
      assert.match(card, new RegExp(`<dt className="text-muted">${label}</dt>`), `${label} is a row`);
    }
    assert.ok((card.match(/Not configured/g) ?? []).length >= 3, 'each identity field says "Not configured" rather than showing a dash');
    assert.match(card, /never set from the panel/);
  });

  it('shows registration type, filing frequency and tax period from the saved setup, saying when it is the default', () => {
    // Owner decision 9 (2026-10-01): regular / monthly / calendar month, as organization settings. The card
    // reads them through the pure reader (unset = the decision) and never hard-codes a value.
    for (const label of ['Registration type', 'Filing frequency', 'Tax period', 'Return due next']) {
      assert.match(card, new RegExp(`<dt className="text-muted">${label}</dt>`), `${label} is a row`);
    }
    assert.match(card, /GST_REGISTRATION_LABEL\[setup\.registrationType\]/);
    assert.match(card, /setup\.explicit\.filingFrequency \? '' : <span className="text-muted"> · default<\/span>/);
    assert.doesNotMatch(codeOnly(card), /composition|monthly|quarterly/i, 'no value is written into the card: they come from the setup');
  });

  it('tells a non-owner who configures it instead of hiding the section', () => {
    assert.match(card, /Only the owner configures the tax profile — the door refuses everyone else/);
    assert.match(card, /<Card id="gst-configuration">/);
  });
});
