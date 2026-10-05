import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { err, ok, type Result } from '@/lib/result';

import { AD_PLATFORMS } from './ad-vocabulary';
import { B2B_PLATFORMS } from './b2b-vocabulary';
import { addProspectFact, qualifyProspect, validateOutreachDraft, type FactSource } from './email-engine';
import { QUALIFICATION_FACTORS, type QualificationFactor } from './qualification-vocabulary';
import { CONTENT_FORMATS, CONTENT_OBJECTIVES, SOCIAL_PLATFORMS } from './social-vocabulary';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * What an acquisition agent's tools DO (ADM-112 defined them, ADM-113 turned them on).
 *
 * Each tool is a thin, org-scoped call to a door that already exists and already refuses what it should. Three things are true of every
 * one of them, and `tests/lead-generation-agent-tools.test.ts` pins them:
 *
 *   - the organisation is the JOB'S, handed in by the runner - never the model's input, so a prompt cannot name another tenant;
 *   - what an agent writes is stamped `agent`, so a person can see whose work a version is, and the doors that refuse an agent a price
 *     (ADM-22) or a human-only step see it for what it is;
 *   - none of them sends, publishes, launches, deploys, prices, approves or pauses. Submitting asks a PERSON to approve the exact version;
 *     the approval, the once-only execution and the stops all sit beyond this file and are not reachable from it.
 *
 * The result is a STRING of JSON, bounded, because that is what a model reads back.
 */

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
const crm = (admin: Admin): Rpc => (fn, args) => (admin.schema('crm') as unknown as { rpc: Rpc }).rpc(fn, args);
const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

const MAX_RESULT = 12000;
const json = (value: unknown): Result<string> => {
  const text = JSON.stringify(value);
  return ok(text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…[truncated]` : text);
};

type In = Record<string, unknown>;
const str = (v: unknown, max = 4000): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);
const optStr = (v: unknown, max = 4000): string | null | undefined => (v === undefined || v === null || v === '' ? null : str(v, max) ?? undefined);
const uuid = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null);
const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const bad = (what: string) => err('VALIDATION', what);
const refused = (tool: string, outcome: string | undefined) => err('CONFLICT', `${tool} was refused by the rules: ${outcome ?? 'no answer'}.`);

const OBJ = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const ID = { type: 'string', format: 'uuid' };

export const ACQUISITION_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  'acquisition.readResults': OBJ({ days: { type: 'integer', minimum: 1, maximum: 365 } }, []),
  'email.readProspects': OBJ({ limit: { type: 'integer', minimum: 1, maximum: 30 } }, []),
  'social.readContentQueue': OBJ({ limit: { type: 'integer', minimum: 1, maximum: 30 } }, []),
  'ads.readCampaigns': OBJ({ platform: { type: 'string', enum: [...AD_PLATFORMS] } }, ['platform']),
  'marketplace.readOpportunities': OBJ({ limit: { type: 'integer', minimum: 1, maximum: 30 } }, []),

  'email.scoreProspect': OBJ({
    prospectId: ID, reasoning: { type: 'string' },
    factors: { type: 'object', description: 'Each factor 0-100. A factor you cannot support is LEFT OUT, which lowers the score.', properties: Object.fromEntries(QUALIFICATION_FACTORS.map((f) => [f, { type: 'integer', minimum: 0, maximum: 100 }])), additionalProperties: false },
  }, ['prospectId', 'factors', 'reasoning']),
  'email.recordProspectFact': OBJ({ prospectId: ID, fact: { type: 'string' }, sourceKind: { type: 'string', enum: ['website', 'linkedin', 'directory', 'press'] }, sourceUrl: { type: 'string' } }, ['prospectId', 'fact', 'sourceKind', 'sourceUrl']),
  'email.checkDraft': OBJ({
    prospectId: ID, subject: { type: 'string' }, body: { type: 'string' },
    claims: { type: 'array', items: OBJ({ text: { type: 'string' }, factId: ID }, ['text', 'factId']) },
  }, ['prospectId', 'subject', 'body', 'claims']),

  'social.draftContent': OBJ({
    platform: { type: 'string', enum: [...SOCIAL_PLATFORMS] }, objective: { type: 'string', enum: [...CONTENT_OBJECTIVES] }, format: { type: 'string', enum: [...CONTENT_FORMATS] },
    title: { type: 'string' }, service: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } },
  }, ['platform', 'objective', 'format', 'title', 'body']),
  'social.reviewContent': OBJ({ versionId: ID }, ['versionId']),
  'social.submitContent': OBJ({ versionId: ID }, ['versionId']),

  'ads.draftCampaign': OBJ({
    platform: { type: 'string', enum: [...AD_PLATFORMS] }, campaignId: ID, name: { type: 'string' }, service: { type: 'string' },
    plan: { type: 'object' }, dailyMinor: { type: 'integer', minimum: 1 }, totalMinor: { type: 'integer', minimum: 1 }, startDate: { type: 'string' }, endDate: { type: 'string' },
  }, ['platform', 'name', 'plan', 'dailyMinor']),
  'ads.checkCampaign': OBJ({ versionId: ID }, ['versionId']),
  'ads.submitCampaign': OBJ({ versionId: ID }, ['versionId']),

  'landing.draftPage': OBJ({ pageId: ID, name: { type: 'string' }, slug: { type: 'string' }, service: { type: 'string' }, content: { type: 'object' }, publicUrl: { type: 'string' } }, ['name', 'slug', 'content', 'publicUrl']),
  'landing.checkPage': OBJ({ versionId: ID }, ['versionId']),
  'landing.submitPage': OBJ({ versionId: ID }, ['versionId']),

  'marketplace.scoreOpportunity': OBJ({
    platform: { type: 'string', enum: [...B2B_PLATFORMS] }, externalRef: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
    budgetMinMinor: { type: 'integer', minimum: 0 }, budgetMaxMinor: { type: 'integer', minimum: 0 }, currency: { type: 'string' }, country: { type: 'string' },
  }, ['platform', 'externalRef', 'title', 'description']),
  'marketplace.draftProposal': OBJ({ opportunityId: ID, body: { type: 'string' }, timelineDays: { type: 'integer', minimum: 1, maximum: 730 }, portfolioIds: { type: 'array', items: ID } }, ['opportunityId', 'body']),
  'marketplace.checkProposal': OBJ({ versionId: ID }, ['versionId']),
  'marketplace.submitProposal': OBJ({ versionId: ID }, ['versionId']),
};

export const ACQUISITION_TOOL_NAMES: readonly string[] = Object.keys(ACQUISITION_TOOL_SCHEMAS);

/** Run one acquisition tool for one organisation. The caller has already cleared the registry boundary and the tenant's permissions. */
export async function runAcquisitionTool(admin: Admin, organizationId: string, name: string, input: unknown): Promise<Result<string>> {
  const i: In = typeof input === 'object' && input !== null ? (input as In) : {};
  const door = crm(admin);

  // ── reads ─────────────────────────────────────────────────────────────────
  if (name === 'acquisition.readResults') {
    const days = i.days === undefined ? 30 : int(i.days, 1, 365);
    if (days === null) return bad('days must be a whole number from 1 to 365.');
    const { data, error } = await door('agent_results', { p_organization_id: organizationId, p_days: days });
    if (error) return err('INTERNAL', 'Could not read the results.');
    const { data: channels, error: chError } = await admin.schema('crm').from('acquisition_channels').select('channel, enabled, paused, monthly_qualified_target, monthly_budget_minor').eq('organization_id', organizationId);
    if (chError) return err('INTERNAL', 'Could not read the channel settings.');
    return json({ days, byFirstTouch: data ?? [], channels: channels ?? [], note: 'Counted from the CRM by first touch. A cost with nothing to divide by is null; fewer than 10 leads is insufficient data.' });
  }
  if (name === 'email.readProspects') {
    const limit = i.limit === undefined ? 20 : int(i.limit, 1, 30);
    if (limit === null) return bad('limit must be 1 to 30.');
    const { data, error } = await admin.schema('crm').from('outreach_prospects').select('id, email, full_name, company').eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(limit);
    if (error) return err('INTERNAL', 'Could not read the prospects.');
    const ids = (data ?? []).map((p) => p.id);
    const { data: facts, error: factsError } = ids.length === 0 ? { data: [], error: null } : await admin.schema('crm').from('prospect_facts').select('id, prospect_id, fact, source_kind, source_url').eq('organization_id', organizationId).in('prospect_id', ids).limit(200);
    if (factsError) return err('INTERNAL', 'Could not read the prospect facts.');
    return json({ prospects: data ?? [], facts: facts ?? [] });
  }
  if (name === 'social.readContentQueue') {
    const limit = i.limit === undefined ? 20 : int(i.limit, 1, 30);
    if (limit === null) return bad('limit must be 1 to 30.');
    const { data, error } = await admin.schema('crm').from('content_items').select('id, platform, objective, format, title, created_at').eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(limit);
    if (error) return err('INTERNAL', 'Could not read the content queue.');
    const ids = (data ?? []).map((c) => c.id);
    const { data: versions, error: vError } = ids.length === 0 ? { data: [], error: null } : await admin.schema('crm').from('content_versions').select('id, item_id, version, state, review, scheduled_for, created_by_type').eq('organization_id', organizationId).in('item_id', ids).order('version', { ascending: false }).limit(150);
    if (vError) return err('INTERNAL', 'Could not read the content versions.');
    return json({ items: data ?? [], versions: versions ?? [] });
  }
  if (name === 'ads.readCampaigns') {
    const platform = oneOf(i.platform, AD_PLATFORMS);
    if (!platform) return bad('platform must be meta_ads or google_ads.');
    const { data, error } = await admin.schema('crm').from('ad_campaigns').select('id, platform, name, target_service, status, provider_sync_pending, currency, live_version_id').eq('organization_id', organizationId).eq('platform', platform).order('created_at', { ascending: false }).limit(20);
    if (error) return err('INTERNAL', 'Could not read the campaigns.');
    const ids = (data ?? []).map((c) => c.id);
    const { data: versions, error: vError } = ids.length === 0 ? { data: [], error: null } : await admin.schema('crm').from('ad_campaign_versions').select('id, campaign_id, version, state, change_kind, budget_daily_minor, budget_total_minor, start_date, end_date, review').eq('organization_id', organizationId).in('campaign_id', ids).order('version', { ascending: false }).limit(100);
    if (vError) return err('INTERNAL', 'Could not read the campaign versions.');
    return json({ campaigns: data ?? [], versions: versions ?? [] });
  }
  if (name === 'marketplace.readOpportunities') {
    const limit = i.limit === undefined ? 20 : int(i.limit, 1, 30);
    if (limit === null) return bad('limit must be 1 to 30.');
    const { data, error } = await admin.schema('crm').from('b2b_opportunities').select('id, platform, title, status, fit_score, fit_reasons, budget_max_minor, currency, skip_reason').eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(limit);
    if (error) return err('INTERNAL', 'Could not read the opportunities.');
    const ids = (data ?? []).map((o) => o.id);
    const { data: proposals, error: pError } = ids.length === 0 ? { data: [], error: null } : await admin.schema('crm').from('b2b_proposal_versions').select('id, opportunity_id, version, state, review, created_by_type').eq('organization_id', organizationId).in('opportunity_id', ids).order('version', { ascending: false }).limit(100);
    if (pError) return err('INTERNAL', 'Could not read the proposals.');
    return json({ opportunities: data ?? [], proposals: proposals ?? [] });
  }

  // ── email ─────────────────────────────────────────────────────────────────
  if (name === 'email.scoreProspect') {
    const prospectId = uuid(i.prospectId);
    const reasoning = str(i.reasoning, 2000);
    const raw = typeof i.factors === 'object' && i.factors !== null ? (i.factors as In) : null;
    if (!prospectId || !reasoning || !raw) return bad('prospectId, reasoning and factors are required.');
    const factors: Partial<Record<QualificationFactor, number>> = {};
    for (const [k, v] of Object.entries(raw)) {
      const f = oneOf(k, QUALIFICATION_FACTORS);
      const n = int(v, 0, 100);
      if (!f || n === null) return bad(`"${k}" is not a factor 0-100.`);
      factors[f] = n;
    }
    const r = await qualifyProspect(admin, { organizationId, prospectId, factors, reasoning, evaluatedBy: 'agent' });
    return r.ok ? json({ decision: r.decision, score: r.score, disqualifiers: r.disqualifiers, missing: r.missing }) : refused(name, r.refusal);
  }
  if (name === 'email.recordProspectFact') {
    const prospectId = uuid(i.prospectId);
    const fact = str(i.fact, 1000);
    const sourceKind = oneOf(i.sourceKind, ['website', 'linkedin', 'directory', 'press'] as const satisfies readonly FactSource[]);
    const sourceUrl = str(i.sourceUrl, 1000);
    if (!prospectId || !fact || !sourceKind || !sourceUrl) return bad('prospectId, fact, a sourceKind (website, linkedin, directory, press) and its sourceUrl are required.');
    const r = await addProspectFact(admin, { organizationId, prospectId, fact, sourceKind, sourceUrl, recordedBy: 'agent' });
    return r.ok ? json({ factId: r.factId }) : refused(name, r.refusal);
  }
  if (name === 'email.checkDraft') {
    const prospectId = uuid(i.prospectId);
    const subject = str(i.subject, 300);
    const body = str(i.body, 8000);
    const claimsIn = Array.isArray(i.claims) ? i.claims : null;
    if (!prospectId || !subject || !body || !claimsIn || claimsIn.length > 20) return bad('prospectId, subject, body and claims (up to 20) are required.');
    const claims: { text: string; factId: string }[] = [];
    for (const c of claimsIn) {
      const text = str((c as In)?.text, 500);
      const factId = uuid((c as In)?.factId);
      if (!text || !factId) return bad('every claim needs its text and the factId it rests on.');
      claims.push({ text, factId });
    }
    const r = await validateOutreachDraft(admin, { organizationId, prospectId, subject, body, claims });
    return json({ valid: r.valid, problems: r.problems, note: 'A passing check does not approve or send anything.' });
  }

  // ── social ────────────────────────────────────────────────────────────────
  if (name === 'social.draftContent') {
    const platform = oneOf(i.platform, SOCIAL_PLATFORMS);
    const objective = oneOf(i.objective, CONTENT_OBJECTIVES);
    const format = oneOf(i.format, CONTENT_FORMATS);
    const title = str(i.title, 200);
    const body = str(i.body, 3000);
    const service = optStr(i.service, 80);
    const cta = optStr(i.cta, 300);
    const hashtags = Array.isArray(i.hashtags) && i.hashtags.length <= 30 && i.hashtags.every((h) => typeof h === 'string' && h.length <= 60) ? (i.hashtags as string[]) : i.hashtags === undefined ? [] : null;
    if (!platform || !objective || !format || !title || !body || service === undefined || cta === undefined || hashtags === null) return bad('platform, objective, format, title and body are required and must be within limits.');
    const made = await door('create_content_item', { p_organization_id: organizationId, p_platform: platform, p_objective: objective, p_format: format, p_strategy: null, p_service: service, p_title: title, p_by_type: 'agent' });
    if (made.error) return err('INTERNAL', 'Could not start the draft.');
    const item = first<{ outcome?: string; item_id?: string }>(made.data);
    if (item?.outcome !== 'created' || !item.item_id) return refused(name, item?.outcome);
    const v = await door('add_content_version', { p_organization_id: organizationId, p_item: item.item_id, p_body: body, p_cta: cta, p_hashtags: hashtags, p_asset_ids: [], p_reference_ids: [], p_by_type: 'agent' });
    if (v.error) return err('INTERNAL', 'Could not save the draft.');
    const ver = first<{ outcome?: string; version_id?: string }>(v.data);
    return ver?.outcome === 'created' && ver.version_id ? json({ itemId: item.item_id, versionId: ver.version_id, note: 'A draft. Nothing is approved or published.' }) : refused(name, ver?.outcome);
  }
  if (name === 'social.reviewContent' || name === 'social.submitContent') {
    const versionId = uuid(i.versionId);
    if (!versionId) return bad('versionId is required.');
    const fn = name === 'social.reviewContent' ? 'review_content_version' : 'submit_for_admin_review';
    const r = await door(fn, { p_organization_id: organizationId, p_version: versionId });
    if (r.error) return err('INTERNAL', 'The call failed.');
    return json(first(r.data) ?? {});
  }

  // ── ads and landing pages ─────────────────────────────────────────────────
  if (name === 'ads.draftCampaign') {
    const platform = oneOf(i.platform, AD_PLATFORMS);
    const nameIn = str(i.name, 120);
    const plan = typeof i.plan === 'object' && i.plan !== null && !Array.isArray(i.plan) ? (i.plan as In) : null;
    const dailyMinor = int(i.dailyMinor, 1, 1_000_000_000_000);
    const totalMinor = i.totalMinor === undefined ? null : int(i.totalMinor, 1, 1_000_000_000_000);
    const service = optStr(i.service, 80);
    const startDate = optStr(i.startDate, 10);
    const endDate = optStr(i.endDate, 10);
    let campaignId = i.campaignId === undefined ? null : uuid(i.campaignId);
    if (!platform || !nameIn || !plan || dailyMinor === null || (i.totalMinor !== undefined && totalMinor === null) || service === undefined || startDate === undefined || endDate === undefined || (i.campaignId !== undefined && !campaignId)) return bad('platform, name, plan and a daily budget above zero are required.');
    if (!campaignId) {
      const made = await door('create_ad_campaign', { p_organization_id: organizationId, p_platform: platform, p_name: nameIn, p_target_service: service });
      if (made.error) return err('INTERNAL', 'Could not start the campaign.');
      const c = first<{ outcome?: string; campaign_id?: string }>(made.data);
      if (c?.outcome !== 'created' || !c.campaign_id) return refused(name, c?.outcome);
      campaignId = c.campaign_id;
    }
    const v = await door('add_ad_version', { p_organization_id: organizationId, p_campaign: campaignId, p_plan: plan, p_daily_minor: dailyMinor, p_total_minor: totalMinor, p_start: startDate, p_end: endDate, p_by_type: 'agent' });
    if (v.error) return err('INTERNAL', 'Could not save the plan.');
    const ver = first<{ outcome?: string; version_id?: string }>(v.data);
    return ver?.outcome === 'added' && ver.version_id ? json({ campaignId, versionId: ver.version_id, note: 'A draft. Nothing is sent to a platform; a launch or a budget increase needs a person.' }) : refused(name, ver?.outcome);
  }
  if (name === 'landing.draftPage') {
    const nameIn = str(i.name, 120);
    const slug = str(i.slug, 80);
    const content = typeof i.content === 'object' && i.content !== null && !Array.isArray(i.content) ? (i.content as In) : null;
    const publicUrl = str(i.publicUrl, 500);
    const service = optStr(i.service, 80);
    let pageId = i.pageId === undefined ? null : uuid(i.pageId);
    if (!nameIn || !slug || !content || !publicUrl || service === undefined || (i.pageId !== undefined && !pageId)) return bad('name, slug, content and publicUrl are required.');
    if (!pageId) {
      const made = await door('create_landing_page', { p_organization_id: organizationId, p_name: nameIn, p_slug: slug, p_target_service: service });
      if (made.error) return err('INTERNAL', 'Could not start the page.');
      const p = first<{ outcome?: string; page_id?: string }>(made.data);
      if (p?.outcome !== 'created' || !p.page_id) return refused(name, p?.outcome);
      pageId = p.page_id;
    }
    const v = await door('add_landing_version', { p_organization_id: organizationId, p_page: pageId, p_content: content, p_public_url: publicUrl, p_by_type: 'agent' });
    if (v.error) return err('INTERNAL', 'Could not save the page.');
    const ver = first<{ outcome?: string; version_id?: string }>(v.data);
    return ver?.outcome === 'added' && ver.version_id ? json({ pageId, versionId: ver.version_id, note: 'A draft. Nothing is deployed; a person approves this exact version.' }) : refused(name, ver?.outcome);
  }
  const VERSION_DOORS: Record<string, string> = {
    'ads.checkCampaign': 'check_ad_version', 'ads.submitCampaign': 'submit_ad_version',
    'landing.checkPage': 'check_landing_version', 'landing.submitPage': 'submit_landing_version',
    'marketplace.checkProposal': 'check_b2b_proposal', 'marketplace.submitProposal': 'submit_b2b_proposal',
  };
  if (VERSION_DOORS[name]) {
    const versionId = uuid(i.versionId);
    if (!versionId) return bad('versionId is required.');
    const r = await door(VERSION_DOORS[name], { p_organization_id: organizationId, p_version: versionId });
    if (r.error) return err('INTERNAL', 'The call failed.');
    return json(first(r.data) ?? {});
  }

  // ── marketplace ───────────────────────────────────────────────────────────
  if (name === 'marketplace.scoreOpportunity') {
    const platform = oneOf(i.platform, B2B_PLATFORMS);
    const externalRef = str(i.externalRef, 200);
    const title = str(i.title, 300);
    const description = str(i.description, 8000);
    const url = optStr(i.url, 500);
    const country = optStr(i.country, 80);
    const currency = i.currency === undefined ? 'USD' : str(i.currency, 3);
    const min = i.budgetMinMinor === undefined ? null : int(i.budgetMinMinor, 0, 1_000_000_000_000);
    const max = i.budgetMaxMinor === undefined ? null : int(i.budgetMaxMinor, 0, 1_000_000_000_000);
    if (!platform || !externalRef || !title || !description || url === undefined || country === undefined || !currency || (i.budgetMinMinor !== undefined && min === null) || (i.budgetMaxMinor !== undefined && max === null)) return bad('platform, externalRef, title and description are required.');
    const r = await door('record_b2b_opportunity', { p_organization_id: organizationId, p_platform: platform, p_external_ref: externalRef, p_url: url, p_title: title, p_description: description, p_budget_min_minor: min, p_budget_max_minor: max, p_currency: currency, p_client_country: country, p_posted_at: null, p_source: 'assisted_import' });
    if (r.error) return err('INTERNAL', 'Could not record the opportunity.');
    const o = first<{ outcome?: string; opportunity_id?: string; status?: string; score?: number }>(r.data);
    return o?.outcome === 'recorded' && o.opportunity_id ? json({ opportunityId: o.opportunity_id, status: o.status, score: o.score, note: 'Scored from the Admin thresholds. Shortlisting is a person\'s decision.' }) : refused(name, o?.outcome);
  }
  if (name === 'marketplace.draftProposal') {
    const opportunityId = uuid(i.opportunityId);
    const body = str(i.body, 8000);
    const timeline = i.timelineDays === undefined ? null : int(i.timelineDays, 1, 730);
    const portfolio = Array.isArray(i.portfolioIds) && i.portfolioIds.length <= 20 && i.portfolioIds.every((p) => uuid(p)) ? (i.portfolioIds as string[]) : i.portfolioIds === undefined ? [] : null;
    if (!opportunityId || !body || (i.timelineDays !== undefined && timeline === null) || portfolio === null) return bad('opportunityId and body are required.');
    // A price is never passed: the door refuses one from anything but a signed-in person (ADM-22), and this file does not offer the argument.
    const r = await door('add_b2b_proposal_version', { p_organization_id: organizationId, p_opportunity: opportunityId, p_body: body, p_price_minor: null, p_timeline_days: timeline, p_connects_cost: 0, p_portfolio_item_ids: portfolio, p_by_type: 'agent' });
    if (r.error) return err('INTERNAL', 'Could not save the proposal.');
    const p = first<{ outcome?: string; version_id?: string }>(r.data);
    return p?.outcome === 'added' && p.version_id ? json({ versionId: p.version_id, note: 'A draft with no price. A person prices it and approves this exact version.' }) : refused(name, p?.outcome);
  }

  return err('INTERNAL', `"${name}" has no acquisition handler.`);
}
