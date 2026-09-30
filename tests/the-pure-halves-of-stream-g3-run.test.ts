import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ilikeAny, ilikeOperand, ilikePattern, normaliseSearch } from '../src/lib/db/search.ts';
import { listToolDefinitions, toolDetailFor } from '../src/modules/agents/permissions-schema.ts';
import { AGENT_DEFINITIONS } from '../src/modules/agents/registry.ts';
import { TOOLS } from '../src/modules/agents/tools.ts';
import { linkRequirementSchema, REQUIREMENT_LINK_TARGET_LABEL, REQUIREMENT_LINK_TARGETS } from '../src/modules/crm/requirement-link-schema.ts';
import { requirementQuestionMessage, sendRequirementQuestionSchema } from '../src/modules/crm/requirement-question-schema.ts';
import { requirementConfirmationMessage, requirementPayloadSchema } from '../src/modules/crm/schema.ts';

/**
 * The pure halves of stream G-3, RUN rather than pinned — the companion of
 * `the-pure-halves-of-bucket-g-run.test.ts`.
 *
 * Search escaping, the requirement payload's nine sections, the per-question
 * and link doors' input schemas, the question as the client reads it, and
 * the tool registry's detail view: each is a function with no database, so
 * each is driven with inputs here and judged by what came out.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('A. search text becomes one PostgREST pattern, escaped the same way everywhere', () => {
  test('normalise trims, bounds and empties', () => {
    assert.equal(normaliseSearch('  hello  '), 'hello');
    assert.equal(normaliseSearch(undefined), '');
    assert.equal(normaliseSearch(null), '');
    assert.equal(normaliseSearch('   '), '');
    assert.equal(normaliseSearch('x'.repeat(200)).length, 120);
    assert.equal(normaliseSearch('x'.repeat(200), 10).length, 10);
    assert.equal(normaliseSearch('\tab\n'), 'ab');
  });

  test('the operand is quoted and wrapped in wildcards', () => {
    assert.equal(ilikeOperand('acme'), '"*acme*"');
    assert.equal(ilikeOperand(''), '"**"');
    assert.equal(ilikeOperand('two words'), '"*two words*"');
  });

  test('LIKE wildcards in the text are literal, not wildcards', () => {
    assert.equal(ilikeOperand('50%'), '"*50\\%*"');
    assert.equal(ilikeOperand('a_b'), '"*a\\_b*"');
    assert.equal(ilikeOperand('back\\slash'), '"*back\\\\slash*"');
    assert.equal(ilikeOperand('%_%'), '"*\\%\\_\\%*"');
  });

  test('a double quote inside the text cannot end the quoted operand', () => {
    assert.equal(ilikeOperand('say "hi"'), '"*say \\"hi\\"*"');
    assert.equal(ilikeOperand('"'), '"*\\"*"');
  });

  test('the characters PostgREST splits on survive because the operand is quoted', () => {
    const op = ilikeOperand('a,b.c(d)e');
    assert.equal(op, '"*a,b.c(d)e*"');
    assert.ok(op.startsWith('"') && op.endsWith('"'));
  });

  test('a star in the text is passed through — it is PostgREST\'s own wildcard, and the person asked for it', () => {
    assert.equal(ilikeOperand('a*b'), '"*a*b*"');
  });

  test('the bare pattern for the client\'s own ilike() escapes the same wildcards and adds no quotes', () => {
    assert.equal(ilikePattern('acme'), '*acme*');
    assert.equal(ilikePattern('50%'), '*50\\%*');
    assert.equal(ilikePattern('a_b'), '*a\\_b*');
    assert.equal(ilikePattern('back\\slash'), '*back\\\\slash*');
    assert.equal(ilikePattern('say "hi"'), '*say "hi"*');
    assert.equal(ilikePattern(''), '**');
  });

  test('one or= clause per column, in the order given', () => {
    assert.equal(ilikeAny(['name'], 'x'), 'name.ilike."*x*"');
    assert.equal(ilikeAny(['name', 'code'], 'x'), 'name.ilike."*x*",code.ilike."*x*"');
    assert.equal(ilikeAny(['leads.title', 'purpose'], 'q'), 'leads.title.ilike."*q*",purpose.ilike."*q*"');
    assert.equal(ilikeAny([], 'x'), '');
  });

  test('the same escaping is applied to every column of the clause', () => {
    const clause = ilikeAny(['a', 'b'], '10%');
    assert.equal(clause.split(',').length, 2);
    assert.ok(clause.split(',').every((part) => part.endsWith('.ilike."*10\\%*"')));
  });
});

describe('B. the requirement payload carries nine sections and still reads every older version', () => {
  const minimal = { summary: 'A loyalty app', scopeItems: [{ title: 'Wallet' }], constraints: ['Launch by March'], openQuestions: ['Which markets?'] };

  test('a version written before the new sections existed parses, with the new sections empty', () => {
    const out = requirementPayloadSchema.parse(minimal);
    assert.deepEqual(out.objectives, []);
    assert.deepEqual(out.businessRules, []);
    assert.deepEqual(out.nonFunctionalRequirements, []);
    assert.deepEqual(out.userRoles, []);
    assert.deepEqual(out.platforms, []);
    assert.deepEqual(out.integrations, []);
    assert.deepEqual(out.exclusions, []);
    assert.deepEqual(out.constraints, ['Launch by March']);
    assert.equal(out.timelineBudgetNotes, '');
  });

  test('the nine sections round-trip, trimmed', () => {
    const out = requirementPayloadSchema.parse({
      ...minimal,
      objectives: ['  Grow repeat visits ', 'Cut support calls'],
      userRoles: ['Shopper', 'Store manager'],
      platforms: ['iOS', 'Android'],
      integrations: ['Razorpay', 'Shopify'],
      businessRules: ['Points expire after 12 months'],
      nonFunctionalRequirements: ['Under 2s to open the wallet'],
      exclusions: ['No web app'],
    });
    assert.deepEqual(out.objectives, ['Grow repeat visits', 'Cut support calls']);
    assert.equal(out.userRoles.length, 2);
    assert.equal(out.platforms[1], 'Android');
    assert.equal(out.integrations[0], 'Razorpay');
    assert.deepEqual(out.businessRules, ['Points expire after 12 months']);
    assert.deepEqual(out.nonFunctionalRequirements, ['Under 2s to open the wallet']);
    assert.deepEqual(out.exclusions, ['No web app']);
    assert.equal(out.openQuestions[0], 'Which markets?');
  });

  test('an empty objective, a blank rule or an over-long item is refused, not silently dropped', () => {
    assert.equal(requirementPayloadSchema.safeParse({ ...minimal, objectives: [''] }).success, false);
    assert.equal(requirementPayloadSchema.safeParse({ ...minimal, businessRules: ['   '] }).success, false);
    assert.equal(requirementPayloadSchema.safeParse({ ...minimal, nonFunctionalRequirements: ['x'.repeat(501)] }).success, false);
    assert.equal(requirementPayloadSchema.safeParse({ ...minimal, objectives: Array.from({ length: 51 }, (_, i) => `o${i}`) }).success, false);
    assert.equal(requirementPayloadSchema.safeParse({ ...minimal, objectives: Array.from({ length: 50 }, (_, i) => `o${i}`) }).success, true);
  });

  test('the summary and the four original sections are still required', () => {
    assert.equal(requirementPayloadSchema.safeParse({ ...minimal, summary: '' }).success, false);
    assert.equal(requirementPayloadSchema.safeParse({ summary: 's', scopeItems: [], constraints: [], openQuestions: [] }).success, true);
    assert.equal(requirementPayloadSchema.safeParse({ summary: 's', scopeItems: [], constraints: [] }).success, false);
  });

  test('the confirmation message the client reads is unchanged by the new sections', () => {
    const before = requirementConfirmationMessage(minimal);
    const after = requirementConfirmationMessage({ ...requirementPayloadSchema.parse({ ...minimal, objectives: ['Grow'], businessRules: ['Rule'] }) });
    assert.equal(after, before);
    assert.match(before, /What we would build:\n• Wallet/);
    assert.match(before, /Still to confirm:\n• Which markets\?/);
    assert.doesNotMatch(before, /Grow|Rule/);
  });
});

describe('C. one question is asked alone, and it is the question the person read', () => {
  test('the input names the version, the index and the text', () => {
    const out = sendRequirementQuestionSchema.parse({ versionId: UUID, questionIndex: '3', question: '  Which markets?  ' });
    assert.equal(out.versionId, UUID);
    assert.equal(out.questionIndex, 3);
    assert.equal(out.question, 'Which markets?');
  });

  test('a negative, fractional or out-of-range index is refused, as is an empty question', () => {
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: UUID, questionIndex: -1, question: 'q' }).success, false);
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: UUID, questionIndex: 1.5, question: 'q' }).success, false);
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: UUID, questionIndex: 50, question: 'q' }).success, false);
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: UUID, questionIndex: 49, question: 'q' }).success, true);
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: UUID, questionIndex: 0, question: '   ' }).success, false);
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: 'not-a-uuid', questionIndex: 0, question: 'q' }).success, false);
    assert.equal(sendRequirementQuestionSchema.safeParse({ versionId: UUID, questionIndex: 0, question: 'x'.repeat(501) }).success, false);
  });

  test('the message is the question, framed, with nothing restated', () => {
    const msg = requirementQuestionMessage('  Which markets first?  ');
    const lines = msg.split('\n');
    assert.equal(lines[0], 'One question on the scope we discussed, so we can plan it right:');
    assert.equal(lines[1], '');
    assert.equal(lines[2], 'Which markets first?');
    assert.equal(lines[3], '');
    assert.equal(lines[4], 'Could you reply here with your answer?');
    assert.equal(lines.length, 5);
    assert.doesNotMatch(msg, /₹|\$|price|quote/i);
  });
});

describe('D. a requirement is linked to one target of one kind', () => {
  test('the three kinds, each with a label a person reads', () => {
    assert.deepEqual([...REQUIREMENT_LINK_TARGETS], ['quotation', 'design', 'task']);
    assert.equal(REQUIREMENT_LINK_TARGET_LABEL.quotation, 'Quotation');
    assert.equal(REQUIREMENT_LINK_TARGET_LABEL.design, 'Design');
    assert.equal(REQUIREMENT_LINK_TARGET_LABEL.task, 'Development task');
  });

  test('a link names a version, a kind and a target; the note is optional and bounded', () => {
    const out = linkRequirementSchema.parse({ versionId: UUID, targetType: 'task', targetId: OTHER, note: '  builds the wallet  ' });
    assert.equal(out.targetType, 'task');
    assert.equal(out.targetId, OTHER);
    assert.equal(out.note, 'builds the wallet');
    assert.equal(linkRequirementSchema.parse({ versionId: UUID, targetType: 'quotation', targetId: OTHER }).note, undefined);
    assert.equal(linkRequirementSchema.safeParse({ versionId: UUID, targetType: 'invoice', targetId: OTHER }).success, false);
    assert.equal(linkRequirementSchema.safeParse({ versionId: UUID, targetType: 'design', targetId: 'nope' }).success, false);
    assert.equal(linkRequirementSchema.safeParse({ versionId: UUID, targetType: 'design', targetId: OTHER, note: 'x'.repeat(501) }).success, false);
  });
});

describe('E. a tool has a detail view derived from the registry, never typed twice', () => {
  test('every registered tool has a detail, and an unknown name has none', () => {
    const all = listToolDefinitions();
    assert.equal(all.length, TOOLS.length);
    assert.deepEqual(all.map((t) => t.name), TOOLS.map((t) => t.name));
    assert.equal(toolDetailFor('no.suchTool'), null);
    assert.equal(toolDetailFor(''), null);
  });

  test('a detail carries the registry\'s own purpose and class, and the agents bound by definition', () => {
    const recall = toolDetailFor('memory.recall');
    assert.ok(recall);
    const registered = TOOLS.find((t) => t.name === 'memory.recall');
    assert.equal(recall.purpose, registered?.purpose);
    assert.equal(recall.actionClass, registered?.actionClass);
    assert.equal(recall.clientFacing, registered?.clientFacing);
    const boundByDefinition = AGENT_DEFINITIONS.filter((a) => a.tools.includes('memory.recall')).map((a) => a.key);
    assert.deepEqual(recall.boundAgents.map((a) => a.key), boundByDefinition);
    assert.ok(recall.boundAgents.every((a) => typeof a.displayName === 'string' && a.displayName.length > 0));
  });

  test('a client-facing tool says so, and a read tool is not a write', () => {
    const send = toolDetailFor('crm.sendClientMessage');
    const read = toolDetailFor('crm.readLead');
    assert.ok(send && read);
    assert.equal(send.clientFacing, true);
    assert.equal(read.clientFacing, false);
    assert.notEqual(send.actionClass, read.actionClass);
  });

  test('the bound-agent list is consistent both ways with the agent definitions', () => {
    for (const tool of listToolDefinitions()) {
      for (const bound of tool.boundAgents) {
        const def = AGENT_DEFINITIONS.find((a) => a.key === bound.key);
        assert.ok(def, `${bound.key} is bound to ${tool.name} but is not a defined agent`);
        assert.ok(def.tools.includes(tool.name), `${bound.key} does not list ${tool.name}`);
      }
    }
    for (const def of AGENT_DEFINITIONS) {
      for (const name of def.tools) {
        const detail = toolDetailFor(name);
        assert.ok(detail, `${def.key} binds ${name}, which has no detail`);
        assert.ok(detail.boundAgents.some((a) => a.key === def.key), `${name} does not list ${def.key}`);
      }
    }
  });
});
