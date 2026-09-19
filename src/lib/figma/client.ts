import 'server-only';

/**
 * Figma, read-only — Designer §8, §24; Master §20; G-301.
 *
 * ── what this can and cannot do, stated once ──────────────────────────
 *
 * Figma's REST API **reads** files. It does not compose a visual direction,
 * and nothing in this module writes to Figma. §24 is explicit: *"do not claim
 * automated editing if the actual integration only supports assisted/manual
 * steps."*
 *
 * So a designer still designs. What a token buys is that the reference they
 * paste can be **checked** rather than believed, and that the version comes
 * from the file rather than from somebody's memory.
 *
 * ── every failure is named, and "not configured" is one of them ───────
 *
 * §24 asks for permission errors and revoked tokens to be detected and
 * handled. The distinctions matter because they have different owners:
 *
 *   `not_configured`  nobody has set a token — the manual path, unchanged
 *   `unauthorized`    the token was rejected — somebody must reissue it
 *   `forbidden`       the token is valid and cannot see this file
 *   `not_found`       the file or node does not exist — likely a typo
 *   `unreachable`     Figma did not answer — try later, change nothing
 *
 * Collapsing these into `false` would make a revoked token look like a typo,
 * and a typo look like an outage. **None of them is ever reported as
 * success**, which is Master §20's rule: nothing claims a Figma result it
 * does not have.
 */

/** Read at call time, not at module load: a token added later must work without a redeploy. */
const token = () => process.env.FIGMA_ACCESS_TOKEN?.trim() || null;

export const figmaConfigured = () => token() !== null;

export type FigmaLookup =
  | { ok: true; version: string; nodeName: string; lastModified: string | null }
  | { ok: false; reason: 'not_configured' | 'unauthorized' | 'forbidden' | 'not_found' | 'unreachable' };

/**
 * The official endpoint for reading specific nodes, which is what §24 means by
 * "official/supported APIs". It returns the FILE's version alongside the node,
 * which is exactly the association §8 asks to be preserved — the version and
 * the artwork come from one answer rather than being stitched together.
 */
const ENDPOINT = 'https://api.figma.com/v1/files';

export async function lookupNode(fileKey: string, nodeId: string): Promise<FigmaLookup> {
  const key = token();
  if (!key) return { ok: false, reason: 'not_configured' };

  const file = encodeURIComponent(fileKey.trim());
  const node = encodeURIComponent(nodeId.trim());

  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/${file}/nodes?ids=${node}`, {
      headers: { 'X-Figma-Token': key },
      cache: 'no-store',
      // A verification a person is waiting on must not hang. Timing out is an
      // honest `unreachable`; a request with no bound is a page that never
      // finishes loading.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (res.status === 403) {
    // Figma answers 403 both for a bad token and for a valid token without
    // access. The body distinguishes them; when it does not, `forbidden` is
    // the safer of the two to report — it sends somebody to look at sharing
    // rather than to reissue a working credential.
    const body = await res.text().catch(() => '');
    return { ok: false, reason: /invalid token|not valid/i.test(body) ? 'unauthorized' : 'forbidden' };
  }
  if (res.status === 401) return { ok: false, reason: 'unauthorized' };
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) return { ok: false, reason: 'unreachable' };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  const payload = json as {
    version?: unknown;
    lastModified?: unknown;
    nodes?: Record<string, { document?: { name?: unknown } } | null>;
  };

  // Figma answers 200 with an EMPTY nodes map when the file exists and the
  // node does not — so a missing node is a 200, and treating any 200 as
  // success would report a node that is not there as verified.
  const entry = payload.nodes?.[nodeId.trim()] ?? null;
  const name = entry?.document?.name;
  if (!entry || typeof name !== 'string') return { ok: false, reason: 'not_found' };

  const version = typeof payload.version === 'string' ? payload.version : null;
  if (!version) return { ok: false, reason: 'unreachable' };

  return {
    ok: true,
    version,
    nodeName: name,
    lastModified: typeof payload.lastModified === 'string' ? payload.lastModified : null,
  };
}
