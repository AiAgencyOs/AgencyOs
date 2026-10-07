import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AGENT_CATEGORIES,
  AGENT_PROFILES,
  QA_SPECIALIST_AGENTS,
  checkQaFindings,
  doorArgsFor,
  qaFindingsSchema,
  renderQaFacts,
  type ProposedFinding,
  type QaFacts,
  type QaSpecialistAgent,
} from '../src/modules/projects/qa-specialist-findings.ts';
import { definitionFor } from '../src/modules/agents/registry.ts';

/**
 * The nine QA specialists' profiles, proved with a STAND-IN: pure schemas and rules, no model, browser, device, load tool or scanner. A proposal is
 * never a result; these tests are about what is REFUSED before it reaches the database door, and what each agent may propose at all.
 */

const CASE = '00000000-0000-4000-8000-0000000000c1';
const CRIT = '00000000-0000-4000-8000-0000000000c2';
const secret = () => `api_key=${'x'.repeat(20)}`;

const baseFacts = (agent: QaSpecialistAgent, over: Partial<QaFacts> = {}): QaFacts => ({
  agent,
  category: AGENT_CATEGORIES[agent][0]!,
  commit: 'abc1234',
  jobStatus: 'routed',
  environments: ['staging'],
  cases: [
    { id: CASE, title: 'cart total', criterion: 'the total is right', priority: 'medium', status: 'planned', journey: null, steps: null, expected: null },
    { id: CRIT, title: 'critical pay', criterion: 'a receipt is shown', priority: 'critical', status: 'planned', journey: null, steps: null, expected: null },
  ],
  evidence: [{ ref: 'run:r1', detail: 'functional: 8 passed, 0 failed' }],
  budgets: [],
  devices: [],
  integrations: [],
  escaped: [],
  gates: [],
  readiness: null,
  ...over,
});
const proposal = (over: Partial<ProposedFinding> = {}): ProposedFinding => ({
  kind: 'case_result', caseId: CASE, result: 'pass', reason: 'the total matches the cart', detail: null, evidenceRefs: ['run:r1'], environment: null, ...over,
});
const answer = (...findings: ProposedFinding[]) => qaFindingsSchema.parse({ findings });
const refused = (agent: QaSpecialistAgent, facts: QaFacts, ...findings: ProposedFinding[]) => {
  const r = checkQaFindings(agent, answer(...findings), facts);
  assert.equal(r.ok, false, 'expected a refusal');
  return r.ok ? '' : r.reason;
};
const accepted = (agent: QaSpecialistAgent, facts: QaFacts, ...findings: ProposedFinding[]) => {
  const r = checkQaFindings(agent, answer(...findings), facts);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
};

describe('the nine are the nine the registry installs, each with one profile', () => {
  test('keys, layer and categories line up', () => {
    assert.equal(QA_SPECIALIST_AGENTS.length, 9);
    for (const a of QA_SPECIALIST_AGENTS) {
      assert.match(a, /^[a-z_]+$/);
      assert.equal(definitionFor(a)?.layer, 'qa');
      assert.equal(AGENT_PROFILES[a].agent, a);
      assert.ok(AGENT_CATEGORIES[a].length >= 1);
    }
  });
  test('only release_readiness may propose a summary or an exception request; nobody else may', () => {
    for (const a of QA_SPECIALIST_AGENTS) {
      const kinds = AGENT_PROFILES[a].kinds;
      assert.equal(kinds.includes('gate_summary'), a === 'release_readiness');
      assert.equal(kinds.includes('exception_request'), a === 'release_readiness');
      assert.equal(kinds.includes('case_result'), a !== 'release_readiness');
    }
  });
  test('no profile prompt lets the model record, approve or fix', () => {
    for (const a of QA_SPECIALIST_AGENTS) assert.match(AGENT_PROFILES[a].prompt, /PROPOSE/);
  });
});

describe('the answer is strictly the schema', () => {
  test('an extra field (a status, an approval, a recorded flag) is refused', () => {
    for (const extra of [{ status: 'accepted' }, { approved: true }, { recorded: true }, { verified: true }]) {
      assert.equal(qaFindingsSchema.safeParse({ findings: [{ ...proposal(), ...extra }] }).success, false);
    }
    assert.equal(qaFindingsSchema.safeParse({ findings: [proposal()], approved: true }).success, false);
  });
  test('an empty list, an unknown result, an unknown kind and a non-uuid case id are refused', () => {
    assert.equal(qaFindingsSchema.safeParse({ findings: [] }).success, false);
    assert.equal(qaFindingsSchema.safeParse({ findings: [{ ...proposal(), result: 'passed' }] }).success, false);
    assert.equal(qaFindingsSchema.safeParse({ findings: [{ ...proposal(), kind: 'approval' }] }).success, false);
    assert.equal(qaFindingsSchema.safeParse({ findings: [{ ...proposal(), caseId: 'cart-total' }] }).success, false);
  });
  test('the facts rendered to the model name the commit, the cases and the evidence it may cite, and say when the job is held', () => {
    const text = renderQaFacts(baseFacts('functional_test', { jobStatus: 'held' }));
    assert.match(text, /abc1234/);
    assert.match(text, new RegExp(`case:${CASE}`));
    assert.match(text, /run:r1/);
    assert.match(text, /HELD/);
  });
});

describe('the rules every specialist shares', () => {
  const agent = 'functional_test';
  test('a pass with evidence on a non-critical case is a proposal', () => accepted(agent, baseFacts(agent), proposal()));
  test('a pass with no evidence is refused', () => assert.match(refused(agent, baseFacts(agent), proposal({ evidenceRefs: [] })), /needs at least one evidence/));
  test('a pass on a critical case is refused (a person records it); a FAIL or BLOCKED on it is allowed', () => {
    assert.match(refused(agent, baseFacts(agent), proposal({ caseId: CRIT })), /critical case/);
    accepted(agent, baseFacts(agent), proposal({ caseId: CRIT, result: 'fail', reason: 'no receipt shown' }));
    accepted(agent, baseFacts(agent), proposal({ caseId: CRIT, result: 'blocked', evidenceRefs: [], reason: 'sandbox is down' }));
  });
  test('evidence that was not in the facts is refused', () => assert.match(refused(agent, baseFacts(agent), proposal({ evidenceRefs: ['run:made-up'] })), /not in the facts/));
  test('a case that is not in this job\'s facts is refused', () => assert.match(refused(agent, baseFacts(agent), proposal({ caseId: '00000000-0000-4000-8000-0000000000ff' })), /not in the facts/));
  test('a secret value in any text field is refused', () => {
    assert.match(refused(agent, baseFacts(agent), proposal({ reason: `config ${secret()}` })), /secret/);
    assert.match(refused(agent, baseFacts(agent), proposal({ detail: secret() })), /secret/);
  });
  test('a held job may propose only blocked or not_tested', () => {
    const held = baseFacts(agent, { jobStatus: 'held' });
    assert.match(refused(agent, held, proposal()), /held/);
    assert.match(refused(agent, held, proposal({ result: 'fail', reason: 'broken' })), /held/);
    accepted(agent, held, proposal({ result: 'blocked', evidenceRefs: [], reason: 'the agent is not enabled' }));
    accepted(agent, held, proposal({ result: 'not_tested', evidenceRefs: [], reason: 'did not run' }));
  });
  test('a case result needs a case, and only case results and observations carry a result', () => {
    assert.match(refused(agent, baseFacts(agent), proposal({ caseId: null })), /names a case/);
    assert.match(refused(agent, baseFacts(agent), proposal({ kind: 'category_observation', result: null, caseId: null, evidenceRefs: [] })), /carry a result/);
  });
  test('the same case proposed twice in one answer is refused', () => assert.match(refused(agent, baseFacts(agent), proposal(), proposal()), /twice/));
  test('the door arguments carry the plan\'s commit, never one the model chose', () => {
    const args = doorArgsFor(proposal(), 'abc1234');
    assert.equal(args.p_commit_ref, 'abc1234');
    assert.deepEqual(Object.keys(args).sort(), ['p_case_id', 'p_claimed_environment', 'p_commit_ref', 'p_detail', 'p_evidence_refs', 'p_kind', 'p_proposed_result', 'p_reason']);
  });
});

describe('functional_test (the P604 contract)', () => {
  test('the prompt carries the P604 rules that keep a functional verdict honest', () => {
    const prompt = AGENT_PROFILES.functional_test.prompt;
    for (const rule of [/APPROVED baseline/, /not_tested/, /blocked with the reason/, /never a pass/, /the wrong role is denied/, /payment claim/, /does? not declare the product production-ready|do not declare the product production-ready/, /Master QA/]) {
      assert.match(prompt, rule);
    }
    assert.match(prompt, /never act as an Admin or client approver/);
  });
  test('proposes case results and observations only', () => {
    accepted('functional_test', baseFacts('functional_test'), proposal(), proposal({ kind: 'category_observation', caseId: null, result: 'not_tested', evidenceRefs: [], reason: 'two cases were out of scope' }));
    assert.match(refused('functional_test', baseFacts('functional_test'), proposal({ kind: 'gate_summary', caseId: null, result: null, evidenceRefs: [], reason: 'gates fine' })), /may not propose/);
  });
});

describe('ui_journey_test', () => {
  const f = baseFacts('ui_journey_test');
  test('a pass names a browser environment the plan lists', () => {
    assert.match(refused('ui_journey_test', f, proposal()), /names the environment/);
    assert.match(refused('ui_journey_test', f, proposal({ environment: 'chrome-lab' })), /not an environment the plan lists/);
    accepted('ui_journey_test', f, proposal({ environment: 'staging' }));
  });
});

describe('api_integration_test: configured is not verified', () => {
  const f = baseFacts('api_integration_test', {
    integrations: [
      { name: 'Maps', kind: 'maps', health: 'configured', isMock: false },
      { name: 'Pay', kind: 'payments', health: 'verified', isMock: true },
      { name: 'Mail', kind: 'email', health: 'verified', isMock: false },
    ],
  });
  test('a pass citing a configured integration, or a mock, is refused', () => {
    assert.match(refused('api_integration_test', f, proposal({ evidenceRefs: ['integration:Maps'] })), /not a verified integration/);
    assert.match(refused('api_integration_test', f, proposal({ evidenceRefs: ['integration:Pay'] })), /not a verified integration/);
  });
  test('a pass citing a verified, non-mock integration is allowed; a FAIL may cite a configured one', () => {
    accepted('api_integration_test', f, proposal({ evidenceRefs: ['integration:Mail'] }));
    accepted('api_integration_test', f, proposal({ result: 'fail', reason: 'the endpoint returned 500', evidenceRefs: ['integration:Maps'] }));
  });
});

describe('database_test', () => {
  const f = baseFacts('database_test', { environments: ['staging', 'production'] });
  test('production is never the environment of a database test', () => {
    assert.match(refused('database_test', f, proposal({ environment: 'production' })), /never name production/);
    accepted('database_test', f, proposal({ environment: 'staging' }));
  });
});

describe('security_test: never raw exploit detail', () => {
  const f = baseFacts('security_test');
  test('a finding names the weakness and the fix', () => accepted('security_test', f, proposal({ result: 'fail', reason: 'the cart endpoint returns another tenant\'s cart; scope the query by organization' })));
  test('exploit shapes are refused in any field', () => {
    for (const reason of ["id=1' or 1=1 --", '<script>alert(1)</script>', 'a union select password from users', '../../etc/passwd', 'x; drop table carts', "' or '1'='1"]) {
      assert.match(refused('security_test', f, proposal({ result: 'fail', reason })), /never the exploit/, reason);
    }
    assert.match(refused('security_test', f, proposal({ result: 'fail', reason: 'the reset link is guessable', evidenceRefs: ['run:r1', 'run:r1'].slice(0, 1), environment: 'javascript:void(0)' })), /never the exploit|environment/);
  });
  test('the detail field stays null for a security finding', () => assert.match(refused('security_test', f, proposal({ result: 'fail', reason: 'tenant leak', detail: 'steps to reproduce: ...' })), /no detail field/));
});

describe('performance_test: the project\'s own targets, never a universal threshold', () => {
  const withBudget = baseFacts('performance_test', { budgets: [{ metric: 'checkout_p95', target: 800, unit: 'ms', lowerIsBetter: true }] });
  test('a result cites the project\'s own target and names the environment', () => {
    accepted('performance_test', withBudget, proposal({ evidenceRefs: ['budget:checkout_p95', 'run:r1'], environment: 'staging', reason: 'p95 was 640 ms against the project target of 800 ms' }));
    assert.match(refused('performance_test', withBudget, proposal({ evidenceRefs: ['run:r1'], environment: 'staging' })), /project's own target/);
    assert.match(refused('performance_test', withBudget, proposal({ evidenceRefs: ['budget:checkout_p95'] })), /names the environment/);
  });
  test('universal-threshold language is refused', () => {
    for (const reason of ['under 2 seconds is the industry standard', 'meets best practice for page load', 'rule of thumb says 200 ms', 'Google recommends 2.5 s']) {
      assert.match(refused('performance_test', withBudget, proposal({ reason, evidenceRefs: ['budget:checkout_p95'], environment: 'staging' })), /universal threshold/, reason);
    }
  });
  test('with no project target there is nothing to pass or fail against: only not_tested', () => {
    const none = baseFacts('performance_test');
    assert.match(refused('performance_test', none, proposal({ evidenceRefs: ['run:r1'], environment: 'staging' })), /no performance target/);
    accepted('performance_test', none, proposal({ result: 'not_tested', evidenceRefs: [], reason: 'the project has no performance target' }));
  });
});

describe('compatibility_test: an unavailable target is BLOCKED, never a pass', () => {
  const f = baseFacts('compatibility_test', {
    environments: ['staging', 'safari-17'],
    devices: [{ name: 'safari-17', platform: 'web', status: 'supported', reason: null }, { name: 'ie-11', platform: 'web', status: 'unsupported', reason: 'not supported' }],
  });
  test('a pass for a target the plan does not list is refused', () => assert.match(refused('compatibility_test', f, proposal({ environment: 'pixel-8-device' })), /not an environment the plan lists/));
  test('a pass or fail with no environment is refused', () => assert.match(refused('compatibility_test', f, proposal()), /names the environment/));
  test('an unsupported target cannot pass; it is blocked', () => {
    const unsupported = { ...f, environments: ['staging', 'ie-11'] };
    assert.match(refused('compatibility_test', unsupported, proposal({ environment: 'ie-11' })), /unavailable target is blocked/);
    accepted('compatibility_test', unsupported, proposal({ environment: null, result: 'blocked', evidenceRefs: [], reason: 'no ie-11 device available' }));
  });
  test('a supported, listed target may pass', () => accepted('compatibility_test', f, proposal({ environment: 'safari-17' })));
});

describe('regression_test: escaped defects', () => {
  const f = baseFacts('regression_test', { escaped: [{ ref: 'defect:d1', title: 'cart emptied on login' }, { ref: 'risk:checkout', title: 'escaped to production once' }] });
  test('every proposal targets an escaped defect or risk from the facts', () => {
    assert.match(refused('regression_test', f, proposal()), /escaped defect/);
    accepted('regression_test', f, proposal({ evidenceRefs: ['run:r1', 'defect:d1'] }));
    accepted('regression_test', f, proposal({ reason: 'guards defect:d1 against returning', evidenceRefs: ['run:r1'] }));
  });
  test('a defect that is not in the facts does not count', () => assert.match(refused('regression_test', f, proposal({ evidenceRefs: ['run:r1', 'defect:invented'] })), /not in the facts/));
  test('flaky is not a pass', () => assert.match(refused('regression_test', f, proposal({ evidenceRefs: ['run:r1', 'defect:d1'], reason: 'passed on retry; the test is flaky' })), /flaky is not a pass/));
});

describe('release_readiness: summaries and exception REQUESTS, never approvals', () => {
  const gates = [{ gate: 'security', satisfied: true, detail: 'ok' }, { gate: 'performance', satisfied: false, detail: 'no run' }];
  const f = baseFacts('release_readiness', { category: 'release', jobStatus: 'candidate', cases: [], gates, readiness: 'blocked (score 71, material_risk)' });
  const summary = (over: Partial<ProposedFinding> = {}): ProposedFinding => ({ kind: 'gate_summary', caseId: null, result: null, reason: 'one of two gates is satisfied; performance has no run', detail: null, evidenceRefs: ['gate:security', 'gate:performance'], environment: null, ...over });
  test('a summary that cites the stored gates is a proposal', () => accepted('release_readiness', f, summary()));
  test('a summary that cites no stored gate is refused', () => assert.match(refused('release_readiness', f, summary({ evidenceRefs: [] })), /cites the stored gates/));
  test('an exception REQUEST states the risk and the mitigation', () => {
    const req: ProposedFinding = { kind: 'exception_request', caseId: null, result: null, reason: 'request a time-boxed exception for the performance gate', detail: 'Risk: unmeasured checkout speed. Mitigation: monitor p95 for a week. Owner: delivery lead.', evidenceRefs: ['gate:performance'], environment: null };
    accepted('release_readiness', f, req);
    assert.match(refused('release_readiness', f, { ...req, detail: 'just let it through' }), /risk and the mitigation/);
    assert.match(refused('release_readiness', f, { ...req, detail: null }), /risk and the mitigation/);
  });
  test('approval language is refused: it approves nothing and releases nothing', () => {
    for (const reason of ['the candidate is approved for production', 'Release approved', 'cleared for release', 'signed off by QA', 'deployed to production']) {
      assert.match(refused('release_readiness', f, summary({ reason })), /never approves or releases/, reason);
    }
  });
  test('it cannot propose a case result', () => assert.match(refused('release_readiness', f, proposal()), /may not propose a case_result/));
  test('a case result agent cannot propose a gate summary or an exception request', () => {
    for (const a of QA_SPECIALIST_AGENTS.filter((x) => x !== 'release_readiness')) {
      assert.match(refused(a, baseFacts(a), summary()), /may not propose/);
    }
  });
});
