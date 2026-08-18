/**
 * WhatsApp import — STAGE a batch for Admin review.
 *
 * Reads one or more WhatsApp exports, classifies each observed person against
 * the organization's existing contacts (src/lib/import/match.ts — a phone
 * decides identity, a name never does), and writes the result into the staging
 * tables (crm.import_batches / crm.import_records). It creates NO contact, NO
 * lead, NO consent, and sends nothing: staging only. An owner then reviews the
 * batch in the Admin Panel (/import) and commits the phone-keyed rows there.
 *
 *   npm run import:whatsapp:stage -- --org <uuid> <file|dir|export.zip> [more…] [--dry]
 *
 * --dry prints the classification and writes nothing. --org is required and is
 * the authoritative tenant the candidates are matched within (never inferred
 * from the file). Runs against the verify target's database (service role).
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { announceTarget, resolveTarget } from './verify-target.mjs';
import { classifyAll } from '../src/lib/import/match.ts';
import { parseWhatsAppChat } from '../src/lib/import/whatsapp-chat.ts';

function fail(m: string): never { console.error(`\x1b[31m${m}\x1b[0m`); process.exit(1); }
const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target);

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const orgIdx = argv.indexOf('--org');
const org = orgIdx >= 0 ? argv[orgIdx + 1] : null;
const paths = argv.filter((a, i) => !a.startsWith('--') && i !== orgIdx + 1);

if (!org) fail('--org <uuid> is required — the tenant candidates are matched within.');
if (paths.length === 0) fail('Usage: import:whatsapp:stage -- --org <uuid> <file|dir|export.zip> [--dry]');

const KEY = target.serviceKey;
const parse = (t: string | null): unknown => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
async function rest(method: string, schema: string, path: string, body?: unknown) {
  const res = await fetch(`${target.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: parse(await res.text()) as unknown };
}
const one = (r: { json: unknown }): Record<string, string> | undefined =>
  (Array.isArray(r.json) ? r.json[0] : r.json) as Record<string, string> | undefined;

function collect(path: string): { label: string; text: string }[] {
  const st = statSync(path);
  if (st.isDirectory()) {
    return readdirSync(path)
      .filter((f) => /\.(txt|zip)$/i.test(f))
      .flatMap((f) => collect(join(path, f)));
  }
  if (/\.zip$/i.test(path)) {
    const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter((n) => n.toLowerCase().endsWith('.txt'));
    return names.map((n) => ({ label: `${basename(path)}:${n}`, text: execFileSync('unzip', ['-p', path, n], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }));
  }
  return [{ label: basename(path), text: readFileSync(path, 'utf8') }];
}

// The org's contacts — the set identity is decided against. Read once.
const contactsRes = await rest('GET', 'crm', `contacts?organization_id=eq.${org}&select=id,phone,full_name&limit=100000`);
const contactRows = (Array.isArray(contactsRes.json) ? contactsRes.json : []) as {
  id: string;
  phone: string | null;
  full_name: string | null;
}[];
const contacts = contactRows.map((c) => ({ id: c.id, phone: c.phone, fullName: c.full_name }));
console.log(`\nMatching against ${contacts.length} existing contact(s) in org ${org.slice(0, 8)}…`);

// One candidate per observed person across all files (phone-deduped, name kept).
const candidates = [];
const seenPhone = new Set();
for (const path of paths) {
  for (const { label, text } of collect(path)) {
    const parsed = parseWhatsAppChat(text);
    for (const p of parsed.participants) {
      if (p.phone && seenPhone.has(p.phone)) continue;
      if (p.phone) seenPhone.add(p.phone);
      candidates.push({ phone: p.phone, displayName: p.displayName, sourceLabel: label, messageCount: p.messageCount });
    }
  }
}

const { results, summary } = classifyAll(candidates, contacts);
console.log(`\nClassified ${summary.total} candidate(s): exact ${summary.exact} · new ${summary.new} · probable ${summary.probable} · conflict ${summary.conflict} · unmatched ${summary.unmatched}`);
console.log(`  auto-importable (phone-keyed): ${summary.autoImportable}   manual review: ${summary.manualReview}   consent provenance: NONE`);

if (dry) {
  console.log('\n--dry: nothing was written.');
  process.exit(0);
}

const label = paths.map((p) => basename(p)).join(', ').slice(0, 200);
const batch = one(await rest('POST', 'crm', 'import_batches', { organization_id: org, source_label: label }));
if (!batch) fail('Could not create the import batch.');

let inserted = 0;
for (const r of results) {
  const res = await rest('POST', 'crm', 'import_records', {
    batch_id: batch.id, organization_id: org,
    phone: r.candidate.phone, display_name: r.candidate.displayName, message_count: r.candidate.messageCount,
    source_label: r.candidate.sourceLabel, classification: r.classification, auto_importable: r.autoImportable,
    matched_contact_id: r.classification === 'exact' || r.classification === 'probable' ? (r.matchedContactIds[0] ?? null) : null,
  });
  if (res.status >= 200 && res.status < 300) inserted += 1;
  else console.error(`  ✗ record for ${r.candidate.displayName}: ${res.status}`);
}

console.log(`\nStaged batch ${batch.id} with ${inserted}/${results.length} records.`);
console.log('Review and commit the phone-keyed rows in the Admin Panel → /import. Nothing was imported yet.');
