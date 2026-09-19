import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Figma is recorded, not claimed — Designer §8, §24; Master §20; G-301.
 *
 * A token exists now, and the honest question is what a token changes.
 *
 * **It does not make AgencyOS a designer.** Figma's REST API reads files; it
 * does not compose a visual direction, and §24 forbids claiming automated
 * editing an integration does not have. The assisted step stays.
 *
 * What it changes is that the reference can be **checked** rather than
 * believed, the version comes **from the file**, and a revoked token is a
 * state somebody can act on rather than a silent nothing.
 *
 * And it carries §24's sharpest rule: **do not silently replace a file/node
 * and reuse the same version identifier.**
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260920060000_figma_is_recorded_not_claimed.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const CLIENT = read('src/lib/figma/client.ts');
const SERVICE = read('src/modules/projects/design.ts');
const ACTIONS = read('src/modules/projects/actions.ts');
const FORMS = read('app/(internal)/projects/[projectId]/design/design-forms.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/design/page.tsx');
const CONFIG = read('src/lib/admin/config-status.ts');

const bounded = (source: string, start: string, next: string) => {
  const i = source.indexOf(start);
  assert.ok(i > 0, `${start} does not exist`);
  const j = source.indexOf(next, i + 1);
  const cut = source.slice(i, j > 0 ? j : undefined);
  assert.ok(cut.length > 0 && cut.length < source.length, `${start} is not bounded`);
  return cut;
};
const door = bounded(SQL, 'create or replace function projects.link_theme_figma', '$$;');
const svc = bounded(SERVICE, 'export async function linkThemeFigma', '\nexport async function ');
const form = bounded(FORMS, 'export function FigmaReferenceForm', '\nexport function ');

describe('A. §24’s rule: the artifact must not move under a still version', () => {
  test('changing the node while keeping the version is refused', () => {
    assert.match(door, /if v_row\.figma_version is not null\s*\n\s*and v_ver is not distinct from v_row\.figma_version\s*\n\s*and \(v_file is distinct from v_row\.figma_file_key\s*\n\s*or v_node is distinct from v_row\.figma_node_id\) then\s*\n\s*return query select 'version_reused'::text/);
  });

  test('and the reason is what it protects, not what it refused', () => {
    // A version is what Phase 4 opens and what the handoff promises.
    assert.match(PROSE, /makes every record that cites it\s+wrong at once, including ones a client already approved/);
    assert.match(svc, /A version is what Phase 4 opens and what the handoff promises/);
  });

  test('changing both is allowed — that is a new artifact honestly described', () => {
    // The guard only bites while a version is being carried forward.
    assert.match(door, /and v_ver is not distinct from v_row\.figma_version/);
    assert.match(PROSE, /Changing both is fine — that is a new artifact honestly described/);
  });

  test('and the surface warns before the click', () => {
    assert.match(form, /Pointing this at different artwork while keeping the same version is refused/);
  });
});

describe('B. verified is a different fact from linked', () => {
  test('the row records when it was CHECKED, separately', () => {
    assert.match(SQL, /add column if not exists figma_verified_at timestamptz/);
    assert.match(MIGRATION, /a different fact from figma_linked_at, which is when somebody typed it/);
  });

  test('a re-link resets verification', () => {
    // Carrying the old timestamp forward would say the NEW reference had been
    // checked. Driven on a scratch Postgres.
    assert.match(door, /figma_verified_at = case when p_verified then now\(\) else null end/);
    assert.match(door, /figma_node_name = case when p_verified/);
  });

  test('and only the verifier may claim it', () => {
    // A caller pasting by hand leaves `p_verified` false and the row records
    // that it is unverified, which is the truth.
    assert.match(SQL, /p_verified\s+boolean default false/);
    assert.match(svc, /p_verified: lookup\.ok,/);
  });
});

describe('C. the provider reads; it never writes', () => {
  test('nothing in the client mutates Figma', () => {
    // §24: do not claim automated editing the integration does not have.
    assert.doesNotMatch(CLIENT, /method: 'POST'|method: 'PUT'|method: 'DELETE'|method: 'PATCH'/);
    assert.match(CLIENT, /It does not compose a visual direction,\s*\n \* and nothing in this module writes to Figma\./);
  });

  test('and both wordings say so, token or no token', () => {
    assert.match(form, /AgencyOS does not create Figma artwork — a designer does/);
    assert.match(form, /AgencyOS does not create Figma artwork either way\./);
  });

  test('the official endpoint is used', () => {
    assert.match(CLIENT, /const ENDPOINT = 'https:\/\/api\.figma\.com\/v1\/files';/);
    assert.match(CLIENT, /'X-Figma-Token': key/);
  });
});

describe('D. every failure is named, and none is success', () => {
  test('the five reasons are distinct', () => {
    for (const r of ['not_configured', 'unauthorized', 'forbidden', 'not_found', 'unreachable']) {
      assert.match(CLIENT, new RegExp(`'${r}'`), `${r} is not a reason`);
    }
  });

  test('and each status maps to the one that names whose job it is', () => {
    // Presence is not behaviour: a red-proof pointing 401 at `not_found` left
    // every reason string in the file and this suite green, because
    // `'unauthorized'` still appeared in the type union. A revoked token
    // reading as a typo sends somebody to check a link that is fine.
    assert.match(CLIENT, /if \(res\.status === 401\) return \{ ok: false, reason: 'unauthorized' \};/);
    assert.match(CLIENT, /if \(res\.status === 404\) return \{ ok: false, reason: 'not_found' \};/);
    assert.match(CLIENT, /if \(!res\.ok\) return \{ ok: false, reason: 'unreachable' \};/);
    assert.match(CLIENT, /if \(!key\) return \{ ok: false, reason: 'not_configured' \};/);
    // 403 is the one Figma overloads, so it reads the body to tell them apart.
    assert.match(CLIENT, /reason: \/invalid token\|not valid\/i\.test\(body\) \? 'unauthorized' : 'forbidden'/);
  });

  test('a 200 with an empty node map is not_found, not success', () => {
    // Figma answers 200 when the file exists and the node does not. Treating
    // any 200 as success would report a node that is not there as verified.
    assert.match(CLIENT, /if \(!entry \|\| typeof name !== 'string'\) return \{ ok: false, reason: 'not_found' \};/);
    assert.match(CLIENT, /so a missing node is a 200, and treating any 200 as\s+\/\/ success would report a node that is not there as verified/);
  });

  test('a rejected reference is not recorded as if it were fine', () => {
    // not_found / forbidden / unauthorized mean Figma actively said no.
    // not_configured and unreachable mean nobody claimed anything.
    assert.match(svc, /if \(!lookup\.ok && \(lookup\.reason === 'not_found' \|\| lookup\.reason === 'forbidden' \|\| lookup\.reason === 'unauthorized'\)\)/);
  });

  test('and each of those three says whose job it is', () => {
    assert.match(svc, /Check the link you copied from\./);
    assert.match(svc, /Share the file with the token’s account/);
    assert.match(svc, /It has probably been revoked and needs reissuing\./);
  });

  test('the request cannot hang', () => {
    assert.match(CLIENT, /signal: AbortSignal\.timeout\(10_000\)/);
  });
});

describe('E. the version comes from the file, and is never invented', () => {
  test('Figma’s version wins when there is one', () => {
    assert.match(svc, /p_figma_version: lookup\.ok \? lookup\.version : \(input\.figmaVersion \?\? null\),/);
  });

  test('and the typed one is kept when there is not', () => {
    // What a person believed, recorded as such rather than substituted.
    assert.match(SERVICE, /\*\*Verification never invents a version\.\*\*/);
  });

  test('the form stops asking for a version when it will be read', () => {
    // Asking somebody to type a number the system is about to overwrite
    // invites them to believe it mattered.
    assert.match(form, /\{configured \? null : \(/);
    assert.match(FORMS, /asking somebody to type a number\s*\n \* the system is about to overwrite invites them to believe it mattered/);
  });

  test('and the result says which happened, not "saved"', () => {
    assert.match(ACTIONS, /Checked against Figma — “\$\{outcome\.data\.nodeName\}”, and the version was read from the file\./);
    assert.match(ACTIONS, /Recorded\. \$\{outcome\.data\.unverifiedReason\}/);
  });
});

describe('F. the token is configuration, never a value on a screen', () => {
  test('it is declared optional, and its absence is a supported state', () => {
    assert.match(read('src/lib/env-schema.ts'), /FIGMA_ACCESS_TOKEN: z\.string\(\)\.min\(8, 'FIGMA_ACCESS_TOKEN looks too short'\)\.optional\(\)/);
    assert.match(read('src/lib/env.ts'), /FIGMA_ACCESS_TOKEN: process\.env\.FIGMA_ACCESS_TOKEN,/);
  });

  test('the config screen reports presence only', () => {
    assert.match(CONFIG, /\{ key: 'FIGMA_ACCESS_TOKEN', area: 'Figma', secret: true, requiredInProduction: false/);
    assert.match(CONFIG, /Unset ⇒ references are recorded unverified; nothing is ever reported as created in Figma\./);
  });

  test('and the page never reads the value, only whether there is one', () => {
    assert.match(PAGE, /const figmaReady = figmaConfigured\(\);/);
    assert.doesNotMatch(PAGE, /FIGMA_ACCESS_TOKEN/);
    assert.doesNotMatch(FORMS, /FIGMA_ACCESS_TOKEN/);
  });

  test('the token is read at call time, so one added later works without a redeploy', () => {
    assert.match(CLIENT, /const token = \(\) => process\.env\.FIGMA_ACCESS_TOKEN\?\.trim\(\) \|\| null;/);
  });
});

describe('G. G-281 fixed in the function this unit replaces', () => {
  test('the guard no longer fails open on a NULL role', () => {
    assert.match(door, /or not coalesce\(\(select core\.can_write\(\)\), false\) then/);
    assert.doesNotMatch(door, /or not \(select core\.can_write\(\)\) then/);
  });

  test('and the old signature is dropped rather than left beside the new one', () => {
    // It would otherwise linger as a second door with none of these rules.
    assert.match(SQL, /drop function if exists projects\.link_theme_figma\(uuid, text, text, text, text, text\);/);
  });
});
