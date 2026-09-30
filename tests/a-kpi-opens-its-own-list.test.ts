import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isLate, projectHealth, projectHealthReason } from '../src/lib/admin/project-health.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket F, rule 2: "a count is a count, not a badge — every KPI gets a
 * real tile backed by a query, and its click opens the list filtered to
 * exactly that number."
 *
 * The Command Center (SCR-001) had tiles that opened UNFILTERED lists:
 * "Leads created in the last 30 days" opened every lead, "Invoices issued"
 * opened every invoice, "Projects on hold" opened every project. This test
 * pins each tile's href to the filter its label names, and pins the list
 * page on the other end to actually reading that filter — a tile that
 * links to `?issuedFrom=` is decorative unless /invoices honours it.
 */

const dashboard = read('app/(internal)/dashboard/page.tsx');

/** Every `<Stat …/>` in the dashboard, as its opening tag's text. */
function statTags(source: string): string[] {
  const tags: string[] = [];
  const next = (from: number) => {
    const m = /<Stat\s/.exec(source.slice(from));
    return m ? from + m.index : -1;
  };
  let i = next(0);
  while (i >= 0) {
    let depth = 0;
    let j = i;
    for (; j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') depth--;
      else if (depth === 0 && source.startsWith('/>', j)) break;
    }
    tags.push(source.slice(i, j + 2));
    i = next(j);
  }
  return tags;
}

function labelOf(tag: string): string {
  const m = /label="([^"]+)"/.exec(tag);
  return m?.[1] ?? '(no label)';
}

describe('every Command Center tile is a link', () => {
  const tags = statTags(dashboard);

  it('the scan found the tiles', () => {
    assert.ok(tags.length >= 14, `only ${tags.length} tiles found — the scan broke`);
  });

  for (const tag of tags) {
    it(`"${labelOf(tag)}" carries an href`, () => {
      assert.match(tag, /\bhref=/, `${labelOf(tag)} has no href — a count with nowhere to go is a badge`);
    });
  }
});

describe('each tile opens the list filtered to exactly its number', () => {
  const tags = statTags(dashboard);
  const tagFor = (label: string) => {
    const tag = tags.find((t) => labelOf(t) === label);
    assert.ok(tag, `no tile labelled "${label}"`);
    return tag;
  };

  const EXPECT: [label: string, filter: RegExp, why: string][] = [
    ['Leads created', /\/leads\?createdFrom=\$\{windowFrom\}/, 'the window start, so /leads lists the leads created in it'],
    ['Deals won', /\/sales-funnel\?days=\$\{sinceDays\}/, 'the same window the funnel counts'],
    ['Invoices issued', /\/invoices\?issuedFrom=\$\{windowFrom\}/, 'issued inside the window'],
    ['Meetings completed', /\/meetings\?window=past&status=completed/, 'completed meetings, not every past one'],
    ['Active Projects', /\/projects\?status=open/, 'every project not finished or abandoned — the four statuses it counts'],
    ['Projects on hold', /\/projects\?status=on_hold/, 'on hold, not every project'],
    ['Blocked projects', /\/projects\/escalations/, 'the escalations list'],
    ['Failed deliveries', /\/operations#failed-deliveries/, 'the failed-deliveries section'],
    ['Dead jobs', /\/operations#dead-letters/, 'the dead-letters section'],
    ['Pending approvals', /"\/approvals"/, 'the queue — pending is its default'],
    ['Payments to verify', /\/invoices\/verify/, 'the verification queue'],
    ['Total Leads', /"\/leads"/, 'all time — the unfiltered list IS the number'],
  ];

  for (const [label, filter, why] of EXPECT) {
    it(`"${label}" → ${filter.source} (${why})`, () => {
      assert.match(tagFor(label), filter);
    });
  }

  it('"Active projects" counts the four open statuses, not the five rows the table shows', () => {
    assert.match(dashboard, /const openProjects = projectCounts \? \['planning', 'onboarding', 'active', 'on_hold'\]/);
    assert.match(tagFor('Active Projects'), /value=\{openProjects === null \? 'DATA UNAVAILABLE' : String\(openProjects\)\}/);
  });
});

describe('the list on the other end honours the filter', () => {
  it('/leads reads ?createdFrom=', () => {
    const leads = read('app/(internal)/leads/page.tsx');
    assert.match(leads, /createdFrom\?: string/);
    assert.match(leads, /createdFrom: createdFromParam/);
  });

  it('/invoices reads ?issuedFrom= and filters on issued_at', () => {
    const invoices = read('app/(internal)/invoices/page.tsx');
    assert.match(invoices, /issuedFrom\?: string/);
    assert.match(invoices, /i\.issued_at !== null && i\.issued_at >= issuedFrom/);
    assert.match(invoices, /issuedFrom \? `issuedFrom=\$\{issuedFrom\}` : ''/, 'the filter survives sorting and paging');
  });

  it('/projects reads ?status=open as the four open statuses', () => {
    const projects = read('app/(internal)/projects/page.tsx');
    assert.match(projects, /const OPEN_STATUSES = new Set\(\['planning', 'onboarding', 'active', 'on_hold'\]\)/);
    assert.match(projects, /status === 'open'/);
    assert.match(projects, /OPEN_STATUSES\.has\(p\.status\)/);
  });

  it('/operations carries the two anchors', () => {
    const operations = read('app/(internal)/operations/page.tsx');
    assert.match(operations, /id="dead-letters"/);
    assert.match(operations, /id="failed-deliveries"/);
  });

  it('/meetings reads ?status=', () => {
    assert.match(read('app/(internal)/meetings/page.tsx'), /status\?: string/);
  });
});

describe('the project health column is the projects list\'s own rule', () => {
  it('both pages import project-health.ts, and neither restates the rule', () => {
    assert.match(dashboard, /from '@\/lib\/admin\/project-health'/);
    const projects = read('app/(internal)/projects/page.tsx');
    assert.match(projects, /from '@\/lib\/admin\/project-health'/);
    assert.doesNotMatch(projects, /p\.endsOn < todayKey/, 'the late rule lives in project-health.ts now');
  });

  it('the rule: escalated or past due while open is at risk; closed is done; else on track', () => {
    const today = '2026-09-29';
    assert.equal(projectHealth({ status: 'active', endsOn: '2026-10-10', escalated: false, todayKey: today }), 'on_track');
    assert.equal(projectHealth({ status: 'active', endsOn: '2026-09-28', escalated: false, todayKey: today }), 'at_risk');
    assert.equal(projectHealth({ status: 'active', endsOn: null, escalated: true, todayKey: today }), 'at_risk');
    assert.equal(projectHealth({ status: 'completed', endsOn: '2026-01-01', escalated: true, todayKey: today }), 'done');
    assert.equal(projectHealth({ status: 'cancelled', endsOn: '2026-01-01', escalated: false, todayKey: today }), 'done');
    assert.equal(projectHealth({ status: 'on_hold', endsOn: null, escalated: false, todayKey: today }), 'on_track');
    assert.equal(isLate({ status: 'active', endsOn: '2026-09-29', todayKey: today }), false, 'due today is not late');
    assert.equal(projectHealthReason({ status: 'active', endsOn: '2026-09-01', escalated: true, todayKey: today }), 'escalated · past due');
    assert.equal(projectHealthReason({ status: 'active', endsOn: null, escalated: false, todayKey: today }), null);
  });

  it('the dashboard renders it beside the stage', () => {
    assert.match(dashboard, /projectHealth\(input\)/);
    assert.match(dashboard, /PROJECT_HEALTH_LABEL\[health\]/);
  });
});

describe('the finance gate queue and the quick actions are on the dashboard', () => {
  it('the gate reads unpaid milestone invoices and pending claims', () => {
    assert.match(dashboard, /listUnpaidMilestoneInvoices\(\)/);
    assert.match(dashboard, /listPendingPaymentClaims\(\)/);
    assert.match(dashboard, /title="Finance gate queue"/);
    const gate = read('src/lib/admin/finance-gate.ts');
    assert.match(gate, /\.not\('milestone_id', 'is', null\)/);
    assert.match(gate, /\.in\('status', UNPAID\)/);
    assert.match(gate, /unreadable\('listUnpaidMilestoneInvoices'/, 'a failed read refuses');
  });

  it('the quick actions open the same create forms the header does', () => {
    const row = read('app/(internal)/dashboard/quick-actions-row.tsx');
    assert.match(row, /openQuickCreate\(mode\)/);
    for (const label of ['Add lead', 'Create project', 'Create invoice', 'Open approval']) assert.ok(row.includes(label), label);
    assert.match(dashboard, /<QuickActionsRow/);
  });

  it('the Today card carries follow-up reminders', () => {
    assert.match(dashboard, /listFollowUpReminders\(todayWindow\)/);
    // The rows are drawn by the shared Today card (SCR-005 shares it), fed
    // from the dashboard's own read.
    assert.match(dashboard, /reminders=\{reminders\}/);
    const today = read('app/(internal)/today-card.tsx');
    assert.match(today, /reminders\.map\(\(r\) =>/);
  });
});
