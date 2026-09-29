import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sqlCode } from './_code-only.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket F, stream F-A — the shared rules the PDF's sections 1–4 state and
 * the audit found partial or absent: the shell explains itself.
 *
 *   1. A URL that names nothing gets a not-found page inside the shell; the
 *      shell itself failing gets a global error boundary with a reference.
 *   2. /profile, /search and /help have a loading boundary like every other
 *      page.
 *   3. Every empty state on a list page offers a next step (an `action`).
 *   4. FilterBar has "Clear all"; DataTable has a per-row overflow menu and
 *      Leads and Invoices use it; approval decisions open in a drawer.
 *   5. Every LiveRefresh page carries the stale-data warning, because the
 *      control itself renders it.
 *   6. One IntegrationState callout, used by Integrations and Readiness.
 *   7. The breadcrumb shows from the tablet width and carries the entity
 *      level; the header carries a system-status dot fed by the readiness
 *      evaluator.
 *   8. No hand-rolled <table> is left on /agents/routing.
 *   9. The migration behind the stream keeps the tenancy conventions and
 *      audits its decisions.
 */

const INTERNAL = 'app/(internal)';

describe('1. not-found and global-error', () => {
  it('app/(internal)/not-found.tsx exists inside the shell and offers a way back', () => {
    const src = read(`${INTERNAL}/not-found.tsx`);
    assert.match(src, /<EmptyState/);
    assert.match(src, /href="\/dashboard"/);
    assert.match(src, /href="\/search"/);
    assert.doesNotMatch(src, /createClient|requireInternal/, 'a not-found page makes no read');
  });

  it('app/global-error.tsx renders its own document and shows the digest', () => {
    const src = read('app/global-error.tsx');
    assert.match(src, /^'use client';/);
    assert.match(src, /<html lang="en">/);
    assert.match(src, /<body/);
    assert.match(src, /error\.digest/);
    assert.match(src, /onClick=\{reset\}/);
    assert.doesNotMatch(src, /from '@\/ui'|from '@\/lib/, 'the last boundary imports nothing that could be the thing that broke');
  });
});

describe('2. loading boundaries', () => {
  for (const page of ['profile', 'search', 'help']) {
    it(`/${page} has loading.tsx`, () => {
      const p = `${INTERNAL}/${page}/loading.tsx`;
      assert.ok(existsSync(join(process.cwd(), p)), `${p} is missing`);
      assert.match(read(p), /SkeletonPage/);
    });
  }
});

/** The text of every `<EmptyState …/>` element in a source, nested JSX included. */
function emptyStates(source: string): string[] {
  const out: string[] = [];
  let i = source.indexOf('<EmptyState');
  while (i >= 0) {
    let depth = 0;
    let j = i;
    while (j < source.length) {
      if (source.startsWith('</', j)) {
        depth -= 1;
        j = source.indexOf('>', j) + 1;
        continue;
      }
      if (source.startsWith('/>', j)) {
        depth -= 1;
        if (depth === 0) break;
        j += 2;
        continue;
      }
      if (source[j] === '<' && /[A-Za-z>]/.test(source[j + 1] ?? '')) depth += 1;
      j += 1;
    }
    out.push(source.slice(i, j + 2));
    i = source.indexOf('<EmptyState', j);
  }
  return out;
}

describe('3. every empty state on a list page offers a next step', () => {
  const pages = readdirSync(join(process.cwd(), INTERNAL), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(process.cwd(), INTERNAL, d.name, 'page.tsx')))
    .map((d) => `${INTERNAL}/${d.name}/page.tsx`);

  it('the scan found the list pages', () => {
    assert.ok(pages.length >= 25, `only ${pages.length} pages found — the scan broke`);
  });

  let total = 0;
  for (const page of pages) {
    const states = emptyStates(read(page));
    total += states.length;
    for (const [n, tag] of states.entries()) {
      it(`${page} — empty state ${n + 1} passes an action`, () => {
        assert.match(tag, /\baction=\{/, `${tag.slice(0, 80)}… has no action`);
      });
    }
  }

  it('the scan found empty states to check', () => {
    assert.ok(total >= 25, `only ${total} empty states found — the scan broke`);
  });
});

describe('4. FilterBar, DataTable and the approvals drawer', () => {
  it('FilterBar renders "Clear all" from clearHref, only while filtered', () => {
    const src = read('src/ui/primitives/filter-bar.tsx');
    assert.match(src, /clearHref\?: string/);
    assert.match(src, /const showClear = clearHref !== undefined && \(filtered \?\? true\)/);
    assert.match(src, />\s*Clear all\s*</);
  });

  it('list pages pass clearHref', () => {
    for (const page of ['leads', 'invoices', 'projects', 'approvals', 'notifications', 'search']) {
      assert.match(read(`${INTERNAL}/${page}/page.tsx`), /<FilterBar clearHref=/, `${page} has no Clear all`);
    }
  });

  it('DataTable has a rowActions slot rendered through RowActionsMenu, on desktop and on the card', () => {
    const table = read('src/ui/primitives/table.tsx');
    assert.match(table, /rowActions\?: \(row: T\) => readonly RowAction\[\]/);
    assert.equal((table.match(/<RowActionsMenu actions=\{rowActions\(row\)\} \/>/g) ?? []).length, 2);
    const menu = read('src/ui/primitives/row-actions.tsx');
    assert.match(menu, /^'use client';/);
    assert.match(menu, /aria-haspopup="menu"/);
    assert.match(read('src/ui/index.ts'), /primitives\/row-actions/);
  });

  it('Leads and Invoices use the overflow menu', () => {
    assert.match(read(`${INTERNAL}/leads/page.tsx`), /rowActions=\{\(l\) => \[/);
    assert.match(read(`${INTERNAL}/invoices/page.tsx`), /rowActions=\{\(i\) => \[/);
  });

  it('approval decisions open in the drawer, through the same ApprovalDecisionForm', () => {
    const page = read(`${INTERNAL}/approvals/page.tsx`);
    assert.match(page, /<DecideInDrawer/);
    assert.doesNotMatch(page, /<ApprovalDecisionForm/, 'the queue row no longer inlines the form');
    const drawer = read(`${INTERNAL}/approvals/decide-drawer.tsx`);
    assert.match(drawer, /<Drawer/);
    assert.match(drawer, /<ApprovalDecisionForm requestId=\{requestId\}/);
  });
});

describe('5. the stale-data warning is wired to every LiveRefresh page', () => {
  it('LiveRefresh itself renders StaleDataWarning once the channel is not live and the page has not re-read', () => {
    const src = read('src/lib/realtime/live-refresh.tsx');
    assert.match(src, /export const STALE_AFTER_SECONDS = 120/);
    assert.match(src, /const stale = live\.status !== 'live' && live\.status !== 'connecting' && secondsAgo !== null && secondsAgo > STALE_AFTER_SECONDS/);
    assert.match(src, /<StaleDataWarning/);
  });

  it('so every page that mounts LiveRefresh has it', () => {
    const pages = readdirSync(join(process.cwd(), INTERNAL), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(process.cwd(), INTERNAL, d.name, 'page.tsx')))
      .map((d) => `${INTERNAL}/${d.name}/page.tsx`)
      .filter((p) => /<LiveRefresh/.test(read(p)));
    assert.ok(pages.length >= 10, `only ${pages.length} LiveRefresh pages found`);
    for (const p of pages) assert.match(read(p), /from '@\/lib\/realtime'/, p);
  });
});

describe('6. one IntegrationState callout', () => {
  it('is a @/ui primitive used by Integrations and Readiness', () => {
    assert.match(read('src/ui/index.ts'), /primitives\/integration-state/);
    const prim = read('src/ui/primitives/integration-state.tsx');
    assert.match(prim, /export function IntegrationState/);
    assert.match(prim, /UNKNOWN/, 'an unreadable provider is a state, never a green one');
    assert.match(read(`${INTERNAL}/integrations/page.tsx`), /<IntegrationState/);
    assert.match(read(`${INTERNAL}/production-readiness/page.tsx`), /<IntegrationState/);
  });
});

describe('7. the breadcrumb and the status dot', () => {
  it('the breadcrumb shows from md and carries the entity level', () => {
    const nav = read(`${INTERNAL}/nav.tsx`);
    assert.match(nav, /aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-\[12\.5px\] text-muted md:flex"/);
    assert.match(nav, /detailLabel \?\? 'Detail'/);
    assert.match(read(`${INTERNAL}/layout.tsx`), /<div className="hidden min-w-0 flex-1 md:block">\s*<HeaderTrail/);
  });

  it('the header dot is fed by the readiness evaluator after paint, and the layout still makes no read for it', () => {
    const layout = read(`${INTERNAL}/layout.tsx`);
    assert.match(layout, /<SystemStatusDot canOpen=/);
    const actions = read(`${INTERNAL}/system-status-actions.ts`);
    assert.match(actions, /^'use server';/);
    assert.match(actions, /getProductionReadiness\(\)/);
    assert.match(actions, /readinessSentence\(summary\)/);
    const dot = read(`${INTERNAL}/system-status.tsx`);
    assert.match(dot, /readSystemStatusAction\(\)/);
    assert.match(dot, /'bg-neutral-400'/, 'grey until the first answer, never green on its own say-so');
  });

  it('the organisation selector exists only for a person with more than one membership', () => {
    const layout = read(`${INTERNAL}/layout.tsx`);
    assert.match(layout, /const canSwitchOrganization = memberships\.length > 1/);
    assert.match(layout, /canSwitchOrganization \? \(/);
    const door = read('src/lib/admin/organization-switch.ts');
    assert.match(door, /rpc\('switch_organization'/);
    assert.match(door, /supabase\.auth\.refreshSession\(\)/, 'the claims are re-minted by the hook, never edited by hand');
  });
});

describe('8. no hand-rolled table on /agents/routing', () => {
  it('the three tables are DataTables', () => {
    const src = read(`${INTERNAL}/agents/routing/page.tsx`);
    assert.doesNotMatch(src, /<table/);
    assert.equal((src.match(/<DataTable /g) ?? []).length, 3);
  });
});

describe('9. the migration behind the stream', () => {
  const MIGRATION = 'supabase/migrations/20261001100000_the_shell_remembers_and_escalates.sql';
  const sql = sqlCode(read(MIGRATION));

  for (const table of ['core.recent_commands', 'core.create_drafts', 'core.escalations']) {
    it(`${table}: organization_id FK, RLS enabled and forced, granted, frozen`, () => {
      assert.match(sql, new RegExp(`create table if not exists ${table.replace('.', '\\.')} \\([^;]*organization_id\\s+uuid not null references core\\.organizations\\(id\\) on delete cascade`, 's'));
      assert.match(sql, new RegExp(`alter table ${table.replace('.', '\\.')} enable row level security`));
      assert.match(sql, new RegExp(`alter table ${table.replace('.', '\\.')} force row level security`));
      assert.match(sql, new RegExp(`grant select[^;]* on ${table.replace('.', '\\.')} to authenticated, service_role`));
      assert.match(sql, new RegExp(`before update of organization_id on ${table.replace('.', '\\.')}\\s+for each row execute function core\\.freeze_organization_id\\(\\)`));
    });
  }

  it('the personal tables admit only the person (own-row policies)', () => {
    for (const table of ['recent_commands', 'create_drafts']) {
      assert.match(sql, new RegExp(`create policy ${table}_own on core\\.${table}\\s+for all to authenticated\\s+using \\(\\s*organization_id = \\(select core\\.current_organization_id\\(\\)\\)\\s+and user_id = \\(select auth\\.uid\\(\\)\\)`, 's'));
    }
  });

  it('escalations: any internal member raises as themself, only an admin answers, nobody deletes', () => {
    assert.match(sql, /create policy escalations_insert on core\.escalations\s+for insert to authenticated\s+with check \(\s*organization_id = \(select core\.current_organization_id\(\)\)\s+and from_user = \(select auth\.uid\(\)\)\s+and \(select core\.is_internal\(\)\)/s);
    assert.match(sql, /create policy escalations_update on core\.escalations\s+for update to authenticated\s+using \(\s*organization_id = \(select core\.current_organization_id\(\)\)\s+and \(select core\.is_admin\(\)\)/s);
    assert.doesNotMatch(sql, /create policy escalations_delete/);
    assert.match(sql, /grant select, insert, update on core\.escalations/);
  });

  it('the doors audit their decisions in the same transaction', () => {
    assert.match(sql, /'escalation\.raised'/);
    assert.match(sql, /'escalation\.' \|\| p_state/);
    assert.match(sql, /'organization\.switched'/);
    assert.equal((sql.match(/perform core\.record_audit\(/g) ?? []).length, 3);
  });

  it('a second open escalation of the same row is refused, not duplicated', () => {
    assert.match(sql, /and e\.state = 'open'/);
    assert.match(sql, /'already_open'/);
  });

  it('the switch refuses an organisation the person holds no active membership of', () => {
    assert.match(sql, /'not_a_member'/);
    assert.match(sql, /and m\.status = 'active'/);
  });

  it('the hook prefers the chosen organisation and still never throws', () => {
    assert.match(sql, /case when v_chosen is not null and m\.organization_id = v_chosen then 0 else 1 end/);
    assert.match(sql, /exception when others then/);
    assert.match(sql, /raise warning 'custom_access_token_hook failed for %: %'/);
  });

  it('severity is derived, not stored', () => {
    assert.doesNotMatch(sql, /severity/);
    const items = read(`${INTERNAL}/notifications/action-items.ts`);
    assert.match(items, /severity: Severity;/);
    for (const sev of ["'critical'", "'action'", "'warning'", "'info'"]) assert.ok(items.includes(`severity: ${sev}`) || items.includes(`? ${sev}`) || items.includes(`: ${sev}`), sev);
  });

  it('the types file knows the new tables and doors', () => {
    const types = read('src/lib/db/types.ts');
    for (const name of ['recent_commands: {', 'create_drafts: {', 'escalations: {', 'acknowledge_escalation: {', 'escalate: {', 'list_my_organizations: {', 'switch_organization: {', 'current_organization_id: string | null']) {
      assert.ok(types.includes(name), name);
    }
  });
});
