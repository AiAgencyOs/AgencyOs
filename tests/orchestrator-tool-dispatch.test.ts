import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENT_DEFINITIONS } from '../src/modules/agents/registry.ts';
import {
  checkToolDispatch,
  DISPATCH_DENIAL_CODES,
  pathWithinScope,
  TOOL_CATALOG,
  type DispatchDenial,
  type DispatchScope,
} from '../src/modules/orchestrator/tool-dispatch.ts';

/**
 * The tool permission and dispatchability gate - Orchestrator spec 14. Pure: nothing here executes a tool.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const PROJECT = '5b1f1f0e-7f0a-4c6e-9d0b-0a1b2c3d4e5f';
const OTHER_PROJECT = '6c2a2a1f-8a1b-4d7f-8e1c-1b2c3d4e5f60';
const scope: DispatchScope = { projectId: PROJECT, mode: 'read_write', filePaths: ['src/ui/**'] };
const ALL = TOOL_CATALOG.map((t) => t.name);

function dispatch(over: Partial<Parameters<typeof checkToolDispatch>[0]> & { tool: string; args: unknown }) {
  return checkToolDispatch({ agent: 'frontend_developer', scope, risk: 'low', boundTools: ALL, ...over });
}
function denied(over: Partial<Parameters<typeof checkToolDispatch>[0]> & { tool: string; args: unknown }): DispatchDenial {
  const result = dispatch(over);
  assert.equal(result.allowed, false, `expected a denial for ${over.tool}`);
  return result as DispatchDenial;
}

describe('A. every denial has a code, and the order of the checks', () => {
  test('an unregistered agent is denied unknown_agent', () => {
    assert.equal(denied({ agent: 'made_up_agent', tool: 'read_file', args: { path: 'src/ui/a.ts' } }).code, 'unknown_agent');
  });
  test('an unregistered tool is denied unknown_tool', () => {
    assert.equal(denied({ tool: 'format_disk', args: {} }).code, 'unknown_tool');
  });
  test('a tool the agent is not bound to is denied tool_not_bound even though it exists', () => {
    assert.equal(denied({ boundTools: ['read_file'], tool: 'write_file', args: { path: 'src/ui/a.ts', content: 'x' } }).code, 'tool_not_bound');
  });
  test('a write tool in a read-only dispatch is denied write_not_permitted', () => {
    assert.equal(denied({ scope: { ...scope, mode: 'read_only' }, tool: 'write_file', args: { path: 'src/ui/a.ts', content: 'x' } }).code, 'write_not_permitted');
  });
  test('arguments that fail the tool schema are denied invalid_args, including unknown extra keys', () => {
    assert.equal(denied({ tool: 'write_file', args: { path: 'src/ui/a.ts' } }).code, 'invalid_args');
    assert.equal(denied({ tool: 'read_file', args: { path: 'src/ui/a.ts', sneaky: true } }).code, 'invalid_args');
    assert.equal(denied({ tool: 'read_file', args: 'src/ui/a.ts' }).code, 'invalid_args');
  });
  test('a write outside the leased files is denied out_of_scope', () => {
    assert.equal(denied({ tool: 'write_file', args: { path: 'src/api/a.ts', content: 'x' } }).code, 'out_of_scope');
    assert.equal(denied({ tool: 'write_file', args: { path: 'src/uikit/a.ts', content: 'x' } }).code, 'out_of_scope', 'src/uikit is not inside src/ui');
  });
  test('a path that climbs out, names a pattern, or is a credential is denied out_of_scope even for a read', () => {
    for (const bad of ['../secrets.txt', 'src/ui/../../etc/passwd', 'src/ui/*.ts', '.env.local', 'src/ui/.env', '.git/config', 'keys/server.pem']) {
      assert.equal(denied({ tool: 'read_file', args: { path: bad } }).code, 'out_of_scope', bad);
    }
  });
  test('a tool that names another project is denied out_of_scope', () => {
    assert.equal(denied({ tool: 'open_pull_request', approved: true, args: { project_id: OTHER_PROJECT, title: 't', branch: 'b' } }).code, 'out_of_scope');
  });
  test('a high-risk tool is denied approval_required without an approval, and allowed with one', () => {
    assert.equal(denied({ tool: 'delete_file', args: { path: 'src/ui/a.ts' } }).code, 'approval_required');
    assert.equal(denied({ tool: 'delete_file', approved: false, args: { path: 'src/ui/a.ts' } }).code, 'approval_required');
    assert.equal(dispatch({ tool: 'delete_file', approved: true, args: { path: 'src/ui/a.ts' } }).allowed, true);
  });
  test('a write under a high or critical task needs approval even when the tool is not high-risk', () => {
    assert.equal(denied({ risk: 'high', tool: 'write_file', args: { path: 'src/ui/a.ts', content: 'x' } }).code, 'approval_required');
    assert.equal(denied({ risk: 'critical', tool: 'apply_patch', args: { path: 'src/ui/a.ts', patch: 'p' } }).code, 'approval_required');
    assert.equal(dispatch({ risk: 'high', tool: 'read_file', args: { path: 'src/ui/a.ts' } }).allowed, true, 'a read under a high-risk task is not a write');
  });
  test('every code a denial can carry is in the published list, and the SQL door accepts exactly that list', () => {
    const sql = read('supabase/migrations/20261102100000_two_agents_do_not_hold_the_same_files_and_a_refused_tool_call_is_audited.sql');
    const start = sql.indexOf('create or replace function projects.record_tool_dispatch_denial');
    assert.ok(start >= 0);
    const open = sql.indexOf('p_code not in (', start);
    assert.ok(open > start);
    const close = sql.indexOf(')', open);
    const inSql = [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...inSql].sort(), [...DISPATCH_DENIAL_CODES].sort());
  });
});

describe('B. the allowed path', () => {
  test('a bound read inside the repository is allowed and returns the parsed arguments', () => {
    const result = dispatch({ tool: 'read_file', args: { path: 'src/ui/a.ts' } });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.allowed && result.args, { path: 'src/ui/a.ts' });
  });
  test('a bound write inside the leased files is allowed', () => {
    assert.equal(dispatch({ tool: 'write_file', args: { path: 'src/ui/deep/a.tsx', content: 'x' } }).allowed, true);
  });
  test('an optional path that is absent is not checked', () => {
    assert.equal(dispatch({ tool: 'search_code', args: { query: 'foo' } }).allowed, true);
  });
  test('pathWithinScope: a directory holds its children and not a sibling with the same prefix', () => {
    assert.equal(pathWithinScope('src/ui/a.ts', ['src/ui/**']), true);
    assert.equal(pathWithinScope('src/ui', ['src/ui']), true);
    assert.equal(pathWithinScope('src/uikit/a.ts', ['src/ui']), false);
  });
});

describe('C. against the real registry', () => {
  test('a call is allowed only for a tool the agent definition lists: today no specialist holds one, so every call is denied tool_not_bound', () => {
    for (const def of AGENT_DEFINITIONS) {
      for (const tool of TOOL_CATALOG) {
        const result = checkToolDispatch({ agent: def.key, tool: tool.name, args: { path: 'src/ui/a.ts', content: 'x', patch: 'p', query: 'q', title: 't', branch: 'b', project_id: PROJECT }, scope, risk: 'low', approved: true });
        if (def.tools.includes(tool.name)) continue; // the day a tool is bound this is the line that stops being vacuous
        assert.equal(result.allowed, false, `${def.key} / ${tool.name}`);
        assert.equal(!result.allowed && result.code, 'tool_not_bound', `${def.key} / ${tool.name}`);
      }
    }
  });
});

describe('D. the denial carries its own audit, with argument names and never values', () => {
  test('audit parameters match the door and hold only the keys', () => {
    const secretish = ['value', 'that', 'must', 'not', 'leak'].join('-');
    const denial = denied({ tool: 'write_file', args: { path: 'src/api/a.ts', content: secretish } });
    assert.equal(denial.audit.p_project_id, PROJECT);
    assert.equal(denial.audit.p_agent_key, 'frontend_developer');
    assert.equal(denial.audit.p_tool, 'write_file');
    assert.equal(denial.audit.p_code, 'out_of_scope');
    assert.deepEqual(denial.audit.p_arg_keys, ['path', 'content']);
    assert.equal(JSON.stringify(denial.audit).includes(secretish), false, 'no argument value appears in the audit parameters');
    assert.ok(denial.audit.p_detail.length > 0 && denial.audit.p_detail.length <= 300);
  });

  test('the service writes a denial through projects.record_tool_dispatch_denial', () => {
    const service = read('src/modules/orchestrator/orchestrator-service.ts');
    assert.match(service, /export function writeDispatchDenial/);
    assert.match(service, /'record_tool_dispatch_denial', \{ \.\.\.denial\.audit \}/);
    const sql = read('supabase/migrations/20261102100000_two_agents_do_not_hold_the_same_files_and_a_refused_tool_call_is_audited.sql');
    assert.match(sql, /perform core\.record_audit\(v_org, 'orchestrator\.tool_dispatch_denied'/);
    assert.match(sql, /grant execute on function projects\.record_tool_dispatch_denial\(uuid, text, text, text, text, text\[\]\) to service_role;/);
  });
});
