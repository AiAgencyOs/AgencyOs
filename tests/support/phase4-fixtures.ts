/**
 * Fixture chain for `tests/phase4-full-pipeline-e2e.test.ts`: a fresh org,
 * through a locked Phase 3 direction, to a `phase_three_handoffs` row with
 * `phase_four_ready = true` — the point Phase 4 itself begins.
 *
 * Phase 2 and Phase 3's OWN macro-state columns (`phase_two.state`,
 * `phase_three.state`) are not gated on by any door this chain calls — every
 * door reads the specific child rows it needs (a scope version, a screen, a
 * theme option) rather than the phase's own state — so, following the same
 * convention this repository's own canonical live-verification script
 * (`scripts/verify-phase-three.mjs`) already uses, `phase_two` and
 * `phase_three` themselves are inserted directly rather than through
 * `start_phase_two`/`start_phase_three`. Phase 2/3 are not what
 * `tests/phase4-full-pipeline-e2e.test.ts` is testing; everything from the
 * screen baseline onward — every fact Phase 4's `phase_four_ready` gate
 * actually depends on — is driven through its real door.
 */

import type { Claims, LivePostgres } from './live-postgres.ts';
import { sqlJson, sqlString } from './live-postgres.ts';

/** A single-row, single-or-multi-column `psql -qtA` result, split on `|`. */
function row(output: string): string[] {
  const line = output.split('\n').find((l) => l.length > 0);
  if (line === undefined) {
    throw new Error(`expected at least one output row, got:\n${JSON.stringify(output)}`);
  }
  return line.split('|');
}

/** The first column of the first row — for a single scalar/outcome result. */
function scalar(output: string): string {
  return row(output)[0]!;
}

export interface Phase3Handoff {
  orgId: string;
  ownerId: string;
  ownerClaims: Claims;
  clientAccountId: string;
  projectId: string;
  phaseThreeId: string;
  themeOptionId: string;
  colorOptionId: string;
  phaseThreeHandoffId: string;
}

/**
 * Builds one org, one owner (internal staff, `role: owner`), one client
 * account, one project with the given contract value, and drives it through
 * every real Phase 3 door up to `lock_phase_three_direction`, asserting
 * along the way that each door answered the outcome this fixture depends on
 * (a wrong outcome here would silently hand Phase 4 a broken foundation
 * rather than fail loudly at the point something actually went wrong).
 */
export async function buildPhase3Handoff(
  db: LivePostgres,
  opts: { label: string; budgetMinor: number },
  assertOutcome: (actual: string, expected: string, step: string) => void,
): Promise<Phase3Handoff> {
  const { label, budgetMinor } = opts;

  const orgId = scalar(
    db.admin(
      `insert into core.organizations (name, slug) values (${sqlString(`Phase4 E2E ${label}`)}, ${sqlString(`phase4-e2e-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)}) returning id;`,
    ),
  );

  const ownerId = scalar(
    db.admin(
      `insert into auth.users (email) values (${sqlString(`owner-${label}@phase4-e2e.test`)}) returning id;`,
    ),
  );
  // `core.handle_new_auth_user` (20260807120011_auth_hook.sql) already
  // mirrors the auth.users insert above into core.users via
  // `on_auth_user_created` — inserting it again here would collide with that
  // trigger's own insert.
  db.admin(`
    insert into core.memberships (organization_id, user_id, role) values ('${orgId}', '${ownerId}', 'owner');
  `);

  const ownerClaims: Claims = { sub: ownerId, appRole: 'owner', organizationId: orgId };

  const clientAccountId = scalar(
    db.admin(
      `insert into core.client_accounts (organization_id, name) values ('${orgId}', ${sqlString(`${label} Client`)}) returning id;`,
    ),
  );

  const projectId = scalar(
    db.admin(`
      insert into projects.projects (organization_id, client_account_id, name, status, budget_minor)
      values ('${orgId}', '${clientAccountId}', ${sqlString(`${label} Project`)}, 'active', ${budgetMinor})
      returning id;
    `),
  );

  // A valid (from_agent, to_agent) pair seeded by
  // 20260821210000_the_roster_arrives.sql.
  const handoffId = scalar(
    db.admin(`
      insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective)
      values ('${orgId}', gen_random_uuid(), 'sales', 'project_manager', 'Deliver ${label}')
      returning id;
    `),
  );

  const phaseTwoId = scalar(
    db.admin(`
      insert into projects.phase_two (organization_id, project_id, handoff_id)
      values ('${orgId}', '${projectId}', '${handoffId}')
      returning id;
    `),
  );

  const phaseThreeId = scalar(
    db.admin(`
      insert into projects.phase_three (organization_id, project_id, phase_two_id)
      values ('${orgId}', '${projectId}', '${phaseTwoId}')
      returning id;
    `),
  );

  // Active scope, no scope_items: finalize_screen_baseline's "uncovered
  // scope" check counts INCLUDED scope_items with no covering screen, so an
  // empty scope is trivially fully covered.
  db.admin(`
    insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at)
    values ('${orgId}', '${projectId}', 1, 'active', now());
  `);

  db.admin(`
    insert into projects.screens (organization_id, project_id, screen_key, name, user_role)
    values ('${orgId}', '${projectId}', 'home', 'Home', 'client_admin');
  `);

  // ── screen baseline ───────────────────────────────────────────────────
  const draft = row(
    db.queryAs(
      'authenticated',
      `select * from projects.draft_screen_baseline(p_project_id => '${projectId}');`,
      ownerClaims,
    ),
  );
  assertOutcome(draft[0]!, 'drafted', 'draft_screen_baseline');
  const baselineId = draft[1]!;

  const finalized = row(
    db.queryAs(
      'authenticated',
      `select * from projects.finalize_screen_baseline(p_baseline_id => '${baselineId}');`,
      ownerClaims,
    ),
  );
  assertOutcome(finalized[0]!, 'finalized', 'finalize_screen_baseline');

  // ── theme + color option ──────────────────────────────────────────────
  const theme = row(
    db.queryAs(
      'authenticated',
      `select * from projects.record_theme_option(
         p_project_id => '${projectId}', p_option_index => 1,
         p_name => 'Clean Minimal', p_direction_summary => 'Light, airy, generous whitespace'
       );`,
      ownerClaims,
    ),
  );
  assertOutcome(theme[0]!, 'recorded', 'record_theme_option');
  const themeOptionId = theme[1]!;

  const figma = row(
    db.queryAs(
      'authenticated',
      `select * from projects.link_theme_figma(
         p_theme_option_id => '${themeOptionId}', p_file_key => 'FIGMA_FILE_1', p_node_id => 'NODE_1'
       );`,
      ownerClaims,
    ),
  );
  assertOutcome(figma[0]!, 'linked', 'link_theme_figma');

  const color = row(
    db.queryAs(
      'authenticated',
      `select * from projects.record_color_option(
         p_theme_option_id => '${themeOptionId}', p_option_index => 1,
         p_palette_name => 'Ocean', p_primary_hex => '#1155ff'
       );`,
      ownerClaims,
    ),
  );
  assertOutcome(color[0]!, 'recorded', 'record_color_option');
  const colorOptionId = color[1]!;

  // ── internal review -> admin review (order of gates, §16) ─────────────
  const assigned = row(
    db.queryAs(
      'authenticated',
      `select * from projects.assign_design_reviewer(p_project_id => '${projectId}', p_user_id => '${ownerId}');`,
      ownerClaims,
    ),
  );
  assertOutcome(assigned[0]!, 'assigned', 'assign_design_reviewer');

  const internalReview = row(
    db.queryAs(
      'authenticated',
      `select * from projects.submit_internal_design_review(p_theme_option_id => '${themeOptionId}', p_result => 'passed');`,
      ownerClaims,
    ),
  );
  assertOutcome(internalReview[0]!, 'recorded', 'submit_internal_design_review');

  const adminDecision = row(
    db.queryAs(
      'authenticated',
      `select * from projects.submit_admin_design_decision(p_theme_option_id => '${themeOptionId}', p_decision => 'confirm');`,
      ownerClaims,
    ),
  );
  assertOutcome(adminDecision[0]!, 'recorded', 'submit_admin_design_decision');

  // ── client share + final confirmation ──────────────────────────────────
  const share = row(
    db.queryAs(
      'authenticated',
      `select * from projects.record_design_share(
         p_project_id => '${projectId}', p_theme_option_ids => array['${themeOptionId}']::uuid[],
         p_channel => 'other', p_evidence_ref => 'call-transcript-${label}'
       );`,
      ownerClaims,
    ),
  );
  assertOutcome(share[0]!, 'shared', 'record_design_share');
  const shareId = share[1]!;

  const clientDecision = row(
    db.queryAs(
      'authenticated',
      `select * from projects.record_client_design_decision(
         p_share_id => '${shareId}', p_decision => 'final_confirmed',
         p_client_words => 'This is the one, please proceed.',
         p_theme_option_id => '${themeOptionId}', p_color_option_id => '${colorOptionId}'
       );`,
      ownerClaims,
    ),
  );
  assertOutcome(clientDecision[0]!, 'recorded', 'record_client_design_decision');

  // ── design tokens (Phase 4's own readiness requirement) ────────────────
  const tokens = row(
    db.queryAs(
      'authenticated',
      `select * from projects.record_design_token_set(
         p_theme_option_id => '${themeOptionId}',
         p_font_family_heading => 'Inter', p_font_family_body => 'Inter',
         p_type_scale_ratio => 1.25, p_base_spacing_px => 8,
         p_radius_style => 'soft', p_elevation_style => 'subtle', p_border_style => 'hairline',
         p_icon_treatment => 'outline', p_navigation_style => 'top_bar'
       );`,
      ownerClaims,
    ),
  );
  assertOutcome(tokens[0]!, 'recorded', 'record_design_token_set');

  const tokensFinal = row(
    db.queryAs(
      'authenticated',
      `select * from projects.finalize_design_token_set(p_theme_option_id => '${themeOptionId}');`,
      ownerClaims,
    ),
  );
  assertOutcome(tokensFinal[0]!, 'finalized', 'finalize_design_token_set');

  // ── the lock ─────────────────────────────────────────────────────────
  const lock = row(
    db.queryAs(
      'authenticated',
      `select * from projects.lock_phase_three_direction(p_phase_three_id => '${phaseThreeId}');`,
      ownerClaims,
    ),
  );
  assertOutcome(lock[0]!, 'locked', 'lock_phase_three_direction');
  const phaseThreeHandoffId = lock[1]!;

  return {
    orgId,
    ownerId,
    ownerClaims,
    clientAccountId,
    projectId,
    phaseThreeId,
    themeOptionId,
    colorOptionId,
    phaseThreeHandoffId,
  };
}

/** A minimal, valid `screens` draft payload for `record_ui_version_draft`/`revise_ui_version`. */
export function sampleScreens(variant = 1): unknown[] {
  return [
    {
      screenKey: 'home',
      name: 'Home',
      layoutApproach: `Single column, hero + feature grid (v${variant})`,
      components: ['Header', 'Hero', 'FeatureGrid', 'Footer'],
      statesAddressed: ['empty', 'loading', 'error', 'success'],
    },
  ];
}

export { row as firstRow, scalar as firstScalar, sqlJson, sqlString };
