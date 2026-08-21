import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The routing tables — decision ADM-84, steps R1 and R3.
 *
 * The provider abstraction below these already works: callers name a model and
 * never a vendor. These two tables are the layer above — which models exist,
 * what they can do, and which an agent's category should prefer.
 *
 * The tests worth having here are the ones that pin what ADM-84 *decided*,
 * because those are the parts a later change would drift from without anybody
 * noticing: per-organization scope, per-category policy, and an empty registry
 * that is a decision rather than an oversight.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120004_routing_is_data.sql');
const registry = read('../src/modules/agents/registry.ts');
/**
 * The migration that installs the agent reference data.
 *
 * It used to be `supabase/seed.sql`, and that is precisely why production had
 * none of these rows: seed.sql is applied by `supabase db reset` and by
 * nothing else, while production is migrated with `db push`. Reading the
 * installer keeps these assertions pointed at what every environment actually
 * receives.
 */
const installer = readdirSync(new URL('../supabase/migrations', import.meta.url))
  .filter((f) => f.includes('the_agent_registry_reaches_production'))
  .map((f) => read(`../supabase/migrations/${f}`))
  .join('\n');

const seed = installer;

describe('A. the scope ADM-84 chose', () => {
  test('models are per organization, not global', () => {
    // One tenant's deprecation must not change another's behaviour. A global
    // catalogue is defensible and was deliberately not taken.
    assert.match(migration, /create table if not exists ai\.models[\s\S]{0,400}organization_id\s+uuid not null/);
    assert.match(migration, /primary key \(organization_id, model_id\)/);
  });

  test('policy is per category, not per agent', () => {
    // Thirteen agents would be thirteen knobs and no coherent policy.
    assert.match(migration, /primary key \(organization_id, category\)/);
  });

  test('and the seven categories are the ones the decision names', () => {
    for (const category of [
      'engineering', 'coordination', 'client_facing',
      'extraction', 'design', 'money', 'certification',
    ]) {
      assert.match(migration, new RegExp(`'${category}'`), `the category ${category} is missing`);
    }
  });
});

describe('B. nothing is seeded, and that is the decision', () => {
  test('no model row exists anywhere', () => {
    // ADM-84 deferred the second provider: OpenAI is not chosen merely because
    // §6.4 mentions it for embeddings, since generation and embeddings are
    // different capabilities. Seeding rows would mean writing provider facts —
    // context windows, prices, capabilities — that nobody has established,
    // into a table that reads as authoritative.
    assert.ok(!/insert into ai\.models/i.test(migration), 'the migration seeds models');
    assert.ok(!/insert into ai\.models/i.test(seed), 'the seed writes models nobody has verified');
  });

  test('and no routing policy either', () => {
    assert.ok(!/insert into ai\.routing_policies/i.test(migration), 'the migration seeds routing policy');
    assert.ok(!/insert into ai\.routing_policies/i.test(seed), 'the seed writes routing policy');
  });

  test('an empty registry is a weaker answer, not a broken one', () => {
    // Capability matching with no candidates finds nothing, which is what
    // AI_PROVIDER_NOT_CONFIGURED already does one layer down: nothing is ever
    // reported as succeeding that did not call a model.
    assert.match(migration, /Ships EMPTY|ships empty/);
  });
});

describe('C. capabilities mean the same thing on both sides', () => {
  test('the model vocabulary matches what agent definitions declare', () => {
    // Capability matching compares an agent's declared needs against a model's
    // declared abilities. If the two vocabularies drift, the match silently
    // returns nothing and every agent falls back — which looks like a routing
    // preference rather than a bug.
    const declared = [
      ...registry.matchAll(/export type AgentCapability =([\s\S]*?);/g),
    ].flatMap((m) => [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((c) => c[1]));

    assert.ok(declared.length > 0, 'no agent capabilities were found to compare against');

    for (const capability of declared) {
      assert.match(
        migration,
        new RegExp(`'${capability}'`),
        `the model capability CHECK omits "${capability}", which an agent may declare`,
      );
    }
  });

  test('and the check is a constraint rather than a second list to maintain', () => {
    assert.match(migration, /check \(capabilities <@ array\[/);
  });
});

describe('D. tenant isolation and who may configure', () => {
  test('both tables enable RLS', () => {
    assert.match(migration, /alter table ai\.models enable row level security/);
    assert.match(migration, /alter table ai\.routing_policies enable row level security/);
  });

  test('reads are internal and writes are admin', () => {
    // Routing policy is Admin configuration, and ADM-84 put the override in an
    // Admin's hands specifically.
    assert.match(migration, /create policy models_select[\s\S]{0,300}core\.is_internal\(\)/);
    assert.match(migration, /create policy models_write[\s\S]{0,300}core\.is_admin\(\)/);
    assert.match(migration, /create policy routing_policies_write[\s\S]{0,300}core\.is_admin\(\)/);
  });
});

describe('E. routing cannot become an authority path', () => {
  test('neither table references any authority mechanism', () => {
    // ADM-84: routing cannot increase an agent's authority, bypass RLS, bypass
    // approval, create money authority, or create client-send authority.
    //
    // Asserted as an absence, which is the strongest form the property takes:
    // routing has no reference to those mechanisms and no way to address them,
    // so it cannot affect them whatever it is asked to do.
    const body = migration.slice(migration.indexOf('create table if not exists ai.models'));
    for (const forbidden of ['approval', 'autonomy_level', 'money_authority', 'handoff']) {
      assert.ok(
        !new RegExp(`(references|update|insert into)[^\\n]*${forbidden}`, 'i').test(body),
        `the routing tables reach ${forbidden}, which ADM-84 forbids`,
      );
    }
  });
});
