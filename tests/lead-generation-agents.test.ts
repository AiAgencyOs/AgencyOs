import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { AGENT_DEFINITIONS, mayHandOff } from '../src/modules/agents/registry.ts';
import { toolDefinition } from '../src/modules/agents/tools.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/20261028100000_the_acquisition_agents_are_installed_disabled.sql');
const dispatch = read('src/modules/agents/tool-dispatch.ts');
const service = read('src/modules/acquisition/service.ts');
const queries = read('src/modules/acquisition/queries.ts');
const emailEngine = read('src/modules/acquisition/email-engine.ts');

const KEYS = ['ad_manager', 'email_outreach', 'social_media', 'marketplace_opportunity'] as const;
const agent = (k: string) => {
  const a = AGENT_DEFINITIONS.find((d) => d.key === k);
  assert.ok(a, `${k} is not defined`);
  return a;
};

/** Each tool is a thin name for an existing acquisition action; this is the map a reader can check. */
const MAPS_TO: Record<string, string> = {
  'acquisition.readResults': 'readAcquisitionFunnel',
  'email.readProspects': 'listOutreachProspects',
  'social.readContentQueue': 'listContentQueue',
  'ads.readCampaigns': 'listAdCampaigns',
  'marketplace.readOpportunities': 'listB2bOpportunities',
  'email.scoreProspect': 'scoreProspect',
  'email.recordProspectFact': 'recordProspectFact',
  'email.checkDraft': 'checkDraft',
  'social.draftContent': 'createContentDraft',
  'social.reviewContent': 'reviewContentVersion',
  'social.submitContent': 'submitContentForApproval',
  'ads.draftCampaign': 'saveAdPlan',
  'ads.checkCampaign': 'checkAdVersion',
  'ads.submitCampaign': 'submitAdVersion',
  'landing.draftPage': 'saveLandingVersion',
  'landing.checkPage': 'checkLandingVersion',
  'landing.submitPage': 'submitLandingVersion',
  'marketplace.scoreOpportunity': 'importB2bOpportunity',
  'marketplace.draftProposal': 'saveB2bProposal',
  'marketplace.checkProposal': 'checkB2bProposal',
  'marketplace.submitProposal': 'submitB2bProposal',
};

describe('lead generation - the acquisition agents (ADM-112)', () => {
  test('the four agents the specification names exist; scheduler and quotation are not agents here', () => {
    for (const k of KEYS) agent(k);
    assert.ok(!AGENT_DEFINITIONS.some((d) => /scheduler|quotation|landing/.test(d.key)));
  });

  test('they are installed disabled, and a definition is not an activation', () => {
    for (const k of KEYS) assert.match(migration, new RegExp(`\\('${k}',[\\s\\S]*?'L1', false,`), `${k} is not seeded disabled`);
    assert.doesNotMatch(migration, /enabled\s*=\s*true|'L[012]',\s*true/);
  });

  test('none of them holds a tool that sends, publishes, launches, deploys, prices, approves or pauses', () => {
    for (const k of KEYS) {
      for (const name of agent(k).tools) {
        const tool = toolDefinition(name);
        assert.ok(tool, `${name} is bound but does not exist`);
        assert.notEqual(tool.actionClass, 'L2', `${k} holds the consequential ${name}`);
        assert.equal(tool.clientFacing, false, name);
        assert.equal(tool.touchesMoney, false, name);
        assert.doesNotMatch(name, /send|publish|launch|deploy|price|pricing|approve|decide|pause|spend|apply|post\b/i, `${k} holds ${name}`);
      }
      assert.equal(agent(k).moneyAuthority, 'none');
      assert.equal(agent(k).mayVerify, false);
    }
  });

  test('their handoffs go only to sales and quality assurance, and are mirrored in the database', () => {
    for (const k of KEYS) {
      assert.deepEqual([...agent(k).handoffTargets].sort(), ['quality_assurance', 'sales']);
      assert.equal(mayHandOff(k, 'sales'), true);
      assert.equal(mayHandOff(k, 'finance'), false);
      assert.match(migration, new RegExp(`\\('${k}', 'sales'\\)`));
      assert.match(migration, new RegExp(`\\('${k}', 'quality_assurance'\\)`));
      assert.equal(agent(k).verification.verifiedBy, 'quality_assurance');
    }
  });

  test('every tool names an action that exists in the acquisition module', () => {
    const code = `${service}\n${queries}\n${emailEngine}`;
    for (const [tool, fn] of Object.entries(MAPS_TO)) {
      assert.ok(toolDefinition(tool), `${tool} is not in the tool list`);
      assert.match(code, new RegExp(`export async function ${fn}\\b`), `${tool} names ${fn}, which does not exist`);
    }
    const bound = new Set(KEYS.flatMap((k) => agent(k).tools));
    for (const t of Object.keys(MAPS_TO)) assert.ok(bound.has(t), `${t} is mapped but bound to no agent`);
  });

  test('nothing here dispatches: the ADM-99 boundary still admits the four read-only tools and no acquisition tool', () => {
    for (const t of Object.keys(MAPS_TO)) assert.ok(!dispatch.includes(`'${t}'`), `${t} is dispatchable`);
    for (const t of ['crm.readLead', 'crm.readConversation', 'memory.recall', 'projects.readScope']) assert.ok(dispatch.includes(t), t);
  });
});
