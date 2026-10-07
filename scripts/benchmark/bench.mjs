#!/usr/bin/env node
/**
 * Benchmark harness: a synthetic CLIENT talking to the real AgencyOS through the real signed WhatsApp webhook. Only Meta's Graph API is
 * stubbed (it is not AgencyOS). The persona's words are written by the tester, one message at a time; the harness never writes a lead
 * status, a quote, an approval or a payment - it can only send what a client could send and read what the client would receive.
 *
 *   node scripts/benchmark/bench.mjs stub                      # long-lived Meta Graph stub on :54398 (run in the background)
 *   node scripts/benchmark/bench.mjs send <persona> "<text>"   # one client message; drains the runner; prints the reply + AI usage
 *   node scripts/benchmark/bench.mjs lead <persona>            # where that lead stands (read only)
 *   node scripts/benchmark/bench.mjs ledger [persona]          # AI usage and cost by run/agent/model/phase (read only)
 *
 * Cost is computed from tokens x the price recorded by setup.mjs; `agent_runs.cost_minor` is shown beside it only as a cross-check.
 */
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { resolveTarget } from '../verify-target.mjs';

const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1); };
const target = resolveTarget(fail, { cron: true, anon: false, whatsapp: true });
if (!target.isolated) fail('refusing: the benchmark runs only against the isolated verification database.');
const ORG = '00000000-0000-4000-8000-000000000001';
const DIR = 'tmp/benchmark';
mkdirSync(DIR, { recursive: true });
const RUN = existsSync(`${DIR}/run.json`) ? JSON.parse(readFileSync(`${DIR}/run.json`, 'utf8')) : fail('no run: node scripts/benchmark/setup.mjs first');
const GRAPH_LOG = `${DIR}/graph.jsonl`;
const SENDS_LOG = `${DIR}/sends.jsonl`;
const APP = target.app ?? 'http://localhost:3000';
const FX = RUN.fxInrPerUsd;
const PRICES = Object.fromEntries(Object.entries(RUN.pricing.models).map(([id, p]) => [id, { in: p.inUsdPerM * FX, out: p.outUsdPerM * FX }])); // INR / Mtok

const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const phoneFor = (persona) => `9199${String(parseInt(createHash('sha1').update(persona).digest('hex').slice(0, 7), 16)).padStart(8, '0').slice(-8)}`;

async function rest(schema, path) {
  const res = await fetch(`${target.url}/rest/v1/${path}`, { headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}`, 'Accept-Profile': schema } });
  const text = await res.text();
  if (!res.ok) fail(`GET ${schema}.${path} -> ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : [];
}
const tick = async () => { const r = await fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` } }); return r.json().catch(() => null); };
const queueDepth = async () => (await rest('core', `jobs?organization_id=eq.${ORG}&status=in.(queued,running)&select=id`)).length;

const cost = (r) => {
  const p = PRICES[r.model];
  if (!p) return null; // UNKNOWN, never 0
  return (r.input_tokens * p.in + r.output_tokens * p.out) / 1e6;
};

async function runsSince(iso) {
  return rest('ai', `agent_runs?organization_id=eq.${ORG}&created_at=gte.${iso}&select=id,agent_key,work_class,status,model,provider_id,routing_mode,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_minor,latency_ms,error,created_at,subject_type,subject_id,phase,project_id&order=created_at`);
}

const cmd = process.argv[2];

if (cmd === 'stub') {
  let n = 0;
  createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url.endsWith('/media')) { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ id: 'MEDIA.BENCH' })); }
      let parsed = null; try { parsed = JSON.parse(body); } catch { /* not json */ }
      appendFileSync(GRAPH_LOG, `${JSON.stringify({ t: new Date().toISOString(), to: String(parsed?.to ?? ''), type: parsed?.type, text: parsed?.text?.body ?? null, template: parsed?.template?.name ?? null })}\n`);
      n += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.BENCH.${Date.now()}.${n}` }] }));
    });
  }).listen(54398, '127.0.0.1', () => console.log('graph stub on 127.0.0.1:54398 -> ' + GRAPH_LOG));
} else if (cmd === 'send') {
  const persona = process.argv[3];
  const text = process.argv.slice(4).join(' ');
  if (!persona || !text) fail('usage: send <persona> "<text>"');
  const phone = phoneFor(persona);
  const seq = readJsonl(SENDS_LOG).filter((s) => s.persona === persona).length + 1;
  const wamid = `wamid.bench.${RUN.testRunId}.${persona}.${seq}`;
  const t0 = new Date().toISOString();
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_BENCH', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: RUN.phoneNumberId },
      contacts: [{ profile: { name: `${persona} (synthetic)` }, wa_id: phone }],
      messages: [{ from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  });
  const sig = `sha256=${createHmac('sha256', target.whatsappAppSecret).update(payload, 'utf8').digest('hex')}`;
  const wh = await fetch(`${APP}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
  const whBody = await wh.json().catch(() => null);
  if (wh.status !== 200) fail(`webhook refused: ${wh.status} ${JSON.stringify(whBody)}`);

  // drain: tick until the queue has been empty for a few checks (or 150 s)
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < 150_000 && quiet < 4) {
    await tick();
    quiet = (await queueDepth()) === 0 ? quiet + 1 : 0;
    await sleep(quiet > 0 ? 1500 : 800);
  }
  const t1 = new Date().toISOString();
  const runs = await runsSince(t0);
  const replies = readJsonl(GRAPH_LOG).filter((g) => g.t >= t0 && g.to.replace(/\D/g, '') === phone && g.type === 'text');
  appendFileSync(SENDS_LOG, `${JSON.stringify({ persona, seq, phone, text, t0, t1, runIds: runs.map((r) => r.id), webhook: whBody })}\n`);

  console.log(`\n[${persona} #${seq}] CLIENT: ${text}`);
  for (const r of replies) console.log(`[${persona} #${seq}] AGENCYOS: ${r.text}`);
  if (replies.length === 0) console.log(`[${persona} #${seq}] AGENCYOS: (no message reached the client)`);
  let total = 0; let unknown = 0;
  console.log(`\n  AI calls caused by this message (${runs.length}):`);
  for (const r of runs) {
    const c = cost(r);
    if (c === null) unknown += 1; else total += c;
    console.log(`   ${r.agent_key.padEnd(22)} ${String(r.work_class ?? '').padEnd(14)} ${String(r.status).padEnd(10)} ${(r.provider_id ?? '-')}/${r.model ?? '-'}  in=${r.input_tokens} out=${r.output_tokens} cache_r=${r.cache_read_tokens} cache_w=${r.cache_write_tokens}  ${r.latency_ms ?? '?'}ms  ₹${c === null ? 'UNKNOWN' : c.toFixed(4)}${r.error ? `  ERR ${String(r.error).slice(0, 70)}` : ''}`);
  }
  console.log(`  total ₹${total.toFixed(4)}${unknown ? ` (+${unknown} call(s) with UNKNOWN cost)` : ''}   queue drained in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} else if (cmd === 'lead') {
  const persona = process.argv[3];
  const phone = phoneFor(persona);
  const contacts = await rest('crm', `contacts?organization_id=eq.${ORG}&phone=in.(%2B${phone},${phone})&select=id,full_name,phone,client_account_id`);
  if (!contacts.length) fail(`no contact for ${persona} yet`);
  const leads = await rest('crm', `leads?contact_id=eq.${contacts[0].id}&select=id,status,source,score,assigned_to,requirements,created_at&order=created_at`);
  console.log(JSON.stringify({ persona, contact: contacts[0], leads }, null, 1));
  for (const l of leads) {
    const convs = await rest('crm', `conversations?lead_id=eq.${l.id}&select=id`);
    for (const c of convs) {
      const msgs = await rest('crm', `conversation_messages?conversation_id=eq.${c.id}&select=seq,author_type,authored_by_agent,intent,language,body&order=seq`);
      for (const m of msgs) console.log(`  #${m.seq} ${m.author_type}${m.authored_by_agent ? `:${m.authored_by_agent}` : ''} [${m.intent ?? '-'}/${m.language ?? '-'}] ${String(m.body).slice(0, 110).replace(/\n/g, ' ')}`);
    }
    const reqs = await rest('crm', `requirement_versions?conversation_id=in.(${(await rest('crm', `conversations?lead_id=eq.${l.id}&select=id`)).map((c) => c.id).join(',') || 'null'})&select=version,status,payload&order=version.desc&limit=1`);
    if (reqs[0]) console.log(`  requirements v${reqs[0].version} ${reqs[0].status}: ${(reqs[0].payload?.scopeItems ?? []).map((i) => i.title).join('; ').slice(0, 300)}`);
  }
} else if (cmd === 'ledger') {
  const only = process.argv[3];
  const sends = readJsonl(SENDS_LOG).filter((s) => !only || s.persona === only);
  const ids = new Set(sends.flatMap((s) => s.runIds));
  const all = await runsSince(RUN.startedAt);
  const mine = all.filter((r) => ids.has(r.id));
  const rows = new Map();
  for (const r of mine) {
    const k = `${r.agent_key} | ${r.provider_id}/${r.model}`;
    const a = rows.get(k) ?? { calls: 0, failed: 0, inTok: 0, outTok: 0, cacheR: 0, cacheW: 0, inr: 0, unknown: 0 };
    a.calls += 1; if (r.status === 'failed') a.failed += 1;
    a.inTok += r.input_tokens; a.outTok += r.output_tokens; a.cacheR += r.cache_read_tokens; a.cacheW += r.cache_write_tokens;
    const c = cost(r); if (c === null) a.unknown += 1; else a.inr += c;
    rows.set(k, a);
  }
  let total = 0;
  console.log(`run ${RUN.testRunId}  (${sends.length} client message(s), ${mine.length} attributed AI call(s); ${all.length - mine.length} other call(s) since start NOT attributed)`);
  for (const [k, a] of [...rows].sort((x, y) => y[1].inr - x[1].inr)) {
    total += a.inr;
    console.log(`  ${k.padEnd(60)} calls=${String(a.calls).padStart(3)} failed=${a.failed} in=${String(a.inTok).padStart(7)} out=${String(a.outTok).padStart(6)} cache_r=${a.cacheR} cache_w=${a.cacheW}  ₹${a.inr.toFixed(4)}${a.unknown ? ` (+${a.unknown} UNKNOWN)` : ''}`);
  }
  console.log(`  TOTAL ₹${total.toFixed(4)}  ($${(total / FX).toFixed(4)} at ${FX} INR/USD; evidence: CALCULATED from provider-reported tokens x OpenRouter public price)`);
} else {
  fail('usage: stub | send <persona> "<text>" | lead <persona> | ledger [persona]');
}
