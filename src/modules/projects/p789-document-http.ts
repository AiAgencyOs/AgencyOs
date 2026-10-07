/**
 * How a stored certificate or receipt document is served: as a DOWNLOAD, never rendered inline from this origin, with a content-security policy that allows
 * no script, no image and no network. The body is HTML the database built from rows and escaped; this is the second wall. Pure, so a test can hold it.
 */

export function documentFileName(base: string): string {
  const cleaned = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${cleaned || 'document'}.html`;
}

export function documentHeaders(fileName: string, sha256: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `attachment; filename="${documentFileName(fileName).replace(/\.html$/, '')}.html"`,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    ETag: `"${sha256}"`,
  };
}
