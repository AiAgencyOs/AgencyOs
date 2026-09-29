// A local Supabase-shaped gateway for QA: /rest/v1 → PostgREST, /auth/v1 → a
// fake GoTrue whose tokens are stamped by the repo's REAL
// core.custom_access_token_hook, /realtime/v1 → 404 (no realtime server here).
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { SignJWT, jwtVerify } = require('jose');

const SECRET = new TextEncoder().encode('local-stack-jwt-secret-agencyos-0123456789abcdef');
const PGHOST = process.env.PGHOST_SOCK ?? (() => { throw new Error('PGHOST_SOCK (the scratch Postgres socket dir) is required'); })();
const ORG = '00000000-0000-4000-8000-000000000001';
const CLIENT_ACCOUNT = '00000000-0000-4000-8000-000000000101';

const psql = (sql) =>
  execFileSync('/usr/lib/postgresql/16/bin/psql', ['-h', PGHOST, '-p', '55432', '-U', 'postgres', '-d', 'agencyos_local', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim().split('\n')[0];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function mint(payload, hours = 12) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('supabase-local').setIssuedAt().setExpirationTime(`${hours}h`).sign(SECRET);
}

async function sessionFor(userId) {
  const email = psql(`select email from auth.users where id=${q(userId)}`);
  const hooked = JSON.parse(psql(`select core.custom_access_token_hook(jsonb_build_object('user_id', ${q(userId)}::uuid, 'claims', jsonb_build_object('sub', ${q(userId)}, 'role', 'authenticated', 'app_metadata', '{}'::jsonb)))`));
  const app_metadata = hooked.claims.app_metadata ?? {};
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: new Date().toISOString(), app_metadata, user_metadata: { full_name: email.split('@')[0] }, created_at: new Date().toISOString() };
  const access_token = await mint({ sub: userId, role: 'authenticated', aud: 'authenticated', email, app_metadata, user_metadata: user.user_metadata, session_id: 'local' });
  return { access_token, token_type: 'bearer', expires_in: 43200, expires_at: Math.floor(Date.now() / 1000) + 43200, refresh_token: `rt:${userId}`, user };
}

/** token_hash = login:<email>[:<role>] — creates the user (and, if a role is named, the membership) */
function ensureUser(email, role) {
  let id = psql(`select id from auth.users where email=${q(email)} limit 1`);
  if (!id) {
    id = psql(`insert into auth.users (email, raw_user_meta_data) values (${q(email)}, jsonb_build_object('full_name', ${q(email.split('@')[0].replace(/[-_.]/g, ' '))})) returning id`);
  }
  if (role && ['client_admin', 'client_member'].includes(role)) {
    psql(`insert into core.client_users (organization_id, client_account_id, user_id, role, status) select ${q(ORG)}, ${q(CLIENT_ACCOUNT)}, ${q(id)}, ${q(role)}, 'active' where not exists (select 1 from core.client_users where user_id=${q(id)})`);
  } else if (role) {
    psql(`insert into core.memberships (organization_id, user_id, role, status) select ${q(ORG)}, ${q(id)}, ${q(role)}, 'active' where not exists (select 1 from core.memberships where user_id=${q(id)})`);
  }
  return id;
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

async function bearerUser(req) {
  const auth = req.headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  try { const { payload } = await jwtVerify(token, SECRET); return payload; } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:54321');
  try {
    if (url.pathname.startsWith('/rest/v1/')) {
      const body = await readBody(req);
      const headers = { ...req.headers }; delete headers.host; delete headers.apikey; delete headers['content-length'];
      const upstream = await fetch(`http://127.0.0.1:54322${url.pathname.slice('/rest/v1'.length)}${url.search}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const out = Buffer.from(await upstream.arrayBuffer());
      const h = {}; upstream.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) h[k] = v; });
      res.writeHead(upstream.status, h); res.end(out); return;
    }
    if (url.pathname === '/auth/v1/health') return json(res, 200, { name: 'fake-gotrue' });
    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const p = await bearerUser(req); if (!p || p.role !== 'authenticated') return json(res, 401, { message: 'invalid token' });
      const s = await sessionFor(p.sub); return json(res, 200, s.user);
    }
    if (url.pathname === '/auth/v1/verify' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const m = /^login:([^:]+)(?::([a-z_]+))?$/.exec(body.token_hash ?? '');
      if (!m) return json(res, 401, { error_code: 'otp_expired', msg: 'bad token_hash' });
      const id = ensureUser(m[1], m[2]); return json(res, 200, await sessionFor(id));
    }
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = (body.refresh_token ?? '').replace(/^rt:/, '');
      if (!id) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, await sessionFor(id));
    }
    if (url.pathname === '/auth/v1/logout') { res.writeHead(204); res.end(); return; }
    if (url.pathname.startsWith('/realtime/')) return json(res, 404, { message: 'no realtime server in the local QA stack' });
    return json(res, 404, { message: `unhandled ${req.method} ${url.pathname}` });
  } catch (e) {
    console.error('gateway error', req.method, url.pathname, e.message);
    json(res, 500, { message: e.message });
  }
});

const anon = await mint({ role: 'anon', iss: 'supabase-local' }, 24 * 30);
const service = await mint({ role: 'service_role', iss: 'supabase-local' }, 24 * 30);
console.log(JSON.stringify({ anon, service }));
server.listen(54321, '127.0.0.1', () => console.log('gateway on 54321'));
