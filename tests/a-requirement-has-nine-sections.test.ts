import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { requirementPayloadSchema } from '../src/modules/crm/schema.ts';
import { linkRequirementSchema, REQUIREMENT_LINK_TARGETS } from '../src/modules/crm/requirement-link-schema.ts';
import { requirementQuestionMessage, sendRequirementQuestionSchema } from '../src/modules/crm/requirement-question-schema.ts';

import { codeOnly, sqlCode } from './_code-only.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket G, stream G-3 — SCR-029 Requirement Set / Detail.
 *
 *   1. The payload carries the PDF's nine sections; every historical payload
 *      still parses, and `constraints` is kept for the versions that recorded
 *      rules there.
 *   2. The panel draws the nine sections as sections, each with its count,
 *      an empty one saying "none recorded in v<n>".
 *   3. "Request client clarification" is per question, through the same
 *      outbound chokepoint, recorded and audited; the payload is never
 *      rewritten.
 *   4. "Link to quotation/design/development task" is a governed door with
 *      one row per (version, target), audited; "Cited by" stays derived.
 *   5. The migration keeps the tenancy conventions and coalesces its guards.
 */

const MIGRATION = readdirSync(join(process.cwd(), 'supabase/migrations')).find((f) => f.startsWith('20261001180000_'));
const migration = MIGRATION ? read(`supabase/migrations/${MIGRATION}`) : '';
const PANEL = 'app/(internal)/leads/[leadId]/requirement-set-panel.tsx';

describe('1. the payload has nine sections and forgets nothing', () => {
  test('an old payload with constraints alone still parses, the new sections default empty', () => {
    const parsed = requirementPayloadSchema.safeParse({ summary: 'A shop', scopeItems: [{ title: 'Catalogue' }], constraints: ['GST invoices'], openQuestions: ['Which courier?'] });
    assert.ok(parsed.success);
    assert.deepEqual(parsed.data.objectives, []);
    assert.deepEqual(parsed.data.businessRules, []);
    assert.deepEqual(parsed.data.nonFunctionalRequirements, []);
    assert.deepEqual(parsed.data.constraints, ['GST invoices']);
  });

  test('a new payload carries objectives, business rules and non-functional requirements', () => {
    const parsed = requirementPayloadSchema.safeParse({
      summary: 'A shop',
      scopeItems: [],
      constraints: [],
      openQuestions: [],
      objectives: ['Sell online in three cities'],
      businessRules: ['No COD above ₹5,000'],
      nonFunctionalRequirements: ['Pages under two seconds on 4G'],
    });
    assert.ok(parsed.success);
    assert.equal(parsed.data.objectives.length, 1);
    assert.equal(parsed.data.businessRules.length, 1);
    assert.equal(parsed.data.nonFunctionalRequirements.length, 1);
  });

  test('the revise form and action carry the three new sections, and the collector is told they are optional', () => {
    const form = read('app/(internal)/leads/[leadId]/requirement-revise-form.tsx');
    const action = codeOnly(read('src/modules/crm/requirement-revise-actions.ts'));
    for (const key of ['objectives', 'businessRules', 'nonFunctionalRequirements']) {
      assert.match(form, new RegExp(`id="rev-${key}"`), `the form has no textarea for ${key}`);
      assert.match(action, new RegExp(`${key}: linesOf\\(text\\('${key}'\\)\\)`), `the action does not read ${key}`);
    }
    const prompt = read('app/api/jobs/run/workflows.ts');
    assert.match(prompt, /objectives are the outcomes the client said they want/);
    assert.match(prompt, /Leave any of these empty when the transcript does not say/);
  });
});

describe('2. the panel draws the nine sections', () => {
  const panel = read(PANEL);

  for (const title of ['Objectives', 'User roles', 'Features', 'Platforms', 'Integrations', 'Business rules', 'Non-functional requirements', 'Excluded items', 'Questions']) {
    test(`"${title}" is a section`, () => {
      assert.match(panel, new RegExp(`<Section title="${title}"`), `${title} is not drawn as a section`);
    });
  }

  test('every section shows its count and an empty one says "none recorded in v<n>"', () => {
    assert.match(panel, /\(\{items\.length\}\)/);
    assert.match(panel, /none recorded in v\{version\}/);
  });

  test('constraints from an older version are shown under Business rules with a note', () => {
    assert.match(panel, /const businessRules = \[\.\.\.payload\.businessRules, \.\.\.payload\.constraints\]/);
    assert.match(panel, /recorded as constraints in v\$\{version\}/);
  });

  test('"Cited by" stays as the derived, read-only list beside "Linked to"', () => {
    assert.match(panel, /Cited by<span[^>]*>— derived, read-only<\/span>/);
    assert.match(panel, /Linked to<span/);
  });
});

describe('3. a question is asked alone, through the chokepoint', () => {
  test('the door takes the version, the index and the question, and refuses a mismatch', () => {
    const code = sqlCode(migration);
    assert.match(code, /create or replace function crm\.send_requirement_question\(\s*p_version_id\s+uuid,\s*p_question_index int,\s*p_question\s+text,\s*p_body\s+text\s*\)/);
    assert.match(code, /v_stored := v_row\.payload -> 'openQuestions' ->> p_question_index;/);
    assert.match(code, /'question_mismatch'/);
    assert.match(code, /from crm\.send_outbound_message\(\s*v_row\.conversation_id,\s*p_body,\s*'requirement:' \|\| p_version_id::text \|\| ':q' \|\| p_question_index::text,\s*v_actor\s*\)/);
    assert.match(code, /'requirement\.question_sent'/);
    assert.match(code, /insert into crm\.requirement_question_sends/);
    assert.doesNotMatch(code, /update crm\.requirement_versions\s+set payload/, 'the payload is never rewritten');
  });

  test('the sent question is recorded once per (version, index)', () => {
    const code = sqlCode(migration);
    assert.match(code, /constraint requirement_question_sends_once unique \(requirement_version_id, question_index\)/);
  });

  test('the schema and the message are pure and plain', () => {
    assert.ok(sendRequirementQuestionSchema.safeParse({ versionId: '9d8f6d9e-1d7f-4c8a-8e1b-2a1c3d4e5f60', questionIndex: '2', question: 'Which courier?' }).success);
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: 'nope', questionIndex: 0, question: 'x' }).success, false);
    const body = requirementQuestionMessage('Which courier do you use?');
    assert.match(body, /Which courier do you use\?/);
    assert.match(body, /Could you reply here/);
  });

  test('the service goes through the door and the panel offers one button per open question', () => {
    const service = codeOnly(read('src/modules/crm/requirement-question-service.ts'));
    assert.match(service, /can\(context, 'lead\.write'\)/);
    assert.match(service, /\.rpc\('send_requirement_question'/);
    assert.match(service, /p_body: requirementQuestionMessage\(parsed\.data\.question\)/);
    const panel = read(PANEL);
    assert.match(panel, /payload\.openQuestions\.map\(\(q, i\) =>/);
    assert.match(panel, /<RequirementQuestionSendForm versionId=\{versionId\} leadId=\{leadId\} questionIndex=\{i\} question=\{q\} \/>/);
    assert.match(panel, /sent to client/);
  });
});

describe('4. a link is declared, once per target, and audited', () => {
  test('the door writes crm.requirement_links with one FK per target type and a unique triple', () => {
    const code = sqlCode(migration);
    assert.match(code, /create table if not exists crm\.requirement_links/);
    assert.match(code, /target_type\s+text not null check \(target_type in \('quotation', 'design', 'task'\)\)/);
    assert.match(code, /quotation_id\s+uuid references sales\.proposals\(id\)/);
    assert.match(code, /deliverable_id\s+uuid references projects\.deliverables\(id\)/);
    assert.match(code, /task_id\s+uuid references projects\.tasks\(id\)/);
    assert.match(code, /constraint requirement_links_unique_per_triple unique \(requirement_version_id, target_type, target_id\)/);
    assert.match(code, /create or replace function crm\.link_requirement\(/);
    assert.match(code, /'requirement\.linked'/);
    assert.match(code, /'already_linked'/);
    assert.match(code, /d\.kind in \('design', 'prototype'\)/);
  });

  test('the schema names the three targets and the service reaches the door', () => {
    assert.deepEqual([...REQUIREMENT_LINK_TARGETS], ['quotation', 'design', 'task']);
    assert.equal(linkRequirementSchema.safeParse({ versionId: '9d8f6d9e-1d7f-4c8a-8e1b-2a1c3d4e5f60', targetType: 'invoice', targetId: '9d8f6d9e-1d7f-4c8a-8e1b-2a1c3d4e5f61' }).success, false);
    const service = codeOnly(read('src/modules/crm/requirement-link-service.ts'));
    assert.match(service, /can\(context, 'lead\.write'\)/);
    assert.match(service, /\.rpc\('link_requirement'/);
    const panel = read(PANEL);
    assert.match(panel, /<RequirementLinkForm versionId=\{versionId\} leadId=\{leadId\} targets=\{targets\} \/>/);
  });

  test('the lead page reads the sends, the links and the targets and hands them to the panel', () => {
    const page = read('app/(internal)/leads/[leadId]/page.tsx');
    assert.match(page, /readRequirementQuestionSends\(versionIds\)/);
    assert.match(page, /readRequirementLinks\(versionIds\)/);
    assert.match(page, /readRequirementLinkTargets\(\{ opportunityId: opportunity\?\.id \?\? null/);
    assert.match(page, /questionSends=\{questionSends\.get\(v\.id\) \?\? new Map\(\)\}/);
    assert.match(page, /links=\{requirementLinks\.get\(v\.id\) \?\? \[\]\}/);
  });
});

describe('5. the migration keeps the conventions', () => {
  test('both tables are org-scoped, RLS enabled and forced, with tenancy triggers on every FK', () => {
    assert.ok(MIGRATION, 'the migration is missing');
    const code = sqlCode(migration);
    for (const table of ['requirement_question_sends', 'requirement_links']) {
      assert.match(code, new RegExp(`alter table crm\\.${table} enable row level security;`));
      assert.match(code, new RegExp(`alter table crm\\.${table} force row level security;`));
      assert.match(code, new RegExp(`create trigger freeze_org_${table}`));
      assert.match(code, new RegExp(`create policy ${table}_select on crm\\.${table}\\s+for select to authenticated\\s+using \\(organization_id = \\(select core\\.current_organization_id\\(\\)\\) and \\(select core\\.is_internal\\(\\)\\)\\);`));
      assert.match(code, new RegExp(`create policy ${table}_insert_by_admin on crm\\.${table}`));
    }
    for (const fk of ['requirement_version_id', 'conversation_id', 'message_id']) {
      assert.match(code, new RegExp(`core\\.enforce_parent_org\\('${fk}', 'crm\\.`), `requirement_question_sends.${fk} has no tenancy trigger`);
    }
    for (const [fk, parent] of [['quotation_id', 'sales.proposals'], ['deliverable_id', 'projects.deliverables'], ['task_id', 'projects.tasks']]) {
      assert.match(code, new RegExp(`core\\.enforce_parent_org\\('${fk}', '${parent}'\\)`), `requirement_links.${fk} has no tenancy trigger`);
    }
  });

  test('every admin guard is coalesced, so a null predicate cannot open a door', () => {
    const code = sqlCode(migration);
    assert.doesNotMatch(code, /not\s+\(\s*select\s+core\.(?:is_admin|is_owner|can_write|is_internal)\s*\(/);
    assert.equal((code.match(/not coalesce\(\(select core\.is_admin\(\)\), false\)/g) ?? []).length, 2);
  });

  test('the types file knows the two tables and the two doors', () => {
    const types = read('src/lib/db/types.ts');
    assert.match(types, /^ {6}requirement_links: \{$/m);
    assert.match(types, /^ {6}requirement_question_sends: \{$/m);
    assert.match(types, /^ {6}link_requirement: \{$/m);
    assert.match(types, /^ {6}send_requirement_question: \{$/m);
  });
});
