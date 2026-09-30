import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { coverageOf, responsiveCoverage } from '../src/modules/projects/screen-states-schema.ts';

/**
 * An asset has a state — bucket F, stream F-D (migration 20261001130000).
 *
 * SCR-038 said `design_assets` had no status and no versions. Now a design
 * asset is draft until a person marks it approved, a replacement is a new
 * version of the same family, and an uploaded asset's body lives in
 * storage while a generated one keeps its image inline — the CHECK says
 * which shape a row must have, so neither kind can be half-described. The
 * upload door puts the object first and takes it back when the row is
 * refused; storage that cannot be reached refuses in the probe's own words.
 * Beside it, SCR-034/035's structured screen fields and the coverage they
 * are reported from.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const MIGRATION = read('supabase/migrations/20261001130000_a_design_has_activity_assets_have_states_and_git_is_written.sql');
const SERVICE = read('src/modules/projects/design-asset-service.ts');
const QUERIES = read('src/modules/projects/design-asset-queries.ts');
const OVERVIEW = read('app/(internal)/projects/[projectId]/design/page.tsx');
const PANELS = read('app/(internal)/projects/[projectId]/design/design-asset-panels.tsx');
const TYPES = read('src/lib/db/types.ts');

describe('A. the state, the version and the shape are the database’s', () => {
  test('status is draft | approved, version counts up, a replacement names its first version', () => {
    assert.match(MIGRATION, /add column if not exists status\s+text not null default 'draft' check \(status in \('draft', 'approved'\)\)/);
    assert.match(MIGRATION, /add column if not exists version\s+int\s+not null default 1 check \(version > 0\)/);
    assert.match(MIGRATION, /add column if not exists parent_asset_id uuid references projects\.design_assets\(id\) on delete cascade/);
    assert.match(MIGRATION, /select coalesce\(max\(d\.version\), 1\) \+ 1 into v_version/);
    assert.match(MIGRATION, /if v_parent\.parent_asset_id is not null then\s+return query select 'parent_is_a_version'/);
  });

  test('a generated row keeps prompt, image and model; an uploaded row has a storage object — by CHECK, not convention', () => {
    assert.match(MIGRATION, /constraint design_assets_shape_matches_origin/);
    assert.match(MIGRATION, /\(origin = 'generated' and prompt is not null and image_base64 is not null and model is not null and rights_note is not null\)/);
    assert.match(MIGRATION, /\(origin = 'uploaded' and storage_path is not null and length\(btrim\(storage_path\)\) > 0 and title is not null/);
    assert.match(MIGRATION, /alter table projects\.design_assets alter column image_base64 drop not null;/);
  });

  test('the two doors are audited, and a repeat approval writes no audit row', () => {
    assert.match(MIGRATION, /create or replace function projects\.record_uploaded_design_asset\(/);
    assert.match(MIGRATION, /case when p_parent_asset_id is null then 'project\.design_asset_uploaded' else 'project\.design_asset_replaced' end/);
    assert.match(MIGRATION, /create or replace function projects\.mark_design_asset_approved\(p_asset_id uuid\)/);
    assert.match(MIGRATION, /if v_row\.status = 'approved' then\s+return query select 'already_approved'::text; return;/);
    assert.match(MIGRATION, /'project\.design_asset_approved', 'design_asset', p_asset_id/);
  });

  test('the write policies name the delivery roles, and an insert is an upload only', () => {
    assert.match(MIGRATION, /create policy design_assets_insert_upload on projects\.design_assets\s+for insert to authenticated\s+with check \(organization_id = \(select core\.current_organization_id\(\)\)\s+and \(select core\.can_manage_delivery\(\)\)\s+and origin = 'uploaded'\)/);
    assert.match(MIGRATION, /create policy design_assets_update on projects\.design_assets/);
    assert.match(MIGRATION, /create trigger org_match_design_assets_parent/);
    assert.match(MIGRATION, /create trigger freeze_org_design_assets/);
  });

  test('the new columns are typed', () => {
    const block = TYPES.slice(TYPES.indexOf('      design_assets: {'), TYPES.indexOf('      design_reviews: {'));
    for (const col of ['origin', 'status', 'version', 'parent_asset_id', 'storage_path', 'title', 'approved_at']) {
      assert.match(block, new RegExp(`^ {10}${col}: `, 'm'), `${col} is typed`);
    }
    assert.match(block, /^ {10}image_base64: string \| null$/m);
  });
});

describe('B. the upload door is honest about storage', () => {
  test('it probes storage first and refuses with the probe’s own sentence', () => {
    assert.match(SERVICE, /const storage = await probeStorage\(supabase, context\.organizationId\);/);
    assert.match(SERVICE, /if \(!storage\.reachable\) return err\('PROVIDER_ERROR', `Storage is not reachable, so nothing was uploaded\. \$\{storage\.reason\}`\);/);
  });

  test('the object lands before the row, and a refused row takes the object back out', () => {
    const upload = SERVICE.indexOf(".upload(path, file, { contentType: mediaType, upsert: false })");
    const record = SERVICE.indexOf(".rpc('record_uploaded_design_asset', {");
    const remove = SERVICE.indexOf(".remove([path])");
    assert.ok(upload > 0 && record > upload && remove > record);
    assert.match(SERVICE, /if \(error \|\| row\?\.outcome !== 'recorded' \|\| !row\.asset_id\) \{/);
    assert.match(SERVICE, /the upload was undone/);
  });

  test('the door gates on project.write and the function on can_manage_delivery', () => {
    assert.match(SERVICE, /if \(!can\(context, 'project\.write'\)\) return err\('FORBIDDEN', 'You do not have permission to upload a design asset\.'\);/);
    assert.match(MIGRATION, /create or replace function projects\.record_uploaded_design_asset[\s\S]*?if not coalesce\(\(select core\.can_manage_delivery\(\)\), false\) then/);
  });

  test('a repeat approval is a CONFLICT the person can read, not a silent success', () => {
    assert.match(SERVICE, /case 'already_approved':\s+return err\('CONFLICT', 'This version is already approved\.'\);/);
  });
});

describe('C. the reader shows what it can and says what it cannot', () => {
  test('an uploaded asset gets a signed URL, a generated one its inline image, and unreachable storage a reason rather than a broken picture', () => {
    assert.match(QUERIES, /createSignedUrls\(uploadedRows\.map\(\(r\) => r\.storage_path as string\), SIGNED_URL_SECONDS\)/);
    assert.match(QUERIES, /storage = \{ reachable: false, reason: probe\.reason \};/);
    assert.match(QUERIES, /`data:\$\{r\.media_type\};base64,\$\{r\.image_base64\}`/);
    assert.match(QUERIES, /if \(error\) unreadable\('readDesignAssetVersions', error\);/);
  });

  test('families are the first version and its replacements, newest first, and the counts are counts', () => {
    assert.match(QUERIES, /familyId: r\.parent_asset_id \?\? r\.id/);
    assert.match(QUERIES, /\[\.\.\.versions\]\.sort\(\(a, b\) => b\.version - a\.version\)/);
    assert.match(QUERIES, /approved: assets\.filter\(\(a\) => a\.status === 'approved'\)\.length/);
  });

  test('the overview mounts the state: an approved tile, upload, replace and mark-approved, and never a form the guard does not know', () => {
    assert.match(OVERVIEW, /<Stat label="Approved Assets" value=\{String\(assetLibrary\.approved\)\}/);
    assert.match(OVERVIEW, /<UploadDesignAssetPanel projectId=\{projectId\} storage=\{assetLibrary\.storage\} \/>/);
    assert.match(OVERVIEW, /<ApproveAssetButton projectId=\{projectId\} assetId=\{asset\.id\} \/>/);
    assert.match(OVERVIEW, /parentAssetId=\{family\.familyId\} compact \/>/);
    assert.doesNotMatch(OVERVIEW, /<form /);
    assert.match(PANELS, /if \(!storage\.reachable\) \{/);
    assert.match(PANELS, /Storage is not reachable, so nothing can be uploaded\./);
  });
});

describe('D. a screen’s coverage is reported from its own fields', () => {
  test('coverage is targets covered over all targets, and null with no targets', () => {
    assert.equal(coverageOf([], { mobile: true }), null);
    assert.deepEqual(coverageOf(['mobile', 'desktop'], { mobile: true }), { covered: 1, total: 2 });
    assert.deepEqual(coverageOf(['mobile', 'desktop'], { mobile: true, desktop: true, tablet: true }), { covered: 2, total: 2 });
    assert.deepEqual(coverageOf(['tablet'], 'not an object'), { covered: 0, total: 1 });
  });

  test('what is stored names every target, covered or not', () => {
    assert.deepEqual(responsiveCoverage(['mobile', 'tablet'], ['tablet', 'watch']), { mobile: false, tablet: true });
    assert.match(MIGRATION, /add column if not exists responsive_coverage jsonb not null default '\{\}'::jsonb/);
    assert.match(MIGRATION, /create or replace function projects\.set_screen_states\(/);
    assert.match(MIGRATION, /'project\.screen_states_set', 'screen', p_screen_id/);
  });
});
