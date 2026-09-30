#!/usr/bin/env node
/**
 * The Help page, generated from the screen inventory.
 *
 * Bucket E, decision E3 (owner, 2026-09-30): the panel explains itself. The
 * one authoritative list of admin screens is
 * `docs/AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md` — "a screen does not exist
 * in this product until it has a row here". So /help is not written by hand
 * a second time: this script reads every `| SCR-nnn |` row of §1, one entry
 * per screen (id, title, route, capability, what it reads, live topics,
 * status, the module it sits under), and writes `src/lib/help/screens.json`,
 * which is checked in so the page needs no build step at request time.
 *
 * The JSON carries a SHA-256 of the SCR rows it was built from. The guard
 * test `tests/a-person-owns-their-preferences.test.ts` recomputes that hash
 * from the inventory and fails when they differ — a Help page older than the
 * inventory is the hazard §42 names, and the fix is `npm run build:help`.
 *
 *   node scripts/build-help.mjs          # writes the JSON
 *   node scripts/build-help.mjs --check  # exits 1 when the JSON is stale
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const INVENTORY = 'docs/AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md';
export const OUTPUT = 'src/lib/help/screens.json';

/** Table cells arrive with backticks and bold; the page prints plain words. */
function plain(cell) {
  return cell.replace(/`/g, '').replace(/\*\*/g, '').trim();
}

/** Every `/path` written in backticks in the route cell, in order. */
function routesOf(cell) {
  return [...cell.matchAll(/`(\/[^`\s]*)`/g)].map((m) => m[1]);
}

/**
 * The SCR rows of §1, with the `### Module` heading each sits under. Rows
 * outside §1 (the A→SCR mapping in §3 mentions SCR ids in prose, not rows)
 * are not screens and are not read.
 */
export function parseInventory(markdown) {
  const lines = markdown.split('\n');
  const screens = [];
  const rowText = [];
  let inInventory = false;
  let module = null;

  for (const line of lines) {
    if (/^## /.test(line)) {
      inInventory = /^## 1\. Inventory/.test(line);
      continue;
    }
    if (!inInventory) continue;
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      module = heading[1].trim();
      continue;
    }
    if (!/^\| SCR-\d{3} \|/.test(line)) continue;

    rowText.push(line);
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    const [id, title, route, guard, reads, live, status] = cells;
    screens.push({
      id,
      title: plain(title),
      module,
      route: plain(route),
      routes: routesOf(route),
      capability: plain(guard),
      reads: plain(reads),
      live: plain(live),
      status: plain(status),
    });
  }

  const inventoryHash = createHash('sha256').update(rowText.join('\n')).digest('hex');
  return { screens, inventoryHash };
}

export function buildHelp(markdown) {
  const { screens, inventoryHash } = parseInventory(markdown);
  return {
    source: INVENTORY,
    inventoryHash,
    count: screens.length,
    screens,
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').replace(/^.*\//, '/'));
if (isMain) {
  const markdown = readFileSync(INVENTORY, 'utf8');
  const help = buildHelp(markdown);
  const json = `${JSON.stringify(help, null, 2)}\n`;

  if (process.argv.includes('--check')) {
    const current = (() => {
      try {
        return readFileSync(OUTPUT, 'utf8');
      } catch {
        return null;
      }
    })();
    if (current !== json) {
      console.error(`${OUTPUT} is older than ${INVENTORY}. Run: npm run build:help`);
      process.exit(1);
    }
    console.log(`${OUTPUT} is current (${help.count} screens).`);
  } else {
    writeFileSync(OUTPUT, json);
    console.log(`Wrote ${OUTPUT}: ${help.count} screens from ${INVENTORY}.`);
  }
}
