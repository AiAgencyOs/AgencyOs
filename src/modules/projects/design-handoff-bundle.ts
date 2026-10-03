import 'server-only';

import { createClient } from '@/lib/db/server';
import { filesBucket } from '@/lib/files/storage';
import { unreadable } from '@/lib/result';
import { buildZip, safeZipName, type ZipEntry } from '@/lib/export/zip';

import { readBrandRules } from './brand-kit-queries';
import { readDesignHandoffPackage } from './design-export-queries';

/**
 * SCR-038 "Export handoff package" beyond the JSON manifest: a ZIP with the
 * manifest, an asset sheet (CSV, with the licence of each), the brand kit as
 * readable text, and the asset FILES — a generated asset's image straight from
 * the database, an uploaded asset's object from storage. A file storage will
 * not hand over is listed in `MISSING.txt` with the reason, never silently
 * dropped (storage is not reachable on every deployment).
 */

const csvCell = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf' };

export async function buildDesignHandoffBundle(project: { id: string; name: string; code: string | null }): Promise<Uint8Array> {
  const supabase = await createClient();
  const enc = new TextEncoder();
  const [pkg, rules, assetsRes] = await Promise.all([
    readDesignHandoffPackage(project.id),
    readBrandRules(project.id),
    supabase
      .schema('projects')
      .from('design_assets')
      .select('id, kind, origin, status, version, parent_asset_id, title, prompt, media_type, image_base64, storage_path, rights_note, created_at')
      .eq('project_id', project.id)
      .order('created_at', { ascending: true }),
  ]);
  if (assetsRes.error) unreadable('buildDesignHandoffBundle.assets', assetsRes.error);
  const assets = assetsRes.data ?? [];

  const entries: ZipEntry[] = [];
  const missing: string[] = [];
  const sheet = [['id', 'kind', 'title', 'version', 'status', 'origin', 'media_type', 'licence_or_rights', 'file'].join(',')];

  for (const a of assets) {
    const title = a.title ?? a.prompt?.slice(0, 40) ?? a.kind;
    const ext = EXT[a.media_type] ?? 'bin';
    const file = safeZipName(`files/${a.kind}/${title.replace(/[^a-z0-9._-]+/gi, '-')}-v${a.version}-${a.id.slice(0, 8)}.${ext}`);
    let included = false;
    if (a.origin === 'generated' && a.image_base64) {
      entries.push({ name: file, data: new Uint8Array(Buffer.from(a.image_base64, 'base64')) });
      included = true;
    } else if (a.storage_path) {
      try {
        const { data, error } = await supabase.storage.from(filesBucket()).download(a.storage_path);
        if (error || !data) missing.push(`${file}: ${error?.message ?? 'storage returned nothing'}`);
        else {
          entries.push({ name: file, data: new Uint8Array(await data.arrayBuffer()) });
          included = true;
        }
      } catch (e) {
        missing.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    sheet.push([a.id, a.kind, title, a.version, a.status, a.origin, a.media_type, a.rights_note, included ? file : ''].map(csvCell).join(','));
  }

  const kitLines = [`# Brand kit — ${project.name}`, '', '## Brand rules', ''];
  if (rules.length === 0) kitLines.push('No brand rule is written for this project.');
  for (const r of rules) kitLines.push(`### ${r.title}`, '', r.rule, '');
  for (const kind of ['logo', 'icon', 'font']) {
    kitLines.push(`## ${kind === 'font' ? 'Fonts' : `${kind[0]!.toUpperCase()}${kind.slice(1)}s`}`, '');
    const of = assets.filter((a) => a.kind === kind);
    if (of.length === 0) kitLines.push('None uploaded.', '');
    for (const a of of) kitLines.push(`- ${a.title ?? a.id} v${a.version} (${a.status}) — licence: ${a.rights_note ?? 'not recorded'}`);
    kitLines.push('');
  }

  entries.unshift(
    { name: 'manifest.json', data: enc.encode(JSON.stringify({ project, ...pkg }, null, 2)) },
    { name: 'assets.csv', data: enc.encode(`${sheet.join('\n')}\n`) },
    { name: 'brand-kit.md', data: enc.encode(kitLines.join('\n')) },
  );
  if (missing.length > 0) entries.push({ name: 'MISSING.txt', data: enc.encode(`These asset files could not be included:\n${missing.join('\n')}\n`) });
  return buildZip(entries);
}
