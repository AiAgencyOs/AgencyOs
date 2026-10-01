// ═══════════════════════════════════════════════════════════════════════════
// Requirements, design, prototype and development — the doors added for the
// rendered PDF audit (Theme W4, migrations 20261006400000 / 100 / 200).
// Proven against real Postgres:
//   A. a clarification is asked of a requirement and answered once
//   B. a comment thread on a design; append-only; no direct write
//   C. a screen is approved only through the gate: states drawn AND QA
//      confirmed (owner / ops admin); category is set by a door
//   D. only a delivery role records a design share (PM); a brand rule door
//   E. a prototype goes to the client only when QA passed and Admin approved;
//      the owner alone may override, with a reason that is audited
//   F. build details (commit, number, rollback target) and Admin's decision
//   G. a draft plan is approved once, by a delivery role, before activation
//   H. a repository's access level and merge policy are set by an admin
//   I. every new table refuses a direct write; every door audits
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('requirements, design, prototype and development doors', 'zztest-w4');
const { check, rest, one, section } = k;
const rpc = k.rpc('projects');

const ids = { items: [], deliverables: [] };

try {
  const owner = await k.makeUser('owner');
  const admin = await k.makeUser('ops_admin');
  const lead = await k.makeUser('delivery_lead');
  const member = await k.makeUser('member');
  const finance = await k.makeUser('finance');
  const project = await k.makeProject('w4');

  // ── fixtures (service role) ──────────────────────────────────────────────
  const sv = one(await rest('POST', 'projects', 'scope_versions', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', source: 'onboarding' }));
  const item = one(await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: sv.id, title: 'zztest-w4 checkout', inclusion: 'included', acceptance_criteria: 'pays' }));
  if (!item?.id) k.fail(`fixture scope item: ${JSON.stringify(item)}`);

  // ── A. requirement clarifications ────────────────────────────────────────
  section('A. a clarification is asked of a requirement');
  const asked = one(await rpc('raise_requirement_clarification', { p_scope_item_id: item.id, p_question: 'Which payment providers?', p_impact: 'Decides checkout scope' }, member.token));
  check(asked?.outcome === 'raised' && asked?.clarification_id, 'a writer raises a clarification with no plan', asked?.outcome);
  check(one(await rpc('raise_requirement_clarification', { p_scope_item_id: item.id, p_question: '  ', p_impact: 'x' }, member.token))?.outcome === 'empty', 'an empty question is refused');
  check(one(await rpc('raise_requirement_clarification', { p_scope_item_id: item.id, p_question: 'x'.repeat(1001), p_impact: 'x' }, member.token))?.outcome === 'too_long', 'a question over 1000 characters is refused');
  check(one(await rpc('raise_requirement_clarification', { p_scope_item_id: randomUUID(), p_question: 'q', p_impact: 'i' }, member.token))?.outcome === 'not_found', 'an unknown requirement is not found');
  check(one(await rpc('raise_requirement_clarification', { p_scope_item_id: item.id, p_question: 'q', p_impact: 'i' }, finance.token))?.outcome === 'not_authorized', 'finance may not ask');
  const row = one(await rest('GET', 'projects', `requirement_clarifications?id=eq.${asked.clarification_id}&select=status,project_id,raised_by`, null, member.token));
  check(row?.status === 'open' && row?.project_id === project.id && row?.raised_by === member.id, 'it is open, on the right project, by the asker');
  check(one(await rpc('answer_requirement_clarification', { p_clarification_id: asked.clarification_id, p_answer: '' }, member.token))?.outcome === 'empty', 'an empty answer is refused');
  check(one(await rpc('answer_requirement_clarification', { p_clarification_id: asked.clarification_id, p_answer: 'Stripe and UPI' }, member.token))?.outcome === 'answered', 'it is answered');
  check(one(await rpc('answer_requirement_clarification', { p_clarification_id: asked.clarification_id, p_answer: 'again' }, member.token))?.outcome === 'already_answered', 'and only once');
  const done = one(await rest('GET', 'projects', `requirement_clarifications?id=eq.${asked.clarification_id}&select=status,answer,answered_by`, null, member.token));
  check(done?.status === 'answered' && done?.answer === 'Stripe and UPI' && done?.answered_by === member.id, 'the answer, who and when are stored');

  // ── B. design comments ───────────────────────────────────────────────────
  section('B. a comment thread on a design');
  const design = one(await rest('POST', 'projects', 'deliverables', { organization_id: ORG, project_id: project.id, kind: 'design', version: 1, title: 'zztest-w4 design' }));
  ids.deliverables.push(design.id);
  const c1 = one(await rpc('comment_on_design_review', { p_subject_type: 'deliverable', p_subject_id: design.id, p_body: 'Logo too small' }, member.token));
  check(c1?.outcome === 'commented' && c1?.comment_id, 'a writer comments on a design deliverable', c1?.outcome);
  check(one(await rpc('comment_on_design_review', { p_subject_type: 'deliverable', p_subject_id: design.id, p_body: '' }, member.token))?.outcome === 'empty', 'an empty comment is refused');
  check(one(await rpc('comment_on_design_review', { p_subject_type: 'deliverable', p_subject_id: randomUUID(), p_body: 'x' }, member.token))?.outcome === 'not_found', 'an unknown subject is not found');
  check(one(await rpc('comment_on_design_review', { p_subject_type: 'nonsense', p_subject_id: design.id, p_body: 'x' }, member.token))?.outcome === 'bad_subject', 'an unknown subject type is refused');
  check(one(await rpc('comment_on_design_review', { p_subject_type: 'deliverable', p_subject_id: design.id, p_body: 'x' }, finance.token))?.outcome === 'not_authorized', 'finance may not comment');

  // ── C. screens: category, QA confirmation, approval ──────────────────────
  section('C. a screen is approved through a gate');
  const screen = one(await rest('POST', 'projects', 'screens', { organization_id: ORG, project_id: project.id, screen_key: 'w4_home', name: 'Home', user_role: 'owner' }));
  check(one(await rpc('set_screen_category', { p_screen_id: screen.id, p_category: 'Dashboard' }, lead.token))?.outcome === 'set', 'a delivery role sets the category');
  check(one(await rpc('set_screen_category', { p_screen_id: screen.id, p_category: 'Dashboard' }, lead.token))?.outcome === 'unchanged', 'the same category changes nothing');
  check(one(await rpc('set_screen_category', { p_screen_id: screen.id, p_category: 'Dashboard' }, member.token))?.outcome === 'not_authorized', 'a member may not categorise');
  const missing = one(await rpc('approve_screen', { p_screen_id: screen.id }, lead.token));
  check(missing?.outcome === 'missing_states' && /empty/.test(missing?.detail ?? ''), 'approval is refused while states are missing, naming them', `${missing?.outcome} ${missing?.detail}`);
  await rest('PATCH', 'projects', `screens?id=eq.${screen.id}`, { has_empty_state: true, has_loading_state: true, has_error_state: true, has_success_state: true });
  check(one(await rpc('approve_screen', { p_screen_id: screen.id }, lead.token))?.outcome === 'qa_not_confirmed', 'approval is refused until QA confirms');
  check(one(await rpc('confirm_screen_qa', { p_screen_id: screen.id }, admin.token))?.outcome === 'not_submitted', 'QA cannot confirm a screen nobody submitted');
  await rest('PATCH', 'projects', `screens?id=eq.${screen.id}`, { qa_status: 'submitted' });
  check(one(await rpc('confirm_screen_qa', { p_screen_id: screen.id }, lead.token))?.outcome === 'not_authorized', 'a delivery lead may not confirm QA on their own screen');
  check(one(await rpc('confirm_screen_qa', { p_screen_id: screen.id }, admin.token))?.outcome === 'confirmed', 'an ops admin confirms QA');
  check(one(await rpc('confirm_screen_qa', { p_screen_id: screen.id }, admin.token))?.outcome === 'already_confirmed', 'once');
  check(one(await rpc('approve_screen', { p_screen_id: screen.id }, member.token))?.outcome === 'not_authorized', 'a member may not approve');
  check(one(await rpc('approve_screen', { p_screen_id: screen.id }, lead.token))?.outcome === 'approved', 'with states and QA, a delivery role approves');
  check(one(await rest('GET', 'projects', `screens?id=eq.${screen.id}&select=status,category`))?.status === 'approved', 'the screen is approved');
  check(one(await rpc('approve_screen', { p_screen_id: screen.id }, lead.token))?.outcome === 'already_approved', 'and only once');

  // ── D. brand rules ───────────────────────────────────────────────────────
  section('D. brand rules; the PM sends to the client');
  const rule = one(await rpc('add_brand_rule', { p_project_id: project.id, p_title: 'Clear space', p_rule: 'Keep the logo mark height clear on every side.' }, lead.token));
  check(rule?.outcome === 'added' && rule?.rule_id, 'a delivery role adds a brand rule', rule?.outcome);
  check(one(await rpc('add_brand_rule', { p_project_id: project.id, p_title: '', p_rule: 'x' }, lead.token))?.outcome === 'empty', 'an empty rule is refused');
  check(one(await rpc('add_brand_rule', { p_project_id: project.id, p_title: 'x', p_rule: 'x' }, member.token))?.outcome === 'not_authorized', 'a member may not');
  check(one(await rpc('remove_brand_rule', { p_rule_id: rule.rule_id }, lead.token))?.outcome === 'removed', 'and removes one');
  const share = one(await rpc('record_design_share', { p_project_id: project.id, p_theme_option_ids: [randomUUID()], p_channel: 'whatsapp', p_evidence_ref: 'wamid.x' }, member.token));
  check(share?.outcome === 'no_phase_three' || share?.outcome === 'forbidden', 'a member cannot record a design share (refused before anything is read)', share?.outcome);

  // ── E/F. prototype gate, build details ───────────────────────────────────
  section('E. a prototype goes to the client through a gate');
  const proto = one(await rest('POST', 'projects', 'deliverables', { organization_id: ORG, project_id: project.id, kind: 'prototype', version: 1, title: 'zztest-w4 prototype' }));
  const build1 = one(await rest('POST', 'projects', 'deliverables', { organization_id: ORG, project_id: project.id, kind: 'build', version: 1, title: 'zztest-w4 build 1' }));
  const build2 = one(await rest('POST', 'projects', 'deliverables', { organization_id: ORG, project_id: project.id, kind: 'build', version: 2, title: 'zztest-w4 build 2' }));
  ids.deliverables.push(proto.id, build1.id, build2.id);
  const gate0 = one(await rpc('prototype_send_gate', { p_deliverable_id: proto.id }, lead.token));
  check(gate0?.qa_passed === false && gate0?.admin_approved === false && gate0?.qa_source === 'no QA evidence', 'a fresh prototype has neither', JSON.stringify(gate0));
  check(one(await rpc('send_prototype_for_client_review', { p_deliverable_id: proto.id }, lead.token))?.outcome === 'not_qa_passed', 'it is refused: QA has not passed');
  check(one(await rpc('record_prototype_qa_check', { p_deliverable_id: proto.id, p_outcome: 'changes_required' }, member.token))?.outcome === 'note_required', 'a QA check asking for changes needs a note');
  check(one(await rpc('record_prototype_qa_check', { p_deliverable_id: proto.id, p_outcome: 'passed', p_evidence_url: 'http://x' }, member.token))?.outcome === 'invalid', 'an evidence link must be https');
  check(one(await rpc('record_prototype_qa_check', { p_deliverable_id: proto.id, p_outcome: 'passed' }, finance.token))?.outcome === 'not_authorized', 'finance may not record QA');
  check(one(await rpc('record_prototype_qa_check', { p_deliverable_id: build1.id, p_outcome: 'passed' }, member.token))?.outcome === 'wrong_kind', 'a QA check is on a prototype');
  check(one(await rpc('record_prototype_qa_check', { p_deliverable_id: proto.id, p_outcome: 'passed', p_note: 'walked every flow', p_evidence_url: 'https://example.invalid/qa' }, member.token))?.outcome === 'recorded', 'a writer records a QA check');
  const gate1 = one(await rpc('prototype_send_gate', { p_deliverable_id: proto.id }, lead.token));
  check(gate1?.qa_passed === true && gate1?.qa_source === 'a QA check recorded by a person', 'a recorded QA pass opens the QA half of the gate', JSON.stringify(gate1));
  check(one(await rpc('send_prototype_for_client_review', { p_deliverable_id: proto.id }, lead.token))?.outcome === 'not_admin_approved', 'still refused: Admin has not approved');
  check(one(await rpc('submit_deliverable', { p_deliverable_id: proto.id }, lead.token))?.outcome === 'not_admin_approved', 'the generic submit door refuses a prototype too');
  check(one(await rpc('decide_prototype_admin', { p_deliverable_id: proto.id, p_decision: 'approved' }, lead.token))?.outcome === 'not_authorized', 'a delivery lead may not approve as Admin');
  check(one(await rpc('decide_prototype_admin', { p_deliverable_id: proto.id, p_decision: 'changes_required' }, admin.token))?.outcome === 'note_required', 'asking for changes needs a note');
  check(one(await rpc('decide_prototype_admin', { p_deliverable_id: proto.id, p_decision: 'approved', p_note: 'good' }, admin.token))?.outcome === 'decided', 'an ops admin approves');
  check(one(await rpc('decide_prototype_admin', { p_deliverable_id: build1.id, p_decision: 'approved' }, admin.token))?.outcome === 'wrong_kind', 'Admin decides on prototypes only');
  check(one(await rpc('send_prototype_for_client_review', { p_deliverable_id: proto.id, p_override_reason: 'because' }, lead.token))?.outcome === 'override_not_allowed', 'only the owner may override');
  const sent = one(await rpc('send_prototype_for_client_review', { p_deliverable_id: proto.id }, lead.token));
  // With no approval policy on a bare local org the engine may answer no_policy; the gate itself has passed.
  check(['submitted', 'no_policy'].includes(sent?.outcome), 'with QA passed and Admin approved the gate opens', sent?.outcome);

  const proto2 = one(await rest('POST', 'projects', 'deliverables', { organization_id: ORG, project_id: project.id, kind: 'prototype', version: 2, title: 'zztest-w4 prototype 2' }));
  ids.deliverables.push(proto2.id);
  const over = one(await rpc('send_prototype_for_client_review', { p_deliverable_id: proto2.id, p_override_reason: 'client demo tomorrow' }, owner.token));
  check(['submitted', 'no_policy'].includes(over?.outcome), 'the owner may send around the gate with a reason', over?.outcome);
  const oaudit = await rest('GET', 'audit', `audit_log?action=eq.deliverable.prototype_send_overridden&after->>projectId=eq.${project.id}&select=actor_id,after`);
  check(Array.isArray(oaudit.json) && oaudit.json.length === 1 && oaudit.json[0].after?.reason === 'client demo tomorrow', 'the override and its reason are on the audit trail');

  section('F. a build retains how to reproduce and roll it back');
  check(one(await rpc('set_deliverable_details', { p_deliverable_id: build2.id, p_platform: '', p_commit_ref: 'a1b2c3d', p_build_number: '42', p_rollback_target_id: build1.id, p_rollback_note: 'redeploy build 1' }, lead.token))?.outcome === 'set', 'a delivery role records commit, number and rollback target');
  const det = one(await rest('GET', 'projects', `deliverable_details?deliverable_id=eq.${build2.id}&select=commit_ref,build_number,rollback_target_id`, null, lead.token));
  check(det?.commit_ref === 'a1b2c3d' && det?.build_number === '42' && det?.rollback_target_id === build1.id, 'they are stored');
  check(one(await rpc('set_deliverable_details', { p_deliverable_id: build2.id, p_platform: '', p_commit_ref: 'x', p_build_number: '', p_rollback_target_id: build2.id }, lead.token))?.outcome === 'bad_rollback_target', 'a build cannot roll back to itself');
  check(one(await rpc('set_deliverable_details', { p_deliverable_id: design.id, p_platform: '', p_commit_ref: 'x', p_build_number: '' }, lead.token))?.outcome === 'wrong_kind', 'a design has no build details');
  check(one(await rpc('set_deliverable_details', { p_deliverable_id: proto.id, p_platform: 'plan9', p_commit_ref: '', p_build_number: '' }, lead.token))?.outcome === 'bad_platform', 'an unknown platform is refused');
  check(one(await rpc('set_deliverable_details', { p_deliverable_id: proto.id, p_platform: 'web', p_commit_ref: '', p_build_number: '' }, member.token))?.outcome === 'not_authorized', 'a member may not');

  // ── G. plan approval ─────────────────────────────────────────────────────
  section('G. a plan is approved before it is activated');
  const plan = one(await rest('POST', 'projects', 'project_plans', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', scope_version_id: sv.id }));
  check(one(await rpc('approve_project_plan', { p_plan_id: plan.id }, lead.token))?.outcome === 'empty_plan', 'a plan with no deliverable cannot be approved');
  await rest('POST', 'projects', 'plan_deliverables', { organization_id: ORG, plan_id: plan.id, name: 'zztest-w4 checkout', scope_item_id: item.id, applicable_phase: 'phase_4', readiness_criteria: 'built', evidence_required: 'demo' });
  check(one(await rpc('approve_project_plan', { p_plan_id: plan.id, p_note: 'ok' }, member.token))?.outcome === 'not_authorized', 'a member may not approve a plan');
  check(one(await rpc('approve_project_plan', { p_plan_id: plan.id, p_note: 'ok' }, lead.token))?.outcome === 'approved', 'a delivery role approves the draft');
  check(one(await rpc('approve_project_plan', { p_plan_id: plan.id }, lead.token))?.outcome === 'already_approved', 'once');
  const pa = one(await rest('GET', 'projects', `project_plans?id=eq.${plan.id}&select=approved_by,approved_at,approval_note`));
  check(pa?.approved_by === lead.id && pa?.approved_at && pa?.approval_note === 'ok', 'who, when and why are stored');

  // ── H. repository policy ────────────────────────────────────────────────
  section('H. a repository has an access level and a merge policy');
  await rest('POST', 'projects', 'repository_links', { organization_id: ORG, project_id: project.id, provider: 'github', owner: 'zztest', repo: 'w4', default_branch: 'main' });
  const link0 = one(await rest('GET', 'projects', `repository_links?project_id=eq.${project.id}&select=access_level,merge_min_approvals,merge_role`));
  check(link0?.access_level === 'full' && link0?.merge_min_approvals === 0 && link0?.merge_role === 'delivery', 'a link starts with what it always allowed');
  check(one(await rpc('set_repository_policy', { p_project_id: project.id, p_access_level: 'branch_and_review', p_merge_min_approvals: 2, p_merge_role: 'admin' }, lead.token))?.outcome === 'not_authorized', 'a delivery lead may not set the policy');
  check(one(await rpc('set_repository_policy', { p_project_id: project.id, p_access_level: 'everything', p_merge_min_approvals: 2, p_merge_role: 'admin' }, admin.token))?.outcome === 'bad_policy', 'an unknown level is refused');
  check(one(await rpc('set_repository_policy', { p_project_id: project.id, p_access_level: 'full', p_merge_min_approvals: 9, p_merge_role: 'admin' }, admin.token))?.outcome === 'bad_policy', 'more than five approvals is refused');
  check(one(await rpc('set_repository_policy', { p_project_id: project.id, p_access_level: 'branch_and_review', p_merge_min_approvals: 2, p_merge_role: 'admin' }, admin.token))?.outcome === 'set', 'an ops admin sets it');
  check(one(await rpc('set_repository_policy', { p_project_id: project.id, p_access_level: 'branch_and_review', p_merge_min_approvals: 2, p_merge_role: 'admin' }, admin.token))?.outcome === 'unchanged', 'the same policy changes nothing');
  const link1 = one(await rest('GET', 'projects', `repository_links?project_id=eq.${project.id}&select=access_level,merge_min_approvals,merge_role`));
  check(link1?.access_level === 'branch_and_review' && link1?.merge_min_approvals === 2 && link1?.merge_role === 'admin', 'it is stored');
  check(one(await rpc('set_repository_policy', { p_project_id: randomUUID(), p_access_level: 'full', p_merge_min_approvals: 0, p_merge_role: 'owner' }, admin.token))?.outcome === 'not_linked', 'a project with no link has none');

  // ── I. no direct writes; audit ───────────────────────────────────────────
  section('I. no direct write; every door audits');
  const tables = [
    ['requirement_clarifications', { organization_id: ORG, project_id: project.id, scope_item_id: item.id, question: 'q', impact: 'i' }],
    ['design_review_comments', { organization_id: ORG, project_id: project.id, subject_type: 'deliverable', subject_id: design.id, body: 'x' }],
    ['brand_rules', { organization_id: ORG, project_id: project.id, title: 't', rule: 'r' }],
    ['deliverable_details', { organization_id: ORG, project_id: project.id, deliverable_id: proto2.id }],
  ];
  for (const [table, body] of tables) {
    for (const [who, token] of [['owner', owner.token], ['member', member.token]]) {
      const w = await rest('POST', 'projects', table, body, token);
      check(!w.ok, `${who}: a direct insert into ${table} is refused`, `${w.status}`);
    }
  }
  const actions = ['requirement.clarification_raised', 'requirement.clarification_answered', 'design.review_commented', 'project.screen_category_set', 'project.screen_qa_confirmed', 'project.screen_approved', 'project.brand_rule_added', 'deliverable.prototype_admin_decided', 'deliverable.details_set', 'project.plan_approved', 'git.repository_policy_set'];
  const audit = await rest('GET', 'audit', `audit_log?action=in.(${actions.join(',')})&order=id.desc&limit=200&select=action,actor_id,after,subject_id`);
  const seen = new Set((Array.isArray(audit.json) ? audit.json : []).filter((a) => a.actor_id && [owner.id, admin.id, lead.id, member.id].includes(a.actor_id)).map((a) => a.action));
  for (const a of actions) check(seen.has(a), `${a} is audited with the actor`);
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      // A submitted prototype leaves an approval request and outbox events behind; a fixture
      // that survives its own run breaks the next script that sweeps the shared outbox.
      const ds = await rest('GET', 'projects', `deliverables?project_id=eq.${id}&select=id`);
      for (const d of Array.isArray(ds.json) ? ds.json : []) {
        await rest('DELETE', 'core', `outbox_events?subject_id=eq.${d.id}`);
        await rest('DELETE', 'approvals', `approval_requests?subject_id=eq.${d.id}`);
      }
      await rest('DELETE', 'core', `outbox_events?payload->>projectId=eq.${id}`);
      const plans = await rest('GET', 'projects', `project_plans?project_id=eq.${id}&select=id`);
      for (const pl of Array.isArray(plans.json) ? plans.json : []) {
        await rest('DELETE', 'projects', `plan_deliverables?plan_id=eq.${pl.id}`);
        await rest('DELETE', 'projects', `project_plans?id=eq.${pl.id}`);
      }
      await rest('DELETE', 'projects', `deliverables?project_id=eq.${id}&kind=eq.build&id=not.is.null`);
      await rest('DELETE', 'projects', `repository_links?project_id=eq.${id}`);
    }
  });
}
k.finish();
