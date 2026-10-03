import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { LEAD_TRANSITIONS, requirementPayloadSchema } from '../src/modules/crm/schema.ts';
import { overrideLeadScoreSchema } from '../src/modules/crm/lead-score-override-schema.ts';
import { decideFollowUpSequenceSchema } from '../src/modules/crm/follow-up-decision-schema.ts';
import { sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * A score has two authors — bucket F-B, SCR-008.
 *
 * ADM-88 (reversed 2026-09-29) made the score a computed number that never
 * travels without its reasons. The PDF asks for the other half: a person's
 * decision beside it. The rule this file pins is that the two NEVER merge —
 * the override is four columns that travel together or not at all, the one
 * door that writes them refuses a lead with no computed score, and the page
 * draws both numbers side by side. `no-invented-lead-score.test.ts` keeps
 * guarding the computed half; nothing here weakens it.
 */

const MIGRATION = read('supabase/migrations/20261001110000_a_lead_is_scored_by_two_and_a_client_is_edited.sql');
const CODE = sqlCode(MIGRATION);

describe('A. the override is beside the score, never in its place', () => {
  test('four columns are ADDED; the computed columns are not touched', () => {
    for (const col of ['score_override        int', 'score_override_reason text', 'score_override_by     uuid', 'score_override_at     timestamptz']) {
      assert.match(MIGRATION, new RegExp(`add column if not exists ${col.replace(/\\s+/g, '\\\\s+')}`));
    }
    assert.doesNotMatch(CODE, /drop column/i);
    assert.doesNotMatch(CODE, /leads_score_carries_its_reasons/, 'the computed-score constraint is not redefined here');
  });

  test('the constraint: all four null, or all four present with a non-empty reason', () => {
    const constraint = /add constraint leads_override_carries_its_reason\s+check \(([\s\S]*?)\);/.exec(CODE);
    assert.ok(constraint, 'the constraint is missing');
    const body = constraint![1]!;
    assert.match(body, /score_override is null and score_override_reason is null and score_override_by is null and score_override_at is null/);
    assert.match(body, /score_override between 0 and 100/);
    assert.match(body, /length\(btrim\(score_override_reason\)\) between 1 and 500/);
    assert.match(body, /score_override_by is not null/);
    assert.match(body, /score_override_at is not null/);
  });
});

describe('B. one door, owner/ops_admin, with a reason, refusing an unscored lead', () => {
  const body = region(MIGRATION, 'create or replace function crm.override_lead_score');

  test('it is security invoker and checks core.is_admin()', () => {
    assert.match(body, /security invoker/);
    assert.match(body, /core\.is_admin\(\)/);
  });

  test('a reason is required to set AND to clear; the computed score must exist', () => {
    assert.match(body, /if v_reason is null or length\(v_reason\) > 500 then/);
    assert.match(body, /return query select 'no_reason'::text/);
    assert.match(body, /if \(v_before ->> 'score'\) is null then/);
    assert.match(body, /return query select 'not_scored'::text/);
  });

  test('it never writes the computed columns', () => {
    const update = region(body, 'update crm.leads', 'where id = p_lead_id');
    assert.doesNotMatch(update, /\bscore\s*=/);
    assert.doesNotMatch(update, /score_reasons|score_inputs|scored_at/);
  });

  test('both outcomes are audited by name', () => {
    assert.match(body, /perform core\.record_audit\(v_org, 'lead\.score_override_cleared', 'lead', p_lead_id/);
    assert.match(body, /perform core\.record_audit\(v_org, 'lead\.score_overridden', 'lead', p_lead_id/);
  });

  test('the service goes through the door with lead.assign, and nothing writes the override columns directly', () => {
    const service = read('src/modules/crm/lead-score-override-service.ts');
    assert.match(service, /can\(context, 'lead\.assign'\)/);
    assert.match(service, /rpc\('override_lead_score'/);
    for (const file of ['src/modules/crm/lead-score-override-service.ts', 'src/modules/crm/lead-score-override-actions.ts', 'src/modules/crm/lead-score-override-queries.ts']) {
      assert.doesNotMatch(read(file), /\.(update|insert|upsert)\(/, `${file} writes without the door`);
    }
  });

  test('the schema refuses a bare override and an empty reason', () => {
    assert.equal(overrideLeadScoreSchema.safeParse({ leadId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', score: 50, reason: '' }).success, false);
    assert.equal(overrideLeadScoreSchema.safeParse({ leadId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', score: 101, reason: 'x' }).success, false);
    assert.equal(overrideLeadScoreSchema.safeParse({ leadId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', score: null, reason: 'the model cannot see the call' }).success, true);
  });
});

describe('C. no screen shows the number any more (owner decision 1, round 2): a Hot / Warm / Cold label takes its place', () => {
  test('Lead 360, the qualification screen, the list and the preview draw a label with its reasons and never the stored score', () => {
    const page = read('app/(internal)/leads/[leadId]/page.tsx');
    assert.match(page, /LeadHeatBadge/);
    assert.match(page, /heatReading\.reasons\.map\(/);
    for (const file of [
      'app/(internal)/leads/[leadId]/page.tsx',
      'app/(internal)/leads/[leadId]/qualification/page.tsx',
      'app/(internal)/leads/page.tsx',
      'app/(internal)/leads/bulk-table.tsx',
      'app/(internal)/leads/preview-actions.ts',
      'app/(internal)/leads/preview-drawer.tsx',
    ]) {
      const code = read(file);
      assert.doesNotMatch(code, /readLeadScore|readLeadScores|readLeadScoreOverride|RescoreLeadForm|OverrideScoreForm|RescoreAllLeadsButton|\/100</, `${file} still reads or draws the score`);
    }
  });
});

describe('D. the other rules this migration holds for Sales & CRM', () => {
  test('qualified → qualifying, in the guard AND the TypeScript map, together', () => {
    assert.ok(LEAD_TRANSITIONS.qualified.includes('qualifying'));
    assert.match(CODE, /when 'qualified' {4}then array\['qualifying', 'converted', 'nurture', 'disqualified'\]/);
    assert.match(CODE, /when 'converted' {4}then array\[\]::text\[\]/, 'converted stays terminal');
  });

  test('the requirement payload carries the four SCR-009 fields, defaulting empty so history still parses', () => {
    const parsed = requirementPayloadSchema.safeParse({ summary: 'A shop.', scopeItems: [], constraints: [], openQuestions: [] });
    assert.ok(parsed.success);
    assert.deepEqual(parsed.data.userRoles, []);
    assert.deepEqual(parsed.data.platforms, []);
    assert.deepEqual(parsed.data.integrations, []);
    assert.equal(parsed.data.timelineBudgetNotes, '');
    const panel = read('app/(internal)/leads/[leadId]/requirement-set-panel.tsx');
    for (const key of ['payload.userRoles', 'payload.platforms', 'payload.integrations', 'payload.timelineBudgetNotes']) assert.match(panel, new RegExp(key.replace('.', '\\.')));
  });

  test('a follow-up is rescheduled, completed or cancelled with a reason, through one audited door', () => {
    const door = region(MIGRATION, 'create or replace function crm.decide_follow_up_sequence');
    assert.match(door, /security invoker/);
    assert.match(door, /if v_reason is null or length\(v_reason\) > 500 then/);
    assert.match(door, /if p_action = 'reschedule' and p_next_due_at is null then/);
    assert.match(door, /'follow_up\.rescheduled'/);
    assert.match(door, /'follow_up\.completed'/);
    assert.match(door, /'follow_up\.cancelled'/);
    assert.match(CODE, /check \(status in \('active', 'stopped', 'exhausted', 'escalated', 'completed', 'cancelled'\)\)/);
    assert.equal(decideFollowUpSequenceSchema.safeParse({ sequenceId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', action: 'reschedule', reason: 'client asked' }).success, false, 'a reschedule without a time');
    assert.equal(decideFollowUpSequenceSchema.safeParse({ sequenceId: '0f7c6a4c-3a2c-4a5d-9d5e-6c5f3b3f7d1a', action: 'cancel', reason: '' }).success, false, 'a cancel without a reason');
  });

  test('a renewal or upsell is a new deal of a stated kind from a COMPLETED project, and one open deal per lead still holds', () => {
    assert.match(CODE, /check \(kind in \('new', 'renewal', 'upsell'\)\)/);
    assert.match(CODE, /check \(kind = 'new' or source_project_id is not null\)/);
    const door = region(MIGRATION, 'create or replace function sales.open_renewal');
    assert.match(door, /if v_project\.status <> 'completed' then/);
    assert.match(door, /return query select 'lead_busy'::text/);
    assert.match(door, /'opportunity\.renewal_opened'/);
    assert.match(CODE, /org_match_opportunities_source_project/);
  });

  test('a meeting may name its project, tenancy-guarded like every other FK', () => {
    assert.match(CODE, /alter table crm\.meetings\s+add column if not exists project_id uuid references projects\.projects\(id\) on delete set null/);
    assert.match(CODE, /create trigger org_match_meetings_project/);
  });

  test('delivery status is derived from the outbound message, not stored', () => {
    assert.doesNotMatch(CODE, /delivery_status/);
    const reader = read('src/modules/sales/delivery-status-queries.ts');
    assert.match(reader, /from\('conversation_messages'\)/);
    assert.match(reader, /sent_message_ref/);
  });
});
