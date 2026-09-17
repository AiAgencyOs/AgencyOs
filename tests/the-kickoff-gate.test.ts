import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { KICKOFF_BLOCKERS, describeBlockers } from '../src/modules/projects/kickoff-blockers.ts';

/**
 * The kickoff gate — Master §5.10, §5.11, P2-08; PM §6 PM-08/09, §15.
 *
 * Three things are worth asserting, and all three are about restraint.
 *
 * The gate list is **the document's** — §5.10 names five gates and nothing is
 * added to them. There is **no override**, because §15 says a failed gate must
 * not announce a kickoff and a message to a client cannot be taken back. And
 * the kickoff **does not send**: there is nothing on this deployment to send
 * through, so the evidence is required rather than produced.
 *
 * The behaviour is proven where SQL runs — a whole project driven from
 * nothing, through every gate, to ACTIVE and Phase 2 COMPLETED.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917160000_the_kickoff_gate.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const SERVICE = read('src/modules/projects/planning.ts');
const KICKOFF = SERVICE.slice(SERVICE.indexOf('The pre-kickoff gate and the kickoff'));

const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. the gate list is the document’s', () => {
  test('exactly §5.10’s gates, and each is named when it fails', () => {
    const fn = door('pre_kickoff_readiness');
    for (const name of ['onboarding_incomplete', 'whatsapp_group_not_mapped', 'advance_not_verified', 'no_active_plan']) {
      assert.match(fn, new RegExp(`'${name}'::text`), `${name} is never returned`);
    }
    // Every name the door can return has a sentence for a person.
    for (const name of ['onboarding_incomplete', 'whatsapp_group_not_mapped', 'advance_not_verified', 'no_active_plan']) {
      assert.ok(KICKOFF_BLOCKERS[name], `${name} has no explanation`);
    }
  });

  test('an unknown gate name is shown, not dropped', () => {
    // A gate added to the door tomorrow and not to the vocabulary must still
    // reach the person. Dropping it would report "not ready" with one reason
    // missing, which is worse than an ugly machine name.
    assert.deepEqual(describeBlockers(['no_active_plan', 'something_new']), [
      'There is no live operational plan for this project.',
      'something_new',
    ]);
  });

  test('billing mode is deliberately absent, and the reason is written down', () => {
    assert.doesNotMatch(door('pre_kickoff_readiness'), /billing_profiles|billing_mode/);
    assert.match(PROSE, /adding it would be a second lock on\s+the same door rather than a new one/);
  });

  test('payment is reused from start_readiness, never re-derived', () => {
    // `advance_verified` already follows verified_minor rather than
    // paid_minor (G-007) — Finance §6's "proof never auto-verifies". A second
    // query here could quietly use the wrong one.
    const fn = door('pre_kickoff_readiness');
    assert.match(fn, /from projects\.start_readiness\(p_project_id\)/);
    assert.doesNotMatch(fn, /verified_minor|paid_minor|finance\.invoices/);
  });

  test('the three items the kickoff itself settles cannot block it', () => {
    assert.match(
      door('pre_kickoff_readiness'),
      /oi\.key not in \('kickoff_sent', 'project_activated', 'whatsapp_group_mapped'\)/,
    );
    assert.match(PROSE, /A gate demanding them would never open/);
  });

  test('a project with NO checklist fails the onboarding gate', () => {
    // `not exists (... pending)` alone is true for a project that was never
    // onboarded at all — the absence-only shape. Found by driving it.
    const fn = door('pre_kickoff_readiness');
    assert.match(fn, /exists \(select 1 from projects\.onboarding_items oi where oi\.project_id = p_project_id\)\s*\n\s*and not exists \(/);
    assert.match(PROSE, /a project nobody ever onboarded would sail through the gate that exists to check it was/);
  });

  test('the group gate is required only when a card was raised', () => {
    // §5.10 says "WhatsApp mapping IF REQUIRED". A project whose Phase 2 began
    // before the card existed cannot produce a state nothing can set.
    const fn = door('pre_kickoff_readiness');
    assert.match(fn, /select coalesce\(\s*\n\s*\(select gs\.state in \('mapped', 'verified'\)[\s\S]{0,140}\n\s*true\s*\n\s*\)/);
  });

  test('the gaps come back, not a bare no', () => {
    assert.match(door('pre_kickoff_readiness'), /unmet\s+text\[\]/);
    assert.match(PROSE, /a gate that says no\s+without saying which is a gate somebody has to go and investigate/);
  });
});

describe('B. there is no override, and no open-question gate', () => {
  test('the kickoff door has no override argument at all', () => {
    const signature = SQL.slice(
      SQL.indexOf('create or replace function projects.record_kickoff'),
      SQL.indexOf('returns table', SQL.indexOf('create or replace function projects.record_kickoff')),
    );
    assert.doesNotMatch(signature, /override/i);
    assert.match(door('record_kickoff'), /if not v_ready\.ready then\s*\n\s*return query select 'not_ready'::text, v_ready\.unmet/);
    assert.match(PROSE, /An override\s+here would announce a kickoff to a client for a project that is not ready/);
  });

  test('the open-question gate was REMOVED because it could never fire', () => {
    // A clarification may only be raised against a draft plan, and G-257
    // refuses to activate a plan carrying one — so a count of open questions
    // on an ACTIVE plan is always zero. A gate that cannot fail reads as
    // protection and is not.
    assert.doesNotMatch(door('pre_kickoff_readiness'), /plan_clarifications/);
    assert.match(PROSE, /THERE IS DELIBERATELY NO OPEN-QUESTION GATE HERE/);
    assert.match(PROSE, /If clarifications are ever\s+made raisable against a live plan, this gate has to come back/);
  });
});

describe('C. it records a kickoff, it does not send one', () => {
  test('nothing here messages anybody', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|conversation_messages|whatsapp_templates/i);
    assert.doesNotMatch(KICKOFF, /sendMessage|dispatch/i);
  });

  test('the evidence is required, and refused before the lock', () => {
    const fn = door('record_kickoff');
    const refusal = fn.indexOf("'no_evidence'");
    const lock = fn.indexOf('for update;');
    assert.ok(refusal > 0 && lock > refusal);
    assert.match(PROSE, /a kickoff with no evidence would be this system claiming a client was told/);
    assert.match(KICKOFF, /Paste the message reference, so the kickoff has evidence behind it/);
  });

  test('and the blockers say so where a person reads them', () => {
    assert.match(SQL, /BLK-003/);
    assert.match(SQL, /BLK-007/);
  });

  test('a person records it — an unattended process cannot', () => {
    assert.match(door('record_kickoff'), /if v_actor is null then\s*\n\s*return query select 'needs_person'/);
    assert.match(SQL, /grant execute on function projects\.record_kickoff\(uuid, text\) to authenticated;/);
    assert.doesNotMatch(SQL, /grant execute on function projects\.record_kickoff\(uuid, text\) to authenticated, service_role/);
  });
});

describe('D. one path to ACTIVE, and both facts recorded', () => {
  test('the status write goes through start_project, not an update here', () => {
    const fn = door('record_kickoff');
    assert.match(fn, /from projects\.start_project\(v_project\.id, null\)/);
    assert.doesNotMatch(fn, /update projects\.projects/);
    assert.match(PROSE, /a second way for a project to become active is\s+a second set of conditions to keep honest/);
  });

  test('and it surfaces start_project’s own refusal rather than swallowing it', () => {
    // ADM-13's conditions are not §5.10's. A project can pass this gate and
    // still be refused ACTIVE, and the caller is told which condition.
    const fn = door('record_kickoff');
    assert.match(fn, /if v_started\.outcome not in \('started', 'already_active'\) then/);
    assert.match(fn, /return query select 'project_would_not_start'::text, coalesce\(v_started\.unmet/);
    assert.match(KICKOFF, /case 'project_would_not_start':/);
  });

  test('the message going out and the phase closing are two facts', () => {
    const fn = door('record_kickoff');
    assert.match(fn, /set state = 'kickoff_sent', kickoff_at = now\(\)/);
    assert.match(fn, /set state = 'completed', completed_at = now\(\)/);
    assert.match(PROSE, /different facts even when they are one\s+second apart/);
  });

  test('a completed phase cannot be kicked off twice', () => {
    assert.match(door('record_kickoff'), /if v_phase\.state = 'completed' then\s*\n\s*return query select 'already_done'/);
  });

  test('a project that never started Phase 2 cannot complete it', () => {
    assert.match(door('record_kickoff'), /return query select 'no_phase_two'/);
    assert.match(PROSE, /announcing the end of something that never\s+began/);
  });
});

describe('E. the handoff out, and the discipline', () => {
  test('both events are declared before they are emitted', () => {
    for (const type of ['project.phase_two_completed', 'project.phase_three_ready']) {
      assert.match(SQL, new RegExp(`\\('${type.replace(/\./g, '\\.')}'`), `${type} is not declared`);
      assert.match(SQL, new RegExp(`emit_event\\([\\s\\S]{0,160}'${type.replace(/\./g, '\\.')}'`), `${type} is never emitted`);
    }
    const declaration = SQL.slice(SQL.indexOf('into core.event_types'), SQL.indexOf('on conflict (type)'));
    assert.equal(declaration.includes(';'), false, 'a semicolon here hides the later declarations');
  });

  test('Phase3Ready having no subscriber is the design, and says so', () => {
    assert.match(PROSE, /the same shape Phase 1 shipped `opportunity\.handed_off` in/);
  });

  test('both doors are revoked from the world', () => {
    for (const sig of ['pre_kickoff_readiness\\(uuid\\)', 'record_kickoff\\(uuid, text\\)']) {
      assert.match(SQL, new RegExp(`revoke all on function projects\\.${sig} from public`));
    }
  });

  test('the readiness read refuses to guess from a failed query', () => {
    assert.match(KICKOFF, /if \(error\) return err\('INTERNAL', 'Could not read the kickoff readiness\.'\)/);
    assert.match(KICKOFF.replace(/\n\s*\/\/ ?/g, ' '), /Neither claim is safe to make from a dropped connection/);
  });

  test('no migration writes a project status directly', () => {
    assert.doesNotMatch(SQL, /update projects\.projects\s+set status/);
  });
});
