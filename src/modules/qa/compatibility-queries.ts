import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-048 — the compatibility matrix and the performance notes, org-wide.
 *
 * Both read `qa.test_runs` columns added in 20260929170000 (`device`,
 * `browser`, `os`, `perf_notes`). A run that recorded none of them is not
 * in the matrix: a cell drawn from a run that did not say where it ran
 * would be decoration, which is exactly what the earlier dashboard refused
 * to draw. No threshold is applied anywhere here — Doc 14 §16.
 */

export type CompatibilityCell = { runs: number; failed: number; lastAt: string };

export type CompatibilityMatrix = {
  devices: string[];
  browsers: string[];
  /** `${device}|${browser}` → cell. */
  cells: Map<string, CompatibilityCell>;
  /** Runs of the compatibility suite that recorded no device or browser. */
  unplaced: number;
};

export async function readCompatibilityMatrix(days = 90): Promise<CompatibilityMatrix> {
  const supabase = await createClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('device, browser, os, failed, executed_at')
    .eq('suite', 'compatibility')
    .gte('executed_at', since)
    .order('executed_at', { ascending: false });
  if (error) unreadable('readCompatibilityMatrix', error);

  const devices = new Set<string>();
  const browsers = new Set<string>();
  const cells = new Map<string, CompatibilityCell>();
  let unplaced = 0;

  for (const r of data ?? []) {
    const device = r.device?.trim() || (r.os?.trim() ? r.os.trim() : null);
    const browser = r.browser?.trim() || null;
    if (!device || !browser) {
      unplaced += 1;
      continue;
    }
    devices.add(device);
    browsers.add(browser);
    const key = `${device}|${browser}`;
    const cell = cells.get(key);
    if (cell) {
      cell.runs += 1;
      cell.failed += r.failed;
    } else {
      cells.set(key, { runs: 1, failed: r.failed, lastAt: r.executed_at });
    }
  }

  return {
    devices: [...devices].sort(),
    browsers: [...browsers].sort(),
    cells,
    unplaced,
  };
}

export type PerformanceNote = {
  runId: string;
  projectId: string;
  projectName: string;
  perfNotes: string;
  device: string | null;
  passed: number;
  failed: number;
  total: number;
  executedAt: string;
};

export async function listPerformanceNotes(limit = 30): Promise<PerformanceNote[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('qa')
    .from('test_runs')
    .select('id, project_id, perf_notes, device, passed, failed, total, executed_at')
    .eq('suite', 'performance')
    .not('perf_notes', 'is', null)
    .order('executed_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listPerformanceNotes', error);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds);
  if (projectsError) unreadable('listPerformanceNotes.projects', projectsError);
  const nameById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.map((r) => ({
    runId: r.id,
    projectId: r.project_id,
    projectName: nameById.get(r.project_id) ?? 'Unknown project',
    perfNotes: r.perf_notes ?? '',
    device: r.device,
    passed: r.passed,
    failed: r.failed,
    total: r.total,
    executedAt: r.executed_at,
  }));
}
