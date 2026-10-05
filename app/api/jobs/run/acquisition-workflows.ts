import { z } from 'zod';

import type { Json } from '@/lib/db/types';
import { dispatchToolUnderPolicy } from '@/modules/agents/policy-enforcement';
import { dispatchableToolsFor } from '@/modules/agents/tool-dispatch';
import { toolsFor } from '@/modules/agents/tools';

import { callModelWithTools, failJob, finishRun, openRun, settledSucceeded, succeedRun } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * The acquisition agents' work (ADM-112, ADM-113): one workflow per agent, started by a person ("Ask the agent" on the channel page)
 * with a task in their own words.
 *
 * What makes this safe is not the prompt. The agent holds draft / score / check / submit-for-approval tools and nothing that sends,
 * publishes, launches, deploys, prices or approves, so a model that ignored every instruction below could still only leave drafts and
 * ask a person to decide. The prompt is for quality; the tool set is for safety. Every call goes through the tenant's own tool
 * permissions (`dispatchToolUnderPolicy`) and the organisation is the job's, never the model's.
 *
 * The run stops before it starts when the owner's stop for the channel is on: a draft is not a side effect, but an agent that keeps
 * working through an emergency pause is not one anybody would call paused.
 */

// A long report is a verbose model, not a failed run: the work is already done by the time the report is read, and failing the job here would
// retry it and do the work twice. So the text is bounded by truncation, not refused.
const REPORT = z.object({
  summary: z.string().min(1).transform((s) => s.slice(0, 4000)),
  actions: z.array(z.string().transform((a) => a.slice(0, 600))).max(60),
});

function reportJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What you did and what a person must decide next, in plain words. Under 1,500 characters.' },
      actions: { type: 'array', items: { type: 'string' }, description: 'One line per tool call that CHANGED something, naming the id it returned. Leave empty if you changed nothing.' },
    },
    required: ['summary', 'actions'],
    additionalProperties: false,
  };
}

const RULES = [
  'You work ONLY through the tools you are given. If a tool refused something, say so plainly; do not work around it and do not claim it was done.',
  'Everything you create is a DRAFT. You cannot send, publish, launch, deploy, price, approve or pause anything, and you must never say or imply that you did.',
  'Submitting asks a person to approve that exact version; it is not approval. Submit only a version whose check passed, and say what is waiting for them.',
  'Never state a price, a discount or a guarantee. Never invent a portfolio item, a result, a number or a fact: use only what the tools returned or what the person wrote in the task.',
  'If the task cannot be done with what the tools show, return a summary that says what is missing. An honest "nothing to do" is a real answer.',
  'Read the existing queue or list first. If it already holds your own draft for this same task, report that one instead of drafting another: a retried job must not leave duplicates.',
  'Finish with the report: a short summary, and one line per change you made, each with the id the tool returned.',
].join(' ');

const PROMPTS = {
  ad_manager: [
    'You are the Ad Manager for a software agency (website and app development). You handle Meta/Facebook Ads and Google Ads, keeping each platform\'s strategy separate.',
    'Read the results first and judge channels by qualified leads and won deals, not clicks. Draft campaign versions from the active target service and the ICP (copy, audience, placements or keywords, exclusions, budget).',
    'For Google, the destination is a landing page: draft the page too, with the agency WhatsApp number it will link to. Run the checks, fix what they report, and submit only what passes.',
    'A launch, a budget increase and a targeting change always need a person; you only prepare the exact version they will approve.',
    'If an existing draft of yours FAILED its check, do not stop and ask: draft a corrected new version of that same campaign or page (pass its id) using what the check named, and check it again.',
    RULES,
  ].join(' '),
  email_outreach: [
    'You are the Email Outreach agent for a software agency. You research and qualify prospects against the ICP and prepare outreach.',
    'Record only facts you can source from a public page and cite its address. Score a prospect with the factors you can support and leave the others out. Draft outreach whose every personal claim rests on a recorded fact, and run the draft check before anything else.',
    'You cannot send. A campaign sends through its own governed path after a person approves it. A request for a meeting or a quotation is made through the shared subtasks, and a move to WhatsApp through a tracked handoff to Sales; you only recommend those.',
    RULES,
  ].join(' '),
  social_media: [
    'You are the Social Media agent for a software agency (LinkedIn, Instagram, Facebook). The goal is organic qualified clients, not vanity followers.',
    'Read the content queue and results, then draft posts, each with one objective (authority, reach, engagement, education, portfolio proof or lead generation) and a format. Run the review and fix what it reports; submit only a version that passed.',
    'Any material change after approval is a new version that needs approval again. You cannot publish.',
    RULES,
  ].join(' '),
  marketplace_opportunity: [
    'You are the B2B Opportunity agent for a software agency (Upwork, Freelancer, PeoplePerHour, Guru, Contra, Fiverr; Clutch and GoodFirms profile work).',
    'Record an opportunity only from the text the person gave you in the task. Let the Admin thresholds score it and respect the result: low fit stays low fit. For a shortlisted one, draft a tailored proposal from the real opportunity and approved agency evidence.',
    'A proposal you draft has NO price: a person prices it. You cannot submit it to a marketplace or contact anyone off the platform. Run the proposal check, fix what it reports, and submit only what passes.',
    RULES,
  ].join(' '),
} as const;

const CHANNELS = {
  ad_manager: ['meta_ads', 'google_ads'],
  email_outreach: ['email'],
  social_media: ['social'],
  marketplace_opportunity: ['b2b'],
} as const;

type AgentKey = keyof typeof PROMPTS;

function workflow(jobKind: string, agentKey: AgentKey): AgentWorkflow {
  const wf: AgentWorkflow = {
    jobKind,
    agentKey,
    // ADM-61 §2 "draft anything at all": every product is a draft a person approves.
    workClass: 'draft',
    systemPrompt: PROMPTS[agentKey],
    schemaName: 'AcquisitionReport',
    jsonSchema: reportJsonSchema,

    async run(ctx) {
      const { admin, job } = ctx;
      const task = typeof job.payload?.task === 'string' ? job.payload.task.trim() : '';
      if (task.length < 5 || task.length > 3000) {
        await failJob(admin, job, 'the task must be 5 to 3,000 characters');
        return { status: 'failed', reason: 'bad payload' };
      }

      // The owner's stops, asked BEFORE the model is. Fails closed: an unreadable answer is a stop.
      const stops: string[] = [];
      for (const channel of CHANNELS[agentKey]) {
        const { data, error } = await admin.schema('crm').rpc('acquisition_blocked', { p_organization_id: job.organization_id, p_channel: channel });
        if (error) {
          await failJob(admin, job, 'could not read the stops');
          return { status: 'failed', reason: 'stops unreadable' };
        }
        if (data) stops.push(`${channel}: ${String(data)}`);
      }
      if (stops.length === CHANNELS[agentKey].length) {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return { status: 'succeeded', reason: `stopped (${stops.join(', ')})` };
      }

      const [services, icp] = await Promise.all([
        admin.schema('crm').from('target_services').select('name, description, priority').eq('organization_id', job.organization_id).eq('active', true).order('priority').limit(10),
        admin.schema('crm').from('icp_versions').select('version, definition').eq('organization_id', job.organization_id).order('version', { ascending: false }).limit(1),
      ]);
      if (services.error || icp.error) {
        await failJob(admin, job, 'could not read the services and ICP');
        return { status: 'failed', reason: 'context unreadable' };
      }

      const runId = await openRun(ctx, { type: 'crm.acquisition', id: job.id, input: { task, agent: agentKey } as unknown as Json });
      const tools = dispatchableToolsFor(toolsFor(ctx.agent.key));

      const call = await callModelWithTools(
        ctx,
        // read, draft, review, submit and then answer is five turns at the least; ten leaves room for one fix-and-recheck
        { ...wf, maxToolRounds: 10 },
        [{
          role: 'user',
          content: [
            `Task from a person:\n${task}`,
            `Active target services (the agency's own list):\n${JSON.stringify(services.data ?? [])}`,
            `Current ICP:\n${JSON.stringify(icp.data?.[0] ?? null)}`,
            stops.length > 0 ? `Stopped for you right now (do not work on these): ${stops.join('; ')}` : 'No stop is on for your channels.',
          ].join('\n\n'),
        }],
        tools,
        runId,
        (toolCall) =>
          dispatchToolUnderPolicy({
            admin,
            organizationId: job.organization_id,
            agentKey: ctx.agent.key,
            agentAutonomy: ctx.agent.autonomy_level as 'L0' | 'L1' | 'L2',
            toolName: toolCall.name,
            input: toolCall.input,
            runId,
          }),
      );

      if (!call.ok) {
        await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
        await failJob(admin, job, call.detail);
        return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
      }

      const report = REPORT.safeParse(call.json);
      if (!report.success) {
        const detail = 'model output failed schema validation';
        await finishRun(admin, runId, 'failed', detail, call.stepCount);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: detail, runId };
      }

      await succeedRun(admin, runId, { task, ...report.data } as unknown as Json, call.usage, call.stepCount);
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'reported', runId };
    },
  };
  return wf;
}

export const ACQUISITION_WORKFLOWS: readonly AgentWorkflow[] = [
  workflow('ads.assist', 'ad_manager'),
  workflow('email.assist', 'email_outreach'),
  workflow('social.assist', 'social_media'),
  workflow('marketplace.assist', 'marketplace_opportunity'),
];
