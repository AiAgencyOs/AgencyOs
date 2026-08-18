/**
 * WhatsApp import — READ-ONLY dry run.
 *
 * Reads one or more WhatsApp chat exports (a `_chat.txt`, a directory of them,
 * or a `.zip` straight from WhatsApp) and prints the structural report the
 * import mandate requires BEFORE anything mutates: message and participant
 * counts, how many participants carry a phone we could match on versus are
 * name-only (manual review), duplicates across files, date range, and — stated
 * every run — that historical messages carry NO consent.
 *
 * It writes NOTHING. No database, no network, no message. It does not decide who
 * is a lead and does not match against AgencyOS — that is the Admin preview,
 * which is RLS-scoped and runs server-side. This is the file side of the ledger.
 *
 *   npm run import:whatsapp:dryrun -- <file.txt|dir|export.zip> [more…] [--json] [--redact]
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { aggregate, analyzeExport, type DryRunReport } from '../src/lib/import/dry-run.ts';
import { parseWhatsAppChat } from '../src/lib/import/whatsapp-chat.ts';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const redact = args.includes('--redact');
const paths = args.filter((a) => !a.startsWith('--'));

if (paths.length === 0) {
  console.error('Usage: npm run import:whatsapp:dryrun -- <file.txt|dir|export.zip> [more…] [--json] [--redact]');
  process.exit(2);
}

/** One (label, text) per chat file discovered under an argument path. */
function collect(path: string): { label: string; text: string }[] {
  const st = statSync(path);
  if (st.isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.zip'))
      .flatMap((f) => collect(join(path, f)));
  }
  if (path.toLowerCase().endsWith('.zip')) {
    // Extract the chat text from the zip WITHOUT writing it anywhere.
    const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' })
      .split('\n')
      .filter((n) => n.toLowerCase().endsWith('.txt'));
    return names.map((n) => ({
      label: `${basename(path)}:${n}`,
      text: execFileSync('unzip', ['-p', path, n], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    }));
  }
  return [{ label: basename(path), text: readFileSync(path, 'utf8') }];
}

function maskPhone(p: string | null): string {
  if (!p) return '—';
  return redact ? p.slice(0, Math.max(3, p.length - 4)) + '••••' : p;
}
function maskName(n: string): string {
  if (!redact) return n.length > 40 ? n.slice(0, 39) + '…' : n;
  return n.slice(0, 2) + '•'.repeat(Math.max(1, Math.min(6, n.length - 2)));
}

const reports: DryRunReport[] = [];
for (const path of paths) {
  for (const { label, text } of collect(path)) {
    reports.push(analyzeExport(parseWhatsAppChat(text), label));
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ reports, aggregate: aggregate(reports) }, null, 2));
  process.exit(0);
}

console.log('════════════════════════════════════════════════════════════════');
console.log(' WhatsApp import — READ-ONLY DRY RUN');
console.log(' No database was read or written. No message was sent. Nothing mutated.');
console.log('════════════════════════════════════════════════════════════════\n');

for (const r of reports) {
  console.log(`▸ ${r.source}`);
  console.log(`    format: ${r.format}${r.isGroup ? ' (GROUP)' : ' (direct)'}   dates: ${r.dates.order}${r.dates.ambiguous ? ' — AMBIGUOUS, timestamps unresolved' : ` (${r.dates.firstRaw} → ${r.dates.lastRaw})`}`);
  console.log(`    messages: ${r.messages.total}  (text ${r.messages.text} · media ${r.messages.media} · system ${r.messages.system})`);
  console.log(`    participants: ${r.participants.total}  →  phone-matchable ${r.participants.phoneMatchable} · name-only ${r.participants.nameOnly} (manual review)`);
  console.log(`    consent provenance: ${r.consentProvenance.toUpperCase()}  — a message is not consent`);
  for (const p of r.participants.list) {
    console.log(`      ${p.phoneMatchable ? '☎' : '·'} ${maskPhone(p.phone).padEnd(16)} ${String(p.messageCount).padStart(4)} msgs  ${maskName(p.displayName)}`);
  }
  for (const w of r.warnings) console.log(`    ⚠ ${w}`);
  console.log('');
}

if (reports.length > 1) {
  const agg = aggregate(reports);
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` AGGREGATE across ${agg.files} files`);
  console.log(`   messages: ${agg.totalMessages}   participants (rows): ${agg.totalParticipants}`);
  console.log(`   distinct phone-matchable people: ${agg.distinctPhoneMatchable}   (collapsed ${agg.duplicatePhoneRows} duplicate rows)`);
  console.log(`   name-only (cannot phone-match): ${agg.nameOnly}   — never deduped by name (a name is not an identity)`);
  console.log(`   groups: ${agg.groups}   ambiguous-date files: ${agg.ambiguousDateFiles}   formats: ${JSON.stringify(agg.formats)}`);
  console.log(`   consent provenance: ${agg.consentProvenance.toUpperCase()}`);
  console.log('──────────────────────────────────────────────────────────────');
}

console.log('\nNothing was imported. To import, the Admin preview matches these against');
console.log('AgencyOS under tenant isolation and an owner reviews before any commit.');
