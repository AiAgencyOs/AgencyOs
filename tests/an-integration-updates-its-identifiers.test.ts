import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket G, stream G-2 — SCR-070's "Update non-secret identifiers" is a
 * primary action on the integration itself, not a pointer to Settings ›
 * Communication. The rule for closing it: the SAME settings forms and the
 * SAME door (`setOrganizationSetting` → `core.set_organization_setting`,
 * whitelisted keys, audited) mounted in the integration's own drawer, each
 * identifier with its current value and effective date from the audit
 * trail; secrets stay behind "Open secure key storage"; an identifier the
 * environment carries is shown as presence and stated as not editable.
 */

const PAGE = 'app/(internal)/integrations/page.tsx';
const LIST = 'app/(internal)/integrations/integrations-list.tsx';
const ACTIONS = 'app/(internal)/settings/actions.ts';

describe('SCR-070 · the integration row carries the update control', () => {
  const page = read(PAGE);
  const list = read(LIST);

  it('the page mounts the Settings forms — imported from settings/forms, never re-declared', () => {
    assert.match(page, /import \{ TestRecipientForm, VerifyAiProviderForm, VerifyCalendarForm, VerifyWhatsAppButton, WhatsAppNumberForm \} from '\.\.\/settings\/forms'/);
    assert.match(page, /<WhatsAppNumberForm current=\{whatsappNumberId\} \/>/);
    assert.match(page, /<TestRecipientForm current=\{whatsappTestRecipient\} \/>/);
    assert.doesNotMatch(page, /useActionState|setOrganizationSetting\(/, 'the page owns no form and calls no door itself');
    assert.match(page, /editors=\{editors\} secrets=\{secrets\}/);
  });

  it('each panel-set identifier shows its current value and its effective date from the audit trail', () => {
    assert.match(page, /readSettingHistory\(\)/);
    assert.match(page, /effective: effectiveOf\('whatsapp_phone_number_id'\)/);
    assert.match(page, /effective: effectiveOf\('whatsapp_test_recipient'\)/);
    assert.match(page, /<SettingHistory label="WhatsApp phone number id" entries=\{historyOf\('whatsapp_phone_number_id'\)\} \/>/);
    assert.match(page, /<SettingHistory label="Internal WhatsApp test recipient" entries=\{historyOf\('whatsapp_test_recipient'\)\} \/>/);
    assert.match(list, /row\.effective/);
  });

  it('the drawer has the two SCR-070 actions by name, and says when there is nothing to update', () => {
    assert.match(list, />Update non-secret identifiers</);
    assert.match(list, />\s*Update identifiers\s*</);
    assert.match(list, />\s*Open secure key storage\s*</);
    assert.match(list, /editors\[open\.id\]/);
    assert.match(list, /cannot change them\. Nothing here is a secret, and nothing here is editable/);
    assert.match(list, /reads no non-secret identifier from the panel; there is nothing to update here/);
  });

  it('environment-carried identifiers are presence only — the page never reads a value from the environment', () => {
    assert.match(page, /configStatus\(\)/);
    assert.match(page, /envPresent\('ALERT_WEBHOOK_URL'\)/);
    assert.match(page, /envPresent\('GOOGLE_CALENDAR_ID'\)/);
    assert.doesNotMatch(page, /process\.env|serverEnv\(/, 'no value of an environment variable reaches the page');
    assert.match(page, /not editable from the panel/);
  });

  it('secrets stay out: every external integration says where its credential lives, and the drawer links only where the panel holds one', () => {
    for (const id of ['whatsapp', "'ai-provider'", 'transcriber', "'image-generator'", 'github', 'alerts']) {
      assert.match(page, new RegExp(`${id}: \\{ href:`), `${id} has a secure-storage entry`);
    }
    assert.match(page, /github: \{ href: null/);
    assert.match(page, /alerts: \{ href: null/);
    assert.doesNotMatch(page, /WHATSAPP_ACCESS_TOKEN\b[^']*\}/, 'a secret is named, never read');
  });
});

describe('SCR-070 · the same door, audited, revalidating the row it is now mounted on', () => {
  it('the forms\' actions go through setOrganizationSetting and revalidate /integrations as well as /settings', () => {
    const actions = read(ACTIONS);
    const number = actions.slice(actions.indexOf('export async function setWhatsAppNumberAction'), actions.indexOf('export async function setTestRecipientAction'));
    const recipient = actions.slice(actions.indexOf('export async function setTestRecipientAction'), actions.indexOf('export async function setTestRecipientAction') + 900);
    assert.match(number, /setOrganizationSetting\('whatsapp_phone_number_id'/);
    assert.match(number, /revalidatePath\('\/integrations'\)/);
    assert.match(recipient, /setOrganizationSetting\('whatsapp_test_recipient'/);
    assert.match(recipient, /revalidatePath\('\/integrations'\)/);
  });

  it('the door checks the role union and the database whitelists exactly these keys and audits', () => {
    const settings = read('src/lib/admin/settings.ts');
    const door = settings.slice(settings.indexOf('export async function setOrganizationSetting'), settings.indexOf('export type OutreachLimits'));
    assert.match(door, /can\(context, 'organization\.settings'\)/);
    assert.match(door, /rpc\('set_organization_setting'/);
    const migration = read('supabase/migrations/20260929110000_two_more_settings_the_owner_can_set.sql');
    assert.match(migration, /'whatsapp_phone_number_id',\s*'whatsapp_test_recipient'/);
    assert.match(migration, /record_audit|audit\.audit_log/);
  });

  it('the history helper keys organization.setting_set entries by the setting they name, so "effective" is that key\'s newest entry', () => {
    const history = read('src/lib/admin/settings-history.ts');
    assert.match(history, /if \(action === 'organization\.setting_set'\) \{\s*const key = after\?\.key \?\? before\?\.key/);
    assert.match(read('app/(internal)/settings/setting-history.tsx'), /effective \{latest\.atLabel\}/);
  });
});
