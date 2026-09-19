import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reviseGroupSetupSchema, groupMemberSchema } from '../src/modules/projects/schema.ts';
import { region } from './_region.ts';

/**
 * The group is a manual action — Master §5.5, §6, §9; PM §4.4, PM-04, §8.
 *
 * The specification's own line is *"do not claim official automatic group
 * creation unless a future supported provider capability actually exists"*.
 * On this deployment that is not a caution: Meta answered **#131215, "This
 * phone number is not eligible to access Groups APIs"** on this WABA, and
 * ADM-95 recorded it. So the assertions worth making are that nothing here
 * pretends otherwise, that the person who did the work is named, and that the
 * snapshot of who was in the group cannot be rewritten afterwards.
 *
 * The behaviour of the doors themselves is proven where SQL runs — on a
 * scratch Postgres, driven through psql, with the cross-project guard removed
 * to watch one project's card map to another project's group. A regex cannot
 * do that, and these tests do not pretend to.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917120000_the_group_is_a_manual_action.sql');
const SERVICE = read('src/modules/projects/service.ts');
const HANDLERS = read('src/modules/projects/handlers.ts');
/** The migration's prose with its comment markers folded away. */
const PROSE = MIGRATION.replace(/\n--\s?/g, ' ');
/** The SQL alone, so an assertion about the code cannot be satisfied by a comment. */
const SQL = MIGRATION.replace(/^--.*$/gm, '');
/** Just this unit's service functions. */
const GROUP_SERVICE = region(SERVICE, 'The WhatsApp group manual action — Master §5.5', 'The internal team roster');

const fn = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. nothing claims to create a group', () => {
  test('no provider call, no group-creation API, anywhere in the unit', () => {
    for (const [name, text] of [['migration', SQL], ['service', GROUP_SERVICE]] as const) {
      assert.doesNotMatch(text, /graph\.facebook|\/groups|create_group|createGroup|groups_api/i, `${name} reaches for a Groups API`);
    }
  });

  test('the reason is recorded where the next reader will be, not left to memory', () => {
    assert.match(PROSE, /131215/);
    assert.match(PROSE, /ADM-95/);
    assert.match(PROSE, /a person opens WhatsApp, makes the group, adds the members/);
  });

  test('no capability interface was invented for a capability that does not exist', () => {
    // §6 asks for future-proofing. An interface with one implementation and no
    // second candidate is a guess about a provider that has refused.
    assert.doesNotMatch(SQL, /provider_capability|group_provider/i);
    assert.match(PROSE, /an interface with one implementation and no second candidate is a guess/);
  });
});

describe('B. the person who did it is named', () => {
  test('confirm, map and verify all refuse an unattended process', () => {
    for (const name of ['confirm_group_created', 'map_group', 'verify_group']) {
      assert.match(fn(name), /if v_actor is null then\s*\n\s*return query select 'needs_person'/, `${name} lets nobody witness it`);
    }
  });

  test('raising the card does NOT — it is the one step no person has to take', () => {
    // PM-04 is the agent's work: prepare the card. The service role may do it,
    // and a Phase 2 that waited for a human to ask for a human's task would
    // wait forever.
    assert.match(fn('request_group_setup'), /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role'/);
  });

  test('each state records who and when', () => {
    for (const column of ['confirmed_by', 'mapped_by', 'verified_by']) {
      assert.match(SQL, new RegExp(`${column}\\s+uuid references core\\.users\\(id\\)`), `${column} is not a person`);
    }
    // A state without its moment is half a state change.
    assert.match(SQL, /\(state in \('created', 'mapped', 'verified'\)\) = \(created_at_whatsapp is not null\)/);
    assert.match(SQL, /\(state in \('mapped', 'verified'\)\) = \(mapped_at is not null\)/);
    assert.match(SQL, /\(state = 'verified'\) = \(verified_at is not null\)/);
  });

  test('only the four states Master §9 names, and no fifth', () => {
    const states = /state\s+text not null default 'pending' check \(state in\s*\n?\s*\('pending', 'created', 'mapped', 'verified'\)\)/;
    assert.match(SQL, states);
  });
});

describe('C. the snapshot is a record, and stops being a plan', () => {
  test('it is copied out of the roster, not joined to it', () => {
    // PM §8: changing the global defaults later must not rewrite history.
    assert.match(fn('request_group_setup'), /from projects\.group_team_defaults d/);
    assert.match(SQL, /members\s+jsonb not null default '\[\]'::jsonb/);
    assert.match(PROSE, /Here the SNAPSHOT is the fact/);
  });

  test('only active roster members are preselected, and client contacts join them', () => {
    const door = fn('request_group_setup');
    assert.match(door, /and d\.active/);
    assert.match(door, /'kind', 'internal'/);
    assert.match(door, /'kind', 'client'/);
    assert.match(door, /c\.phone is not null/, 'a member with no number cannot be added to a WhatsApp group');
  });

  test('once the group exists, the members and the name freeze', () => {
    const freeze = fn('freeze_group_snapshot');
    assert.match(freeze, /old\.state <> 'pending' and new\.members is distinct from old\.members/);
    assert.match(freeze, /old\.state <> 'pending' and new\.suggested_name is distinct from old\.suggested_name/);
    assert.match(SQL, /create trigger freeze_group_snapshot\s*\n\s*before update on projects\.group_setups/);
  });

  test('and the door refuses the same thing at the front', () => {
    // Two layers, and the test asserts both — a rule held by one layer and
    // tested through the other is half a check.
    assert.match(fn('revise_group_setup'), /if v_row\.state <> 'pending' then\s*\n\s*return query select 'not_pending'/);
  });

  test('a name is offered only when it is whole', () => {
    // G-188 composes §5.5's exact name and names what is missing instead of
    // assembling a title around an invented price.
    assert.match(fn('request_group_setup'), /from crm\.project_group_title\(v_project\.id\) t/);
    assert.match(SQL, /suggested_name_missing text\[\] not null default '\{\}'/);
    assert.doesNotMatch(fn('request_group_setup'), /coalesce\(v_title\.title,\s*'/, 'a fallback title is an invented one');
  });
});

describe('D. a card cannot be mapped to the wrong group', () => {
  test('the conversation must be this project’s, and a project group', () => {
    const door = fn('map_group');
    assert.match(door, /v_conv\.project_id is distinct from v_row\.project_id/);
    assert.match(door, /v_conv\.kind is distinct from 'project_group'/);
    assert.match(door, /return query select 'wrong_project'/);
  });

  test('the service names that mistake rather than hiding it in NOT_FOUND', () => {
    assert.match(GROUP_SERVICE, /case 'wrong_project':/);
    assert.match(GROUP_SERVICE, /That conversation is not this project’s group/);
    assert.match(GROUP_SERVICE, /would send one client’s invoices to another client’s group|send one client's invoices/);
  });

  test('the ladder cannot be skipped', () => {
    assert.match(fn('map_group'), /if v_row\.state = 'pending' then\s*\n\s*return query select 'not_created'/);
    assert.match(fn('verify_group'), /if v_row\.state <> 'mapped' then\s*\n\s*return query select 'not_mapped'/);
  });

  test('one card per project, as a constraint rather than a check', () => {
    assert.match(SQL, /project_id\s+uuid not null unique references projects\.projects\(id\)/);
    assert.match(fn('request_group_setup'), /for update;/);
  });
});

describe('E. the tenancy discipline every org-scoped table here carries', () => {
  test('both new tables carry it', () => {
    assert.match(SQL, /enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /enforce_parent_org\('conversation_id', 'crm\.conversations'\)/);
    assert.match(SQL, /freeze_org_group_setups/);
    assert.match(SQL, /freeze_org_group_team_defaults/);
    for (const table of ['projects.group_setups', 'projects.group_team_defaults']) {
      assert.match(SQL, new RegExp(`alter table ${table.replace('.', '\\.')} enable row level security`));
      assert.match(SQL, new RegExp(`alter table ${table.replace('.', '\\.')} force row level security`));
    }
  });

  test('a client reads neither the agency’s task nor the agency’s phone numbers', () => {
    for (const policy of ['group_setups_select', 'group_team_defaults_select']) {
      const start = SQL.indexOf(`create policy ${policy}`);
      assert.ok(start > 0, `${policy} is missing`);
      assert.match(SQL.slice(start, start + 400), /core\.is_internal\(\)/);
    }
  });

  test('the doors are not callable by the world', () => {
    for (const name of ['request_group_setup(uuid)', 'revise_group_setup(uuid, text, jsonb)', 'map_group(uuid, uuid)']) {
      assert.match(SQL, new RegExp(`revoke all on function projects\\.${name.replace(/[().,]/g, (c) => `\\${c}`)} from public`));
    }
    // The three a person must perform are not granted to the service role at
    // all — the refusal in the function body has a matching grant.
    assert.match(SQL, /grant execute on function projects\.confirm_group_created\(uuid, text\) to authenticated;/);
    assert.doesNotMatch(SQL, /grant execute on function projects\.confirm_group_created\(uuid, text\) to authenticated, service_role/);
  });
});

describe('F. it is wired, and raising it contacts nobody', () => {
  test('Phase 2 starting raises the card, best-effort', () => {
    assert.match(HANDLERS, /const card = await requestGroupSetup\(projectId, admin as never\)/);
    const branch = HANDLERS.slice(HANDLERS.indexOf("case 'started':"), HANDLERS.indexOf("case 'no_handoff':"));
    assert.match(branch, /status: 'succeeded'/);
    assert.doesNotMatch(branch, /status: 'failed'/, 'a card that could not be raised must not unstart the phase');
    assert.match(HANDLERS, /The WhatsApp group setup card could not be raised/);
  });

  test('neither the migration nor the handler sends a message', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|conversation_messages/i);
    assert.match(PROSE, /Nothing in this migration calls a provider/);
  });

  test('both of Master §9’s events are declared before they are emitted', () => {
    for (const type of ['project.group_setup_required', 'project.group_mapped']) {
      assert.match(SQL, new RegExp(`\\('${type.replace('.', '\\.')}'`), `${type} is not declared`);
      assert.match(SQL, new RegExp(`emit_event\\([\\s\\S]{0,120}'${type.replace('.', '\\.')}'`), `${type} is declared and never emitted`);
    }
  });
});

describe('G. the card refuses a revision that revises nothing', () => {
  test('a name or members — not neither', () => {
    assert.equal(reviseGroupSetupSchema.safeParse({ setupId: crypto.randomUUID() }).success, false);
    assert.equal(
      reviseGroupSetupSchema.safeParse({ setupId: crypto.randomUUID(), suggestedName: 'A // B' }).success,
      true,
    );
  });

  test('a number that is not a number is refused before the write, not by it', () => {
    assert.equal(groupMemberSchema.safeParse({ name: 'A', phone: 'call me', kind: 'internal' }).success, false);
    assert.equal(groupMemberSchema.safeParse({ name: 'A', phone: '+918058054102', kind: 'internal' }).success, true);
    assert.equal(groupMemberSchema.safeParse({ name: 'A', phone: '918058054102', kind: 'client' }).success, true);
  });

  test('and the database validates the same shape, so a direct write cannot dodge it', () => {
    assert.match(SQL, /phone\s+text not null check \(phone ~ '\^\\\+\?\[0-9\]\{6,20\}\$'\)/);
  });
});
