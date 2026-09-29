import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { renderCalendarFeed } from '../src/modules/projects/calendar-feed-schema.ts';
import { addUnpricedMilestoneSchema } from '../src/modules/projects/milestone-create-schema.ts';
import { archiveProjectSchema, healthOf, lifecyclePhaseOf } from '../src/modules/projects/project-archive-schema.ts';
import { projectHealth } from '../src/modules/projects/project-health.ts';
import { addProjectMemberSchema, assigneeCandidates, PROJECT_ROLES } from '../src/modules/projects/project-members-schema.ts';
import { addProjectLinkSchema } from '../src/modules/projects/project-links-schema.ts';
import { sendProjectUpdateSchema } from '../src/modules/projects/project-updates-schema.ts';
import { recordScopeApprovalSchema } from '../src/modules/projects/scope-approval-schema.ts';
import { addTaskAttachmentSchema, TASK_EVIDENCE_KINDS } from '../src/modules/projects/task-collab-schema.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const MIGRATION = read('supabase/migrations/20261001120000_a_project_has_a_phase_a_team_and_an_archive.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');

/**
 * Bucket F, stream F-C (SCR-018–030): a project has a lifecycle phase, a
 * roster of its own, links, updates, an archive, a calendar feed and
 * approval evidence on its baseline. The migration is asserted for the
 * conventions every table here must carry; the pure rules the screens lean
 * on — the lifecycle phase, health, the assignee fallback, the ICS text —
 * are pinned so a screen can never print what the rule does not produce.
 */

describe('the migration carries every convention', () => {
  for (const table of ['project_members', 'project_links', 'project_updates', 'calendar_feed_tokens']) {
    it(`projects.${table} has RLS enabled and forced, a tenant column, grants, a freeze trigger and an audit trigger`, () => {
      assert.match(SQL, new RegExp(`create table if not exists projects\\.${table} \\([\\s\\S]{0,400}organization_id\\s+uuid not null references core\\.organizations\\(id\\) on delete cascade`));
      assert.match(SQL, new RegExp(`alter table projects\\.${table} enable row level security`));
      assert.match(SQL, new RegExp(`alter table projects\\.${table} force row level security`));
      assert.match(SQL, new RegExp(`create policy ${table}_select on projects\\.${table}[\\s\\S]{0,200}core\\.is_internal\\(\\)`));
      assert.match(SQL, new RegExp(`grant select, insert[a-z, ]* on projects\\.${table} to authenticated, service_role`));
      assert.match(SQL, new RegExp(`create trigger freeze_org_${table}[\\s\\S]{0,120}core\\.freeze_organization_id\\(\\)`));
      assert.match(SQL, new RegExp(`create trigger audit_row_change after insert or update[a-z ]* on projects\\.${table}`));
      assert.match(SQL, new RegExp(`comment on table projects\\.${table} is`));
    });
  }

  it('every org-scoped foreign key has its tenancy trigger', () => {
    for (const [table, fk, parent] of [
      ['projects', 'template_id', 'projects.project_templates'],
      ['project_members', 'project_id', 'projects.projects'],
      ['project_links', 'project_id', 'projects.projects'],
      ['project_updates', 'project_id', 'projects.projects'],
      ['project_updates', 'conversation_id', 'crm.conversations'],
      ['calendar_feed_tokens', 'project_id', 'projects.projects'],
      ['change_requests', 'invoice_id', 'finance.invoices'],
    ] as const) {
      assert.match(SQL, new RegExp(`on projects\\.${table}\\s*\\n\\s*for each row execute function core\\.enforce_parent_org\\('${fk}', '${parent}'\\)`), `${table}.${fk}`);
    }
  });

  it('write policies name the roles: members and archive need can_manage_delivery, links and updates can_write, a feed is one\'s own', () => {
    assert.match(SQL, /create policy project_members_write on projects\.project_members[\s\S]{0,200}core\.can_manage_delivery\(\)/);
    assert.match(SQL, /create policy project_links_write on projects\.project_links[\s\S]{0,200}core\.can_write\(\)/);
    assert.match(SQL, /create policy project_updates_insert on projects\.project_updates[\s\S]{0,200}core\.can_write\(\)/);
    assert.match(SQL, /create policy calendar_feed_tokens_write on projects\.calendar_feed_tokens[\s\S]{0,300}user_id = \(select auth\.uid\(\)\)/);
  });

  it('archive_project refuses anything but a completed project and audits project.archived', () => {
    const body = SQL.slice(SQL.indexOf('function projects.archive_project'), SQL.indexOf('comment on function projects.archive_project'));
    assert.match(body, /if not coalesce\(\(select core\.can_manage_delivery\(\)\), false\) then/);
    assert.match(body, /if v_project\.status <> 'completed' then\s*\n\s*return query select 'not_completed'::text/);
    assert.match(body, /'project\.archived'/);
    assert.match(SQL, /constraint projects_archived_is_completed\s*\n?\s*check \(archived_at is null or status = 'completed'\)/);
  });

  it('a project member must hold an active internal membership in the same organisation', () => {
    assert.match(SQL, /raise exception 'a project member must hold an active internal membership in the same organisation'/);
    assert.match(SQL, /unique \(project_id, user_id\)/);
  });

  it('a client update names the thread and the message that carried it', () => {
    assert.match(SQL, /constraint project_updates_client_names_message\s*\n?\s*check \(sent_to <> 'client' or \(conversation_id is not null and message_id is not null\)\)/);
  });

  it('the calendar feed resolver is service_role only, answers nothing when revoked, and the audit row never carries the token', () => {
    assert.match(SQL, /revoke all on function projects\.resolve_calendar_feed\(text\) from public, anon, authenticated;/);
    assert.match(SQL, /grant execute on function projects\.resolve_calendar_feed\(text\) to service_role;/);
    const body = SQL.slice(SQL.indexOf('function projects.resolve_calendar_feed'), SQL.indexOf('revoke all on function projects.resolve_calendar_feed'));
    assert.match(body, /if v_row\.revoked_at is not null then return; end if;/);
    assert.match(SQL, /v_before - 'token'/);
    assert.match(SQL, /v_after\s+- 'token'/);
  });

  it('approval evidence is recorded on a frozen version only, by can_manage_delivery, and audited', () => {
    const body = SQL.slice(SQL.indexOf('function projects.record_scope_approval_evidence'), SQL.indexOf('comment on function projects.record_scope_approval_evidence'));
    assert.match(body, /if v_sv\.status = 'draft' then\s*\n\s*return query select 'not_frozen'::text/);
    assert.match(body, /core\.can_manage_delivery\(\)/);
    assert.match(body, /'scope_version\.approval_recorded'/);
    assert.match(SQL, /constraint scope_versions_approval_pair\s*\n?\s*check \(\(approved_by is null\) = \(approved_at is null\)\)/);
  });

  it('an unpriced milestone carries no payment share, so the plan\'s 100% rule is untouched', () => {
    const body = SQL.slice(SQL.indexOf('function projects.add_unpriced_milestone'), SQL.indexOf('comment on function projects.add_unpriced_milestone'));
    assert.match(body, /payment_percent, due_on\s*\n\s*\)\s*\n\s*values \([\s\S]{0,200}0, null, p_due_on/);
    assert.match(body, /'milestone\.added_unpriced'/);
  });

  it('typed evidence and folders are constrained at the row', () => {
    assert.match(SQL, /check \(kind in \('screenshot', 'log', 'url', 'file'\)\)/);
    assert.match(SQL, /constraint project_files_folder_shape/);
  });
});

describe('the pure rules the screens lean on', () => {
  it('the lifecycle phase follows the newest phase table, and the archive wins over everything', () => {
    const base = { status: 'active', archivedAt: null, productionReadyAt: null, hasPhaseTwo: false, hasPhaseThree: false, hasPhaseFour: false, hasTestRun: false, hasHandover: false };
    assert.equal(lifecyclePhaseOf(base), 'onboarding');
    assert.equal(lifecyclePhaseOf({ ...base, hasPhaseTwo: true }), 'planning');
    assert.equal(lifecyclePhaseOf({ ...base, hasPhaseTwo: true, hasPhaseThree: true }), 'design');
    assert.equal(lifecyclePhaseOf({ ...base, hasPhaseThree: true, hasPhaseFour: true }), 'development');
    assert.equal(lifecyclePhaseOf({ ...base, hasPhaseFour: true, hasTestRun: true }), 'qa');
    assert.equal(lifecyclePhaseOf({ ...base, hasTestRun: true, hasHandover: true }), 'release');
    assert.equal(lifecyclePhaseOf({ ...base, productionReadyAt: '2026-09-01T00:00:00Z' }), 'release');
    assert.equal(lifecyclePhaseOf({ ...base, status: 'completed', hasHandover: true }), 'completed');
    assert.equal(lifecyclePhaseOf({ ...base, status: 'completed', archivedAt: '2026-09-30T00:00:00Z' }), 'archived');
  });

  it('health: blocked beats at risk beats healthy, and every reason is named', () => {
    const quiet = { status: 'active', blockedTasks: 0, unmetDependencies: 0, overdueTasks: 0, overdueMilestones: 0, blockingDefects: 0, escalations: 0, pendingClaims: 0 };
    assert.deepEqual(projectHealth(quiet), { level: 'healthy', label: 'Healthy', reasons: [] });
    const risky = projectHealth({ ...quiet, overdueTasks: 2, blockingDefects: 1 });
    assert.equal(risky.level, 'at_risk');
    assert.deepEqual(risky.reasons, ['2 tasks are past due', '1 open defect would block a release']);
    const blocked = projectHealth({ ...quiet, blockedTasks: 1, overdueTasks: 1 });
    assert.equal(blocked.level, 'blocked');
    assert.equal(blocked.reasons[0], '1 task is blocked');
    assert.equal(projectHealth({ ...quiet, status: 'on_hold' }).level, 'blocked');
    assert.equal(healthOf({ atRisk: true, blocked: true }), 'blocked');
    assert.equal(healthOf({ atRisk: true, blocked: false }), 'at_risk');
    assert.equal(healthOf({ atRisk: false, blocked: false }), 'healthy');
  });

  it('assignee candidates are the members when there are any, else the roster — never an empty list on an unstaffed project', () => {
    const roster = [{ userId: 'a' }, { userId: 'b' }];
    assert.deepEqual(assigneeCandidates([], roster), { people: roster, source: 'roster' });
    assert.deepEqual(assigneeCandidates([{ userId: 'b' }], roster), { people: [{ userId: 'b' }], source: 'members' });
  });

  it('the schemas refuse what the rows would refuse', () => {
    assert.equal(addProjectMemberSchema.safeParse({ projectId: 'x', userId: 'y' }).success, false);
    assert.equal(addProjectMemberSchema.parse({ projectId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' }).projectRole, 'contributor');
    assert.ok(PROJECT_ROLES.includes('project_manager'));
    assert.equal(addProjectLinkSchema.safeParse({ projectId: '11111111-1111-4111-8111-111111111111', label: 'Repo', url: 'ftp://nope' }).success, false);
    assert.equal(sendProjectUpdateSchema.safeParse({ projectId: '11111111-1111-4111-8111-111111111111', body: '  ', sentTo: 'client' }).success, false);
    assert.equal(sendProjectUpdateSchema.safeParse({ projectId: '11111111-1111-4111-8111-111111111111', body: 'Hello', sentTo: 'everyone' }).success, false);
    assert.equal(archiveProjectSchema.safeParse({ projectId: 'nope' }).success, false);
    assert.equal(recordScopeApprovalSchema.safeParse({ scopeVersionId: '11111111-1111-4111-8111-111111111111', approvedBy: '' }).success, false);
    assert.equal(recordScopeApprovalSchema.safeParse({ scopeVersionId: '11111111-1111-4111-8111-111111111111', approvedBy: 'A. Client', evidenceUrl: 'not a url' }).success, false);
    assert.equal(addUnpricedMilestoneSchema.safeParse({ projectId: '11111111-1111-4111-8111-111111111111', name: 'Design sign-off', dueOn: '2026-13-40' }).success, false);
    assert.deepEqual(TASK_EVIDENCE_KINDS, ['screenshot', 'log', 'url', 'file']);
    assert.equal(addTaskAttachmentSchema.parse({ taskId: '11111111-1111-4111-8111-111111111111', title: 'Shot', url: 'https://x.test/a.png' }).kind, 'url');
    assert.equal(addTaskAttachmentSchema.safeParse({ taskId: '11111111-1111-4111-8111-111111111111', title: 'Shot', url: 'https://x.test/a.png', kind: 'video' }).success, false);
  });

  it('the ICS feed is deterministic, escapes what RFC 5545 asks, and gives every event a stable uid', () => {
    const entries = [
      { uid: 'task-1@agencyos', summary: 'Task: Ship it, now; really', date: '2026-10-03', startAt: null, description: null, url: 'https://x.test/p' },
      { uid: 'meeting-2@agencyos', summary: 'Meeting: call', date: '2026-10-04', startAt: '2026-10-04T09:30:00.000Z', description: 'Status: confirmed', url: null },
    ];
    const a = renderCalendarFeed({ calendarName: 'Acme — AgencyOS', entries, stamp: '2026-10-01T00:00:00.000Z' });
    const b = renderCalendarFeed({ calendarName: 'Acme — AgencyOS', entries, stamp: '2026-10-01T00:00:00.000Z' });
    assert.equal(a, b);
    assert.match(a, /BEGIN:VCALENDAR\r\nVERSION:2\.0/);
    assert.match(a, /SUMMARY:Task: Ship it\\, now\\; really/);
    assert.match(a, /DTSTART;VALUE=DATE:20261003/);
    assert.match(a, /DTSTART:20261004T093000Z/);
    assert.match(a, /UID:meeting-2@agencyos/);
    assert.equal((a.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  });
});

describe('the screens are wired to the doors, not around them', () => {
  const list = read('app/(internal)/projects/page.tsx');
  const board = read('app/(internal)/projects/[projectId]/board/page.tsx');
  const team = read('app/(internal)/projects/[projectId]/team/page.tsx');
  const route = read('app/api/projects/[projectId]/calendar.ics/route.ts');
  const updates = read('src/modules/projects/project-updates-service.ts');

  it('the projects list filters by phase and health, hides archived by default and archives through the door', () => {
    assert.match(list, /readProjectLifecycles\(\)/);
    assert.match(list, /href="\/projects\?health=blocked"/);
    assert.match(list, /\/projects\?phase=\$\{p\}/);
    assert.match(list, /showArchived \? everything : everything\.filter\(\(p\) => p\.archivedAt === null\)/);
    assert.match(list, /ArchiveProjectButton/);
  });

  it('the board reads assignees from the members reader (with the roster fallback) and filters by milestone', () => {
    assert.match(board, /listAssigneeCandidates\(projectId\)/);
    assert.match(board, /roster=\{candidates\.people\}/);
    assert.match(board, /initialMilestone=/);
  });

  it('the team page draws "last active" from the audit log and never claims "online"', () => {
    assert.match(team, /readLastActive\(/);
    assert.doesNotMatch(team, /online now/i);
  });

  it('the ICS route resolves the token through the service-role RPC and answers 404 for an unknown or revoked token', () => {
    assert.match(route, /rpc\('resolve_calendar_feed', \{ p_token: token \}\)/);
    assert.match(route, /if \(!feed \|\| feed\.project_id !== projectId\) return notFound\(\);/);
    assert.match(route, /text\/calendar; charset=utf-8/);
  });

  it('a client update goes through sendClientMessage — the one outbound chokepoint — and is recorded only after it went', () => {
    assert.match(updates, /import \{ sendClientMessage \} from '@\/modules\/crm\/service';/);
    const clientBranch = updates.slice(updates.indexOf("if (parsed.data.sentTo === 'client')"), updates.indexOf("from('project_updates')"));
    assert.match(clientBranch, /const sent = await sendClientMessage\(/);
    assert.match(clientBranch, /if \(!sent\.ok\) return sent;/);
    assert.doesNotMatch(updates, /sendWhatsAppText|send_outbound_message/);
  });
});
