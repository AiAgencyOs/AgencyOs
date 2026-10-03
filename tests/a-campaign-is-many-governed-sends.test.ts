import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';
import { expandAudience, type AudienceCandidate } from '../src/modules/crm/campaign-schema.ts';
import { CAMPAIGN_REFUSAL_LABELS, CAMPAIGN_REFUSAL_REASONS, isCampaignRefusalReason } from '../src/modules/crm/campaign-types.ts';

/**
 * A campaign is many governed sends — SCR-059, owner decision 2026-09-30
 * (broadcast reopened as a governed campaign; docs/AGENCYOS_ADMIN_BUCKET_E_PLAN.md §E1).
 *
 * The rule that makes it governable: a campaign is a plan that expands into
 * one per-thread message per recipient, each through the existing
 * chokepoint. Four things pin that rule here:
 *
 *   A. the worker never imports the provider — one door, the composer's;
 *   B. approval is four-eyes in the DATABASE, not only in the page;
 *   C. the audience expansion is pure and deterministic, so the preview
 *      and the approval agree;
 *   D. a refusal reason is one of a closed set, so nothing invents a new
 *      kind of "no" that the table cannot name.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKER = codeOnly(read('src/modules/crm/campaign-worker.ts'));
const DOOR = codeOnly(read('src/modules/crm/template-send-service.ts'));
const ROUTE = codeOnly(read('app/api/jobs/run/route.ts'));
const MIGRATION = read('supabase/migrations/20260930140000_a_campaign_is_a_list_of_governed_sends.sql');
const SQL = sqlCode(MIGRATION);

const region = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to} not found`);
  return source.slice(start, end);
};

describe('A. every send passes the chokepoint', () => {
  it('the worker never imports the provider', () => {
    assert.doesNotMatch(WORKER, /@\/lib\/whatsapp\/send/);
    assert.doesNotMatch(WORKER, /sendWhatsAppTemplate/);
  });

  it('the worker sends through the shared template door, which the composer also uses', () => {
    assert.match(WORKER, /import \{ sendTemplateToConversation \} from '\.\/template-send-service'/);
    assert.match(WORKER, /await sendTemplateToConversation\(admin, \{/);
    assert.match(DOOR, /export async function sendTemplateToConversation\(/);
    assert.match(DOOR, /const outcome = await sendTemplateToConversation\(supabase, \{/);
  });

  it('the shared door is the one place the provider is reached, and the row comes first', () => {
    assert.equal((DOOR.match(/@\/lib\/whatsapp\/send/g) ?? []).length, 1);
    assert.ok(DOOR.indexOf("rpc('send_outbound_message'") < DOOR.indexOf("import('@/lib/whatsapp/send')"));
    assert.match(DOOR, /rpc\('mark_outbound_delivery'/);
    assert.match(DOOR, /await outreachAllowance\(client, input\.conversationId\)/);
  });

  it('the recipient row is the idempotency key, so a retry cannot send twice', () => {
    assert.match(WORKER, /externalRef: `campaign-\$\{row\.recipient_id\}`/);
  });

  it('the tick runs it after the invoice reminders and reports it', () => {
    assert.ok(ROUTE.indexOf('await runInvoiceReminders(admin)') < ROUTE.indexOf('await runCampaigns(admin)'));
    assert.match(ROUTE, /import \{ runCampaigns \} from '@\/modules\/crm\/campaign-worker'/);
    // Every tick report that carries the reminders carries the campaigns.
    const reminders = (ROUTE.match(/^\s+invoiceReminders,$/gm) ?? []).length;
    const campaigns = (ROUTE.match(/^\s+campaigns,$/gm) ?? []).length;
    assert.ok(reminders > 0);
    assert.equal(campaigns, reminders);
  });

  it('a spent organization allowance holds the rest rather than refusing them', () => {
    assert.match(WORKER, /if \(allowance === 'per_organization_per_day'\) \{[\s\S]{0,200}outcome\.held \+= 1;\s*break;/);
  });
});

describe('B. four eyes, in the database', () => {
  const approve = region(SQL, 'create or replace function crm.approve_campaign', 'revoke all on function crm.approve_campaign');

  it('the approver must be owner or ops_admin', () => {
    assert.match(approve, /if not coalesce\(\(select core\.is_admin\(\)\), false\) then/);
  });

  it('and must not be the person who planned it', () => {
    assert.match(approve, /if v_campaign\.created_by = v_actor then[\s\S]{0,80}'same_person'/);
    assert.match(SQL, /constraint campaigns_approver_is_not_creator check \(\s*approved_by is null or created_by is null or approved_by <> created_by\s*\)/);
  });

  it('expands the audience at approval, from the caller\'s list, and audits it', () => {
    assert.match(approve, /insert into crm\.campaign_recipients \(organization_id, campaign_id, lead_id, conversation_id\)/);
    assert.match(approve, /on conflict \(campaign_id, lead_id\) do nothing/);
    assert.match(approve, /'campaign\.approved'/);
  });

  it('the claim is FOR UPDATE SKIP LOCKED and service_role only', () => {
    const claim = region(SQL, 'create or replace function crm.claim_campaign_recipient', 'revoke all on function crm.claim_campaign_recipient');
    assert.match(claim, /for update of r skip locked/);
    assert.match(claim, /'campaign\.started'/);
    assert.match(SQL, /revoke all on function crm\.claim_campaign_recipient\(\) from public, anon, authenticated;/);
    assert.match(SQL, /grant execute on function crm\.claim_campaign_recipient\(\) to service_role;/);
    assert.match(SQL, /grant execute on function crm\.record_campaign_recipient\(uuid, text, text, uuid\) to service_role;/);
  });

  it('cancel needs a reason and is the creator\'s or the owner\'s', () => {
    const cancel = region(SQL, 'create or replace function crm.cancel_campaign', 'revoke all on function crm.cancel_campaign');
    assert.match(cancel, /'no_reason'/);
    assert.match(cancel, /not coalesce\(\(select core\.is_owner\(\)\), false\)/);
    assert.match(cancel, /'campaign\.cancelled'/);
  });

  it('every audit action the plan names is written', () => {
    for (const action of ['campaign.created', 'campaign.approved', 'campaign.started', 'campaign.cancelled', 'campaign.done', 'campaign.recipient.sent', 'campaign.recipient.refused']) {
      assert.match(SQL, new RegExp(`'${action.replace(/\./g, '\\.')}'`), `${action} is never audited`);
    }
  });

  it('both tables are tenanted, RLS-forced and granted', () => {
    for (const table of ['campaigns', 'campaign_recipients']) {
      assert.match(SQL, new RegExp(`create table if not exists crm\\.${table} \\([\\s\\S]{0,400}organization_id\\s+uuid not null references core\\.organizations\\(id\\) on delete cascade`));
      assert.match(SQL, new RegExp(`alter table crm\\.${table} enable row level security`));
      assert.match(SQL, new RegExp(`alter table crm\\.${table} force row level security`));
      assert.match(SQL, new RegExp(`create policy ${table}_select on crm\\.${table}[\\s\\S]{0,200}core\\.is_internal\\(\\)`));
      assert.match(SQL, new RegExp(`grant select, insert, update on crm\\.${table} to authenticated, service_role`));
      assert.match(SQL, new RegExp(`create trigger freeze_org_${table}[\\s\\S]{0,120}core\\.freeze_organization_id\\(\\)`));
    }
    for (const [fk, parent] of [
      ['template_id', 'crm.whatsapp_templates'],
      ['campaign_id', 'crm.campaigns'],
      ['lead_id', 'crm.leads'],
      ['conversation_id', 'crm.conversations'],
      ['message_id', 'crm.conversation_messages'],
    ]) {
      assert.match(SQL, new RegExp(`core\\.enforce_parent_org\\('${fk}', '${parent}'\\)`), `${fk} has no tenancy trigger`);
    }
  });

  it('a campaign is a template situation', () => {
    assert.match(SQL, /'invoice_reminder',\s*'campaign'\s*\)\);/);
    assert.match(codeOnly(read('src/lib/admin/settings.ts')), /'invoice_reminder',\s*'campaign',\s*\] as const;/);
  });
});

describe('C. the expansion is pure and deterministic', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const lead = (over: Partial<AudienceCandidate> & { leadId: string }): AudienceCandidate => ({
    status: 'qualified',
    source: 'whatsapp',
    assignedTo: null,
    service: 'Website',
    tags: [],
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z',
    conversationId: null,
    ...over,
  });
  const candidates = [
    lead({ leadId: 'b', createdAt: '2026-09-02T00:00:00Z', conversationId: 'conv-b', tags: ['diwali'] }),
    lead({ leadId: 'a', status: 'new', assignedTo: 'u1' }),
    lead({ leadId: 'c', source: 'referral', updatedAt: '2026-08-01T00:00:00Z', service: 'branding' }),
  ];

  it('same rows, same filter, same answer, in a stable order', () => {
    const once = expandAudience(candidates, {}, now);
    const twice = expandAudience([...candidates].reverse(), {}, now);
    assert.deepEqual(once, twice);
    assert.deepEqual(once.map((r) => r.leadId), ['a', 'c', 'b']);
  });

  it('every field of the Leads list filter narrows it', () => {
    const ids = (filter: Parameters<typeof expandAudience>[1]) => expandAudience(candidates, filter, now).map((r) => r.leadId);
    assert.deepEqual(ids({ status: 'new' }), ['a']);
    assert.deepEqual(ids({ source: 'referral' }), ['c']);
    assert.deepEqual(ids({ owner: 'u1' }), ['a']);
    assert.deepEqual(ids({ owner: 'unassigned' }), ['c', 'b']);
    assert.deepEqual(ids({ service: 'BRANDING' }), ['c']);
    assert.deepEqual(ids({ tag: 'Diwali' }), ['b']);
    assert.deepEqual(ids({ lastActivityDays: 7 }), ['a', 'b']);
    assert.deepEqual(ids({ createdFrom: '2026-09-02' }), ['b']);
    assert.deepEqual(ids({ createdTo: '2026-09-01' }), ['a', 'c']);
  });

  it('carries the thread it found, or null, so a lead with no thread is recorded rather than dropped', () => {
    const rows = expandAudience(candidates, { tag: 'diwali' }, now);
    assert.deepEqual(rows, [{ leadId: 'b', conversationId: 'conv-b' }]);
    assert.equal(expandAudience(candidates, { status: 'new' }, now)[0]?.conversationId, null);
  });

  it('is the one function both the preview and the approval call', () => {
    const service = codeOnly(read('src/modules/crm/campaign-service.ts'));
    assert.equal((service.match(/expandAudience\(candidates\.data, /g) ?? []).length, 2);
    assert.doesNotMatch(service, /\.from\('leads'\)/);
  });
});

describe('D. a refusal reason is one of a closed set', () => {
  it('every reason has a label', () => {
    for (const reason of CAMPAIGN_REFUSAL_REASONS) {
      assert.ok(CAMPAIGN_REFUSAL_LABELS[reason], `${reason} has no label — a stored value would render raw`);
    }
    assert.ok(isCampaignRefusalReason('no_consent'));
    assert.ok(!isCampaignRefusalReason('because'));
  });

  it('the shared door names its refusals from that set, plus the provider\'s own failure', () => {
    const reasons = [...DOOR.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1] ?? '');
    assert.ok(reasons.length >= 8, `only ${reasons.length} refusal sites found`);
    for (const r of reasons) {
      assert.ok(r === 'provider_failed' || isCampaignRefusalReason(r), `${r} is not in the closed set`);
    }
  });

  it('the worker records a refusal with a reason from the set, and a provider failure as failed', () => {
    const literals = [...WORKER.matchAll(/'refused', '([a-z_]+)'/g)].map((m) => m[1] ?? '');
    assert.ok(literals.length >= 3);
    for (const r of literals) assert.ok(isCampaignRefusalReason(r), `${r} is not in the closed set`);
    assert.match(WORKER, /sent\.reason === 'provider_failed'[\s\S]{0,80}record\(row\.recipient_id, 'failed', sent\.message\)/);
    assert.match(WORKER, /record\(row\.recipient_id, 'refused', sent\.reason\)/);
  });

  it('the database will not record a refusal without a reason', () => {
    assert.match(SQL, /constraint campaign_recipients_refused_says_why check \(\s*status not in \('refused', 'failed'\) or reason is not null\s*\)/);
    assert.match(region(SQL, 'create or replace function crm.record_campaign_recipient', 'revoke all on function crm.record_campaign_recipient'), /'no_reason'/);
  });
});
