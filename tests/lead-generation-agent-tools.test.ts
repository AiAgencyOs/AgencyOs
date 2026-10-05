import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ACQUISITION_TOOL_NAMES, ACQUISITION_TOOL_SCHEMAS, runAcquisitionTool } from '../src/modules/acquisition/agent-tools.ts';
import { AGENT_DEFINITIONS } from '../src/modules/agents/registry.ts';
import { TOOLS } from '../src/modules/agents/tools.ts';

type Call = { fn: string; args: Record<string, unknown> };
const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const U = '00000000-0000-4000-8000-0000000000cc';

/** A stand-in for the service-role client that records every door it is asked to open and answers as a door would. */
function fake(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const admin = {
    schema: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve({ data: answers[fn] ?? [{ outcome: 'created', item_id: U, version_id: U, campaign_id: U, page_id: U, opportunity_id: U }], error: null });
      },
      from: (table: string) => {
        const rec = { table, filters: [] as [string, unknown][] };
        reads.push(rec);
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'order', 'limit']) chain[m] = () => chain;
        chain.eq = (c: string, v: unknown) => { rec.filters.push([c, v]); return chain; };
        chain.in = () => chain;
        chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
        return chain;
      },
    }),
  };
  return { admin: admin as never, calls, reads };
}

describe('lead generation - what the acquisition tools do when an agent calls them (ADM-113)', () => {
  test('every tool an acquisition agent holds has a schema and a handler, and nothing else is offered', () => {
    const held = new Set(AGENT_DEFINITIONS.filter((a) => a.layer === 'acquisition').flatMap((a) => a.tools).filter((t) => /^(acquisition|email|social|ads|landing|marketplace)\./.test(t)));
    assert.deepEqual([...held].sort(), [...ACQUISITION_TOOL_NAMES].sort());
    for (const n of ACQUISITION_TOOL_NAMES) assert.ok(TOOLS.some((t) => t.name === n), `${n} is not a registered tool`);
  });

  test('the organisation is the job\'s: a model that names another one in its input changes nothing', async () => {
    const f = fake();
    const r = await runAcquisitionTool(f.admin, ORG, 'social.draftContent', { organizationId: OTHER, p_organization_id: OTHER, platform: 'linkedin', objective: 'authority', format: 'text', title: 'Planning a storefront', body: 'A short post about planning a storefront.' });
    assert.equal(r.ok, true);
    assert.ok(f.calls.length >= 2);
    for (const c of f.calls) assert.equal(c.args.p_organization_id, ORG, c.fn);
    const reads = fake();
    await runAcquisitionTool(reads.admin, ORG, 'ads.readCampaigns', { platform: 'meta_ads', organizationId: OTHER });
    for (const r2 of reads.reads) assert.deepEqual(r2.filters.find(([c]) => c === 'organization_id'), ['organization_id', ORG]);
  });

  test('what an agent writes is stamped agent', async () => {
    for (const [tool, input, fn] of [
      ['social.draftContent', { platform: 'linkedin', objective: 'authority', format: 'text', title: 'A post title', body: 'Body of the post.' }, 'add_content_version'],
      ['ads.draftCampaign', { platform: 'meta_ads', name: 'Spring', plan: {}, dailyMinor: 1000 }, 'add_ad_version'],
      ['landing.draftPage', { name: 'Page', slug: 'page', content: {}, publicUrl: 'https://lp.example.com/page' }, 'add_landing_version'],
      ['marketplace.draftProposal', { opportunityId: U, body: 'We would build this with you.' }, 'add_b2b_proposal_version'],
    ] as const) {
      const f = fake({ add_ad_version: [{ outcome: 'added', version_id: U }], add_landing_version: [{ outcome: 'added', version_id: U }], add_b2b_proposal_version: [{ outcome: 'added', version_id: U }] });
      await runAcquisitionTool(f.admin, ORG, tool, input);
      assert.equal(f.calls.find((c) => c.fn === fn)?.args.p_by_type, 'agent', tool);
    }
    const f = fake({ qualify_prospect: [{ outcome: 'recorded', qualification_id: U, decision: 'needs_more_info', score: 40, disqualifiers: [], missing: [] }] });
    await runAcquisitionTool(f.admin, ORG, 'email.scoreProspect', { prospectId: U, reasoning: 'x', factors: { need_clarity: 60 } });
    assert.equal(f.calls[0]!.args.p_evaluated_by_type, 'agent');
  });

  test('an agent cannot set a price: the argument is not offered, and a supplied one is not passed on', async () => {
    assert.ok(!JSON.stringify(ACQUISITION_TOOL_SCHEMAS['marketplace.draftProposal']).match(/price/i));
    const f = fake({ add_b2b_proposal_version: [{ outcome: 'added', version_id: U }] });
    await runAcquisitionTool(f.admin, ORG, 'marketplace.draftProposal', { opportunityId: U, body: 'We would build this.', priceMinor: 9999900, p_price_minor: 9999900 });
    assert.equal(f.calls[0]!.args.p_price_minor, null);
  });

  test('a door that refuses is reported as a refusal, never as success', async () => {
    const f = fake({ add_ad_version: [{ outcome: 'apply_in_progress', version_id: null }] });
    const r = await runAcquisitionTool(f.admin, ORG, 'ads.draftCampaign', { platform: 'meta_ads', campaignId: U, name: 'Spring', plan: {}, dailyMinor: 1000 });
    assert.equal(r.ok, false);
  });

  test('a malformed call is refused before any door opens', async () => {
    for (const [tool, input] of [
      ['social.reviewContent', { versionId: 'not-a-uuid' }],
      ['ads.draftCampaign', { platform: 'tiktok', name: 'x', plan: {}, dailyMinor: 1 }],
      ['email.recordProspectFact', { prospectId: U, fact: 'x', sourceKind: 'manual', sourceUrl: 'https://x.example' }],
      ['marketplace.draftProposal', { opportunityId: U }],
      ['email.checkDraft', { prospectId: U, subject: 's', body: 'b', claims: [{ text: 't' }] }],
    ] as const) {
      const f = fake();
      const r = await runAcquisitionTool(f.admin, ORG, tool, input);
      assert.equal(r.ok, false, tool);
      assert.equal(f.calls.length, 0, `${tool} opened a door`);
    }
  });

  test('a manual or reply fact cannot be claimed by an agent as a source it did not read', async () => {
    const enumList = ((ACQUISITION_TOOL_SCHEMAS['email.recordProspectFact']!.properties as Record<string, { enum?: string[] }>).sourceKind!.enum) ?? [];
    assert.deepEqual(enumList.sort(), ['directory', 'linkedin', 'press', 'website']);
  });

  test('the results come from the agent door, which only the service role may open', async () => {
    const f = fake({ agent_results: [{ channel: 'email', leads: 3 }] });
    const r = await runAcquisitionTool(f.admin, ORG, 'acquisition.readResults', { days: 14 });
    assert.equal(r.ok, true);
    assert.equal(f.calls[0]!.fn, 'agent_results');
    assert.deepEqual([f.calls[0]!.args.p_organization_id, f.calls[0]!.args.p_days], [ORG, 14]);
  });

  test('no handler reaches a door that sends, publishes, launches, deploys, approves, pauses or prices', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/modules/acquisition/agent-tools.ts', import.meta.url), 'utf8');
    const doors = [...src.matchAll(/door\('([a-z_]+)'|const fn = [^;]*'([a-z_]+)'|'((?:check|submit|review|add|create|record)_[a-z_]+)'/g)].flatMap((m) => [m[1], m[2], m[3]]).filter(Boolean) as string[];
    assert.ok(doors.length >= 10);
    for (const d of doors) assert.doesNotMatch(d, /send|publish|launch|deploy|approve|decide|pause|resume|apply|spend|schedule|bind|execute/, `reaches ${d}`);
  });
});
