// Phase 4 UI Designer / Prototype gap work: the shape that keeps it safe, read from the files. These are text checks and say so: what the doors DO is proved on a
// real Postgres by scripts/verify-p4ui-ui-designer.sql and scripts/verify-p4ui-prototype.sql (and red-proved by scripts/redproof-p4ui.py).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { DESIGNER_ACTIVATION_REASONS } from '../src/modules/orchestrator/designer-activation.ts';
import { CLIENT_FEEDBACK_CLASSIFICATIONS } from '../src/modules/projects/schema.ts';
import { P4UI_BUILD_MODES, P4UI_DEVICES, P4UI_ENVIRONMENTS, P4UI_PLATFORMS, P4UI_SCREEN_STATES } from '../src/modules/projects/p4ui.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const migDir = join(root, 'supabase/migrations');
const pick = (prefix: string) => {
  const f = readdirSync(migDir).filter((n) => n.startsWith(prefix));
  assert.equal(f.length, 1, `exactly one migration starts with ${prefix}`);
  return read(`supabase/migrations/${f[0]}`);
};
const UI = pick('20261125000000_p4ui_');
const PROTO = pick('20261125100000_p4ui_');
const BOTH = UI + '\n' + PROTO;

const quoted = (list: string) => [...list.matchAll(/'([A-Za-z_0-9]+)'/g)].map((m) => m[1] ?? '');
/** The quoted values of the first `col ... check (col in (...))` or `col <@ array[...]` that follows `anchor`, bounded by the closing paren/bracket. */
function checkList(sql: string, anchor: RegExp): string[] {
  const m = anchor.exec(sql);
  assert.ok(m, `anchor ${anchor} not found`);
  return quoted(m[1] ?? '');
}

describe('the vocabularies the model answers in mirror the database', () => {
  test('screen states and devices', () => {
    assert.deepEqual(checkList(UI, /states <@ array\[([^\]]*)\]/), [...P4UI_SCREEN_STATES]);
    assert.deepEqual(checkList(UI, /responsive_variants <@ array\[([^\]]*)\]/), [...P4UI_DEVICES]);
  });
  test('platforms, build modes and environments', () => {
    assert.deepEqual(checkList(PROTO, /platform\s+text check \(platform is null or platform in \(([^)]*)\)/), [...P4UI_PLATFORMS]);
    assert.deepEqual(checkList(PROTO, /build_mode\s+text not null default 'in_app_preview' check \(build_mode in \(([^)]*)\)/), [...P4UI_BUILD_MODES]);
    assert.deepEqual(checkList(PROTO, /environment\s+text not null default 'review' check \(environment in \(([^)]*)\)/), [...P4UI_ENVIRONMENTS]);
  });
  test('the seven activation reasons are designer-activation.ts\'s own', () => {
    assert.deepEqual(checkList(UI, /create table if not exists projects\.p4ui_design_jobs[\s\S]*?activation_reason\s+text check \(activation_reason in \(([^)]*)\)/).sort(), [...DESIGNER_ACTIVATION_REASONS].sort());
  });
  test('the six feedback classifications are the PM classifier\'s own', () => {
    assert.deepEqual(checkList(UI, /p4ui_feedback_routes \([\s\S]*?classification\s+text not null check \(classification in \(([^)]*)\)/).sort(), [...CLIENT_FEEDBACK_CLASSIFICATIONS].sort());
    assert.deepEqual(checkList(PROTO, /p4ui_prototype_feedback_routes \([\s\S]*?classification\s+text not null check \(classification in \(([^)]*)\)/).sort(), [...CLIENT_FEEDBACK_CLASSIFICATIONS].sort());
  });
});

describe('every new table is org-scoped, internal-read, and written only through a door', () => {
  const tables = [...BOTH.matchAll(/create table if not exists projects\.(p4ui_[a-z_]+)/g)].map((m) => m[1] ?? '');
  test('seventeen tables', () => assert.equal(tables.length, 17));
  for (const t of tables) {
    test(`${t}: freeze + RLS + select-only grant`, () => {
      const loops = BOTH.match(/foreach t in array array\[([^\]]*)\]/g)?.join('\n') ?? '';
      assert.ok(loops.includes(`'${t}'`), `${t} is in a freeze/RLS loop`);
      assert.match(BOTH, new RegExp(`'${t}',\\s*'project_id',\\s*'projects\\.projects'`), `${t} has a project parent-org guard`);
      assert.doesNotMatch(BOTH, new RegExp(`grant\\s+(insert|update|delete)[^;]*projects\\.${t}\\b`, 'i'));
      assert.match(t, /^p4ui_/);
    });
  }
  test('RLS is enabled, forced, and the only policy is an internal select', () => {
    assert.equal((BOTH.match(/alter table projects\.%I enable row level security/g) ?? []).length, 2);
    assert.equal((BOTH.match(/alter table projects\.%I force row level security/g) ?? []).length, 2);
    assert.equal((BOTH.match(/create policy %I on projects\.%I for select to authenticated using \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)\)/g) ?? []).length, 2);
    assert.doesNotMatch(BOTH, /create policy[^;]*for (insert|update|delete|all)/i);
  });
  test('the two append-only/immutable records refuse update and delete by trigger', () => {
    assert.match(UI, /create trigger p4ui_revisions_append_only before update or delete on projects\.p4ui_revisions/);
    assert.match(PROTO, /create trigger p4ui_prototype_revisions_append_only before update or delete on projects\.p4ui_prototype_revisions/);
    assert.match(PROTO, /create trigger p4ui_qa_handoffs_immutable before update or delete on projects\.p4ui_qa_handoffs/);
  });
});

describe('every door is SECURITY DEFINER with an empty search_path, revoked from public, and starts at the caller check', () => {
  const fnRe = /create or replace function projects\.(p4ui_[a-z_]+)\(([\s\S]*?)\)\s*returns[\s\S]*?\n(?:end \$\$;|\$\$;)\n/g;
  const fns = [...BOTH.matchAll(fnRe)].map((m) => ({ name: m[1] ?? '', text: m[0] }));
  test('the functions were found', () => assert.equal(fns.length, (BOTH.match(/create or replace function projects\.p4ui_/g) ?? []).length));
  const doors = fns.filter((f) => /\bsecurity definer\b/.test(f.text));
  test('definer doors', () => assert.ok(doors.length >= 30));
  for (const f of doors) {
    test(`${f.name}`, () => {
      assert.match(f.text, /set search_path = ''/);
      assert.match(BOTH, new RegExp(`revoke all on function projects\\.${f.name}\\([^)]*\\) from public, anon;`));
      if (f.name !== 'p4ui_prototype_client_notice') assert.match(f.text, /projects\.p4ui_caller\(/, 'every door asks who is calling');
    });
  }
  test('the doors an agent must not use are not granted to service_role beyond the refusal path', () => {
    // each of these answers person_required / admin_required to the service role; the grant exists so the answer is a value, not a permission error
    for (const name of ['p4ui_resolve_design_blocker', 'p4ui_decide_post_lock_revision', 'p4ui_confirm_prototype_design_issue', 'p4ui_record_figma_refs', 'p4ui_resolve_prototype_blocker']) {
      const f = fns.find((x) => x.name === name);
      assert.ok(f, name);
      assert.match(f.text, /person_required|admin_required/, `${name} refuses the service role by value`);
    }
  });
});

describe('nothing here reaches another gate', () => {
  test('no update of the UI version, deliverable, artifact or approval rows, and no money', () => {
    assert.doesNotMatch(BOTH, /update\s+projects\.(ui_versions|deliverables|deliverable_details|prototype_artifacts)\b/i);
    assert.doesNotMatch(BOTH, /(insert into|update|delete from)\s+approvals\./i);
    assert.doesNotMatch(BOTH, /\bfinance\./i);
    assert.doesNotMatch(BOTH, /session_replication_role/i);
  });
  test('the only writer of a new UI version is the governed post-lock door, and it needs a job of the two post-lock reasons', () => {
    assert.equal((BOTH.match(/insert into projects\.ui_versions/g) ?? []).length, 1);
    assert.match(UI, /v_j\.activation_reason not in \('approved_scope_change', 'source_ui_design_defect'\)/);
  });
  test('post-QA build states exist only behind the real rows', () => {
    for (const s of ['qa_pass', 'qa_changes_required', 'admin_approved', 'client_review', 'changes_requested', 'locked']) {
      assert.match(PROTO, new RegExp(`new\\.status in \\([^)]*'${s}'`), `${s} is gated in the transition trigger`);
    }
  });
  test('events are declared with names the vocabulary test can read (letters and underscores only)', () => {
    const types = [...BOTH.matchAll(/\('(project\.[a-z_]+)',\s*\n/g)].map((m) => m[1] ?? '');
    assert.equal(types.length, 7);
    for (const t of types) assert.match(t, /^project\.[a-z_]+$/);
    const emitted = [...BOTH.matchAll(/emit_event\([^,]+,\s*'(project\.[a-z_]+)'/g)].map((m) => m[1] ?? '');
    for (const e of emitted) assert.ok(types.includes(e) || e === 'project.ui_version_drafted', `${e} is declared or pre-existing`);
  });
});

describe('the TypeScript side', () => {
  test('the server-action file exports only async functions', () => {
    const src = read('src/modules/projects/p4ui-actions.ts');
    assert.match(src, /^'use server';/);
    const exports = src.match(/^export .*/gm) ?? [];
    assert.ok(exports.length >= 8);
    for (const e of exports) assert.match(e, /^export async function \w+\(/, e);
  });
  test('every read in the query module is checked: one unreadable() per error branch, none in comments', () => {
    const src = read('src/modules/projects/p4ui-queries.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const calls = (code.match(/\bunreadable\(/g) ?? []).length;
    const guarded = (code.match(/if \([\w.]*[eE]rr\w*\) unreadable\(/g) ?? []).length;
    assert.ok(calls >= 20, `${calls} unreadable calls`);
    assert.equal(calls, guarded, 'every unreadable() sits behind an if (error) guard');
    assert.equal((src.match(/unreadable\(/g) ?? []).length, calls, 'no comment mentions unreadable( (the read-failure meta-test counts comments too)');
    assert.equal((src.match(/if \([\w.]*[eE]rr\w*\)/g) ?? []).length, guarded, 'nor an if (error) guard');
    const reads = (code.match(/\.(from|rpc)\(/g) ?? []).length;
    assert.equal(calls, reads, `${reads} reads, ${calls} checks`);
  });
  test('the workflows are drafting work and the lead wired them into the shared lists', () => {
    const wf = read('app/api/jobs/run/p4ui-workflows.ts');
    assert.equal((wf.match(/workClass: 'draft'/g) ?? []).length, 1);
    assert.doesNotMatch(wf, /\bapprove|verdict|lock_ui_version|decide_/);
    assert.match(read('app/api/jobs/run/workflows.ts'), /\.\.\.P4UI_WORKFLOWS/);
    assert.match(read('src/lib/events/catalog.ts'), /'projects:attachP4uiBuild': 'p4ui\.attach_build'/);
    assert.match(read('src/lib/events/catalog.ts'), /'ui_prototype:planBuild': 'prototype\.plan'/);
  });
});
