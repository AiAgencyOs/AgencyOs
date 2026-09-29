import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { allPublishedTables, channelNameFor, tablesFor, TOPICS } from '../src/lib/realtime/topics.ts';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/** Every `schema.table` named in a publication migration's array literal. */
function publishedInMigrations(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    if (!sql.includes('supabase_realtime')) continue;
    for (const m of sql.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) if (m[1]) out.add(m[1]);
  }
  return out;
}

/** Every table any migration creates. */
function tablesInMigrations(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_]+\.[a-z_]+)/g)) if (m[1]) out.add(m[1]);
  }
  return out;
}

/**
 * A screen subscribes by topic; the database publishes by table. The two
 * lists live in different languages in different files, and this is what
 * keeps them the same list.
 */
describe('what a screen listens to is what the database publishes', () => {
  it('every table a topic names is in the realtime publication', () => {
    const published = publishedInMigrations();
    for (const table of allPublishedTables()) {
      assert.ok(published.has(table), `${table} is named by a topic but no migration publishes it`);
    }
  });

  it('every table the publication names is one a migration created', () => {
    const created = tablesInMigrations();
    for (const table of publishedInMigrations()) {
      assert.ok(created.has(table), `${table} is published but no migration creates it`);
    }
  });

  it('the heartbeat is not a topic — a refresh a minute is the polling this replaces', () => {
    assert.ok(!allPublishedTables().includes('core.cron_heartbeat'));
  });

  it('the audit log is its own topic, not attached to any operational one', () => {
    for (const [topic, tables] of Object.entries(TOPICS)) {
      if (topic === 'audit') continue;
      assert.ok(!(tables as readonly string[]).includes('audit.audit_log'), topic);
    }
  });
});

describe('a channel joins each table once', () => {
  it('two topics sharing a table subscribe to it once', () => {
    const refs = tablesFor(['projects', 'tasks', 'projects']);
    const qualified = refs.map((r) => `${r.schema}.${r.table}`);
    assert.equal(new Set(qualified).size, qualified.length);
    assert.ok(qualified.includes('projects.projects'));
    assert.ok(qualified.includes('projects.tasks'));
  });

  it('the channel name is stable across topic order', () => {
    assert.equal(channelNameFor(['qa', 'approvals']), channelNameFor(['approvals', 'qa', 'approvals']));
  });

  it('no topics means no tables', () => {
    assert.deepEqual(tablesFor([]), []);
  });
});
