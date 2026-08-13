#!/usr/bin/env node
/**
 * The end-of-project summary, verified against a real database.
 *
 * Phase 12, gap G-033, directive §23. Every number here is assembled from a
 * different table, and the ones worth driving are the ones somebody would
 * argue about at the end of a project: what was billed against what arrived,
 * and how many times the work went round again.
 *
 * What it proves:
 *
 *   1. The four money figures are four different numbers, and the outstanding
 *      one counts only invoices that can still be paid.
 *   2. Revisions are versions beyond the first PER KIND — three designs and
 *      one prototype is two revisions, not four and not one.
 *   3. Duration is null while the project is still running, because a
 *      duration measured to now() reads as a fact and is a moving number.
 *   4. It reports and decides nothing: an outstanding balance changes no
 *      status anywhere.
 *
 *   node scripts/verify-completion-summary.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

const target = await resolveTarget();
await announceTarget(target, 'verify-completion-summary');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g033';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const summary = async (id) => one(await rest('POST', 'projects', 'rpc/completion_summary', { p_project_id: id }));

const created = {};

console.log('\n\x1b[1mAgencyOS — the completion summary (G-033)\x1b[0m');

try {
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  created.account = account?.id;

  const project = one(await rest('POST', 'projects', 'projects', {
    organization_id: ORG, client_account_id: created.account, name: `${MARKER} project`,
    status: 'active', budget_minor: 500000,
  }));
  created.project = project?.id;
  if (!created.project) throw new Error('could not create the project fixture');

  console.log('\n1. A project nobody has billed yet');
  {
    const s = await summary(created.project);
    check(Number(s?.budget_minor) === 500000, 'the budget is what was agreed', `${s?.budget_minor}`);
    check(Number(s?.invoiced_minor) === 0 && Number(s?.paid_minor) === 0, 'nothing billed, nothing paid');
    check(s?.duration_days === null, 'and no duration, because it has not ended', `${s?.duration_days}`);
    check(s?.handover_status === null, 'nor a handover', `${s?.handover_status}`);
  }

  console.log('\n2. Four money figures, four different numbers');
  {
    // Issued and part paid, plus one void that must not count anywhere.
    // issued_at is required for anything past draft — invoices_issued_at_set.
    // The first version of this fixture omitted it, the insert failed, and the
    // money assertions read zero against a summary that was working perfectly.
    const issued = one(await rest('POST', 'finance', 'invoices', {
      organization_id: ORG, project_id: created.project, client_account_id: created.account,
      number: `${MARKER}-1`, status: 'partially_paid', total_minor: 300000, paid_minor: 100000,
      issued_at: new Date().toISOString(),
    }));
    const voided = one(await rest('POST', 'finance', 'invoices', {
      organization_id: ORG, project_id: created.project, client_account_id: created.account,
      number: `${MARKER}-2`, status: 'void', total_minor: 90000, paid_minor: 0,
    }));
    created.invoices = [issued?.id, voided?.id].filter(Boolean);

    const s = await summary(created.project);
    check(Number(s?.invoiced_minor) === 390000, 'invoiced counts every invoice written', `${s?.invoiced_minor}`);
    check(Number(s?.paid_minor) === 100000, 'paid counts what arrived', `${s?.paid_minor}`);
    check(
      Number(s?.outstanding_minor) === 200000,
      'and outstanding counts only what can still be paid — the void invoice is not a debt',
      `${s?.outstanding_minor}`,
    );
  }

  console.log('\n3. Revisions are versions beyond the first, per kind');
  {
    for (const [kind, n] of [['design', 3], ['prototype', 1]]) {
      for (let i = 0; i < n; i += 1) {
        await rest('POST', 'projects', 'rpc/add_deliverable', {
          p_project_id: created.project, p_kind: kind, p_title: `${kind} ${i + 1}`,
        });
      }
    }
    const s = await summary(created.project);
    check(Number(s?.deliverables) === 4, 'four versions exist', `${s?.deliverables}`);
    check(
      Number(s?.revisions) === 2,
      'and two of them are revisions — the client asked for changes twice',
      `${s?.revisions}`,
    );
  }

  console.log('\n4. Defects and the final version');
  {
    await rest('POST', 'qa', 'defects', {
      organization_id: ORG, project_id: created.project, severity: 'minor',
      title: `${MARKER} open`, reproduction: 'Tap it.',
    });
    const fixed = one(await rest('POST', 'qa', 'defects', {
      organization_id: ORG, project_id: created.project, severity: 'trivial',
      title: `${MARKER} settled`, reproduction: 'Look at it.',
    }));
    await rest('PATCH', 'qa', `defects?id=eq.${fixed.id}`, { status: 'wontfix', resolution: 'by design' });

    const latest = one(await rest('GET', 'projects',
      `deliverables?project_id=eq.${created.project}&kind=eq.design&order=version.desc&limit=1&select=id,version`));
    await rest('PATCH', 'projects', `deliverables?id=eq.${latest.id}`, { status: 'approved' });

    const s = await summary(created.project);
    check(Number(s?.defects_total) === 2, 'every defect is counted', `${s?.defects_total}`);
    check(Number(s?.defects_open) === 1, 'and the open ones separately', `${s?.defects_open}`);
    check(s?.final_version === `design v${latest.version}`, 'the final version is the approved one', `${s?.final_version}`);
  }

  console.log('\n5. It reports, and decides nothing');
  {
    const before = one(await rest('GET', 'projects', `projects?id=eq.${created.project}&select=status`));
    const s = await summary(created.project);
    const after = one(await rest('GET', 'projects', `projects?id=eq.${created.project}&select=status`));

    check(
      Number(s?.outstanding_minor) > 0 && after?.status === before?.status,
      'an outstanding balance changes no status anywhere — that gate is ADM-13/ADM-14',
      `${before?.status} → ${after?.status}`,
    );

    const handover = one(await rest('POST', 'projects', 'handovers', {
      organization_id: ORG, project_id: created.project, status: 'accepted',
      accepted_at: new Date().toISOString(),
    }));
    created.handover = handover?.id;

    const done = await summary(created.project);
    check(done?.handover_status === 'accepted', 'once accepted, the handover shows', `${done?.handover_status}`);
    check(
      done?.completed_at !== null && Number(done?.duration_days) >= 0,
      'and the duration becomes a fixed number rather than a moving one',
      `${done?.duration_days} days`,
    );
  }
} finally {
  if (created.project) {
    await rest('DELETE', 'projects', `handovers?project_id=eq.${created.project}`);
    await rest('DELETE', 'qa', `defects?project_id=eq.${created.project}`);
    await rest('DELETE', 'projects', `deliverables?project_id=eq.${created.project}`);
    for (const i of created.invoices ?? []) await rest('DELETE', 'finance', `invoices?id=eq.${i}`);
    await rest('DELETE', 'projects', `projects?id=eq.${created.project}`);
  }
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ The project adds up, and the summary changes nothing\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
