/**
 * What each outcome a review door can return says to the person who asked. Kept apart from the actions (a 'use server' file may export only async
 * functions) so a test can hold every outcome of every door against this map: an outcome with no sentence would fall back to a generic refusal.
 * `DOOR_OUTCOMES` lists every outcome the SQL function can return, split into those that are a success and those that are a refusal.
 */

export const WORDS: Record<string, string> = {
  no_actor: 'You are not signed in.',
  not_authorized: 'You do not have permission to do this.',
  not_found: 'That record was not found.',
  linked: 'Linked: the defect now has its regression test.',
  already_linked: 'That defect is already linked to that test.',
  bad_name: 'Name the automated test.',
  bad_build: 'The defective build must be a build of this project.',
  verified: 'Verified: the test passed in a run of the fix build.',
  already_verified: 'That link is already verified.',
  run_is_for_another_build: 'That run belongs to a different build than the fix build you named.',
  fix_build_is_the_defective_build: 'The fix build cannot be the defective build.',
  test_did_not_pass: 'That test did not pass in that run, so nothing was verified.',
  recorded: 'Recorded: the task now depends on that integration.',
  already_depends: 'That task already depends on that integration.',
  wrong_project: 'The task and the integration belong to different projects.',
  released: 'The dependency was removed.',
  bad_decision: 'Choose accept or reject.',
  already_reviewed: 'That draft was already reviewed.',
  note_required: 'Say why you are rejecting it.',
  note_too_long: 'The note is too long.',
  accepted: 'Accepted. This records your decision only: nothing was created. A person still writes and runs the test, and a draft is never evidence.',
  rejected: 'Rejected, and the reason is on record.',
  not_a_draft: 'That document is not an unreviewed agent draft.',
  bad_status: 'Choose a status for the document.',
  evidence_required: 'An implemented document must name its evidence.',
  refused: 'Refused: the document rules do not allow that (for example a secret value in the text).',
  invalid: 'Refused: the document did not pass its checks.',
};

/** The two review doors share outcome names but not meanings: what accepting or rejecting a DOCUMENT does is different from what it does to a test draft. */
export const DOCUMENT_WORDS: Record<string, string> = {
  accepted: 'Accepted: the document now has the status you chose, and the draft marker is removed.',
  rejected: 'Rejected: the document is deprecated, not deleted.',
};

export const DOOR_OUTCOMES = {
  link_regression_test: { ok: ['linked', 'already_linked'], refused: ['no_actor', 'not_authorized', 'not_found', 'bad_name', 'bad_build'] },
  verify_regression_link: {
    ok: ['verified', 'already_verified'],
    refused: ['no_actor', 'not_authorized', 'not_found', 'run_is_for_another_build', 'fix_build_is_the_defective_build', 'test_did_not_pass'],
  },
  depend_task_on_integration: { ok: ['recorded', 'already_depends'], refused: ['no_actor', 'not_authorized', 'not_found', 'wrong_project'] },
  release_task_integration_dependency: { ok: ['released'], refused: ['no_actor', 'not_authorized', 'not_found'] },
  review_test_case_draft: {
    ok: ['accepted', 'rejected'],
    refused: ['no_actor', 'not_authorized', 'not_found', 'bad_decision', 'already_reviewed', 'note_required', 'note_too_long'],
  },
  review_documentation_draft: {
    ok: ['accepted', 'rejected'],
    refused: ['no_actor', 'not_authorized', 'not_found', 'bad_decision', 'not_a_draft', 'bad_status', 'evidence_required', 'refused', 'invalid'],
  },
} as const;
