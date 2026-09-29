import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright-core');

const APP = 'http://localhost:3000';
const PRJ = process.env.PRJ; const AGENT = process.env.AGENT;
const LEAD = '00000000-0000-4000-8000-000000000302';
const CLIENT = '00000000-0000-4000-8000-000000000101';

const OWNER_ROUTES = [
  '/dashboard','/notifications','/my-tasks',
  '/leads',`/leads/${LEAD}`,'/sales-funnel','/quotations','/meetings','/follow-ups',
  '/clients',`/clients/${CLIENT}`,'/portfolio',
  '/projects','/projects/escalations','/reports',
  `/projects/${PRJ}`,`/projects/${PRJ}/board`,`/projects/${PRJ}/plan`,`/projects/${PRJ}/scope`,`/projects/${PRJ}/design`,`/projects/${PRJ}/design/themes`,`/projects/${PRJ}/design/colors`,`/projects/${PRJ}/design/final`,`/projects/${PRJ}/prototype`,`/projects/${PRJ}/development`,`/projects/${PRJ}/repository`,`/projects/${PRJ}/builds`,`/projects/${PRJ}/qa`,`/projects/${PRJ}/calendar`,`/projects/${PRJ}/files`,`/projects/${PRJ}/team`,`/projects/${PRJ}/activity`,`/projects/${PRJ}/settings`,`/projects/${PRJ}/ui-versions`,
  '/requirements','/design','/development','/qa','/production-readiness',
  '/finance','/invoices','/invoices/verify','/finance/payments','/finance/expenses','/finance/tax',
  '/communication','/agents',`/agents/${AGENT}`,'/agents/routing','/agents/automations','/usage',
  '/operations','/approvals','/security','/security/users','/audit','/integrations','/import',
  '/settings','/settings/commercial','/settings/team','/settings/communication','/settings/approvals',
];
const PHONE_ROUTES = ['/dashboard','/leads',`/leads/${LEAD}`,'/projects',`/projects/${PRJ}/board`,'/invoices','/settings/commercial','/design'];
const ROLE_PROBES = { finance: ['/dashboard','/invoices','/invoices/verify','/leads','/settings','/audit'], contractor: ['/dashboard','/projects','/leads','/settings','/agents'], member: ['/dashboard','/leads','/projects','/finance','/settings'], client_admin: ['/dashboard','/portal','/leads','/invoices'] };

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] });
const report = { owner: [], phone: [], roles: {} };

async function signIn(context, email, role) {
  const page = await context.newPage();
  const hash = role ? `login:${email}:${role}` : `login:${email}`;
  await page.goto(`${APP}/auth/callback?token_hash=${encodeURIComponent(hash)}&type=magiclink&next=/dashboard`, { waitUntil: 'networkidle', timeout: 90000 });
  const landed = page.url();
  await page.close();
  return landed;
}

async function visit(context, route, opts = {}) {
  const page = await context.newPage();
  const errors = []; const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 300)));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 140)}`); });
  let status = null; let finalUrl = null; let h1 = null; let text = '';
  try {
    const resp = await page.goto(APP + route, { waitUntil: 'networkidle', timeout: 90000 });
    status = resp?.status() ?? null; finalUrl = page.url().replace(APP, '');
    h1 = await page.locator('h1').first().textContent({ timeout: 3000 }).catch(() => null);
    text = (await page.locator('main').first().innerText({ timeout: 3000 }).catch(() => '')).slice(0, 4000);
    if (opts.shot) { await page.screenshot({ path: opts.shot, fullPage: true }); }
  } catch (e) { errors.push('nav: ' + e.message.slice(0, 200)); }
  await page.close();
  // Realtime noise is expected here: no realtime server in this stack.
  const realErrors = errors.filter((e) => !/realtime|websocket|WebSocket|54321\/realtime/i.test(e));
  return { route, status, finalUrl, h1: h1?.trim() ?? null, errors: realErrors, failed, empty: /nothing|no .* yet|all clear|not set/i.test(text), denied: /permission|not allowed|don.t have access/i.test(text) , liveStatus: (text.match(/\b(Live|Connecting|Reconnecting|Degraded|Polling)\b/)||[])[1] ?? null };
}

// ── owner, desktop ──
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  report.ownerLanding = await signIn(ctx, 'owner@local.test');
  mkdirSync((process.env.SHOTS ?? '/tmp/agencyos-qa') + '/owner', { recursive: true });
  for (const r of OWNER_ROUTES) {
    const slug = r.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
    const res = await visit(ctx, r, { shot: `/tmp/pg/shots/owner/${slug}.png` });
    report.owner.push(res);
    console.log(`${String(res.status).padEnd(4)} ${r.padEnd(60)} → ${res.finalUrl}  ${res.errors.length ? 'ERR ' + res.errors.length : ''} ${res.failed.length ? '5xx ' + res.failed.length : ''} ${res.liveStatus ?? ''}`);
  }
  await ctx.close();
}
// ── owner, phone ──
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await signIn(ctx, 'owner@local.test');
  mkdirSync((process.env.SHOTS ?? '/tmp/agencyos-qa') + '/phone', { recursive: true });
  for (const r of PHONE_ROUTES) {
    const slug = r.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
    const res = await visit(ctx, r, { shot: `/tmp/pg/shots/phone/${slug}.png` });
    report.phone.push(res);
    console.log(`phone ${String(res.status).padEnd(4)} ${r.padEnd(40)} ${res.errors.length ? 'ERR ' + res.errors.length : ''}`);
  }
  await ctx.close();
}
// ── other roles ──
for (const [role, routes] of Object.entries(ROLE_PROBES)) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const landed = await signIn(ctx, `${role}@local.test`, role);
  report.roles[role] = { landed: landed.replace(APP, ''), probes: [] };
  for (const r of routes) {
    const res = await visit(ctx, r);
    report.roles[role].probes.push(res);
    console.log(`${role.padEnd(12)} ${r.padEnd(20)} → ${res.finalUrl}  ${res.denied ? 'DENIED-PAGE' : ''} ${res.errors.length ? 'ERR ' + res.errors.length : ''}`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync((process.env.SHOTS ?? '/tmp/agencyos-qa') + '/qa-report.json', JSON.stringify(report, null, 2));
console.log('report written');
