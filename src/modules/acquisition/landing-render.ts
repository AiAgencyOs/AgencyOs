import { createHash } from 'node:crypto';

/**
 * The landing page, rendered. PURE and deterministic: the same approved version always produces the same bytes, so the hash of what
 * was sent to the host is a fact about the version. The page has one job - move a visitor to WhatsApp - so it has no form, no
 * script that sends data anywhere, and exactly one outbound destination: wa.me with the approved number.
 *
 * The visitor's ad campaign id (Google's {campaignid} ValueTrack parameter, arriving as utm_campaign or campaignid) is read in the
 * browser and written into the pre-filled WhatsApp text as `LP-<version>-<campaign>`; `crm.record_landing_arrival` turns that tag
 * into a first touch when the message arrives. Without JavaScript the link still works and says `direct`.
 */

export const CAPTURE_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid'] as const;

export type LandingContent = {
  headline: string;
  subheadline?: string;
  benefits: { title: string; text: string }[];
  proof?: { portfolio_item_id: string; caption: string }[];
  faq?: { q: string; a: string }[];
  cta_text: string;
  privacy_url: string;
  contact_email: string;
};

export type RenderInput = {
  versionId: string;
  contentHash: string;
  whatsappNumber: string;
  content: LandingContent;
  /** Proof captions are shown; the link is to the agency's own portfolio item. */
  proofLinks?: Record<string, { title: string; url: string }>;
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const versionPrefix = (versionId: string): string => versionId.slice(0, 8).toLowerCase();
const digits = (n: string): string => n.replace(/\D/g, '');

export const whatsappHref = (input: Pick<RenderInput, 'versionId' | 'whatsappNumber' | 'content'>, campaign = 'direct'): string =>
  `https://wa.me/${digits(input.whatsappNumber)}?text=${encodeURIComponent(`Hi, I'd like to talk about: ${input.content.headline} LP-${versionPrefix(input.versionId)}-${campaign}`)}`;

export function renderLandingHtml(input: RenderInput): string {
  const c = input.content;
  const href = whatsappHref(input);
  const prefix = versionPrefix(input.versionId);
  const proof = (c.proof ?? []).map((p) => {
    const link = input.proofLinks?.[p.portfolio_item_id];
    return `<li>${link ? `<a href="${esc(link.url)}" rel="noopener">${esc(p.caption)}</a>` : esc(p.caption)}</li>`;
  }).join('');
  const faq = (c.faq ?? []).map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="aos-version" content="${esc(input.contentHash)}">
<title>${esc(c.headline)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;color:#111}main{max-width:44rem;margin:0 auto;padding:2rem 1rem}a.cta{display:inline-block;background:#128c7e;color:#fff;padding:.9rem 1.4rem;border-radius:.5rem;text-decoration:none;font-weight:600}li{margin:.4rem 0}footer{font-size:.85rem;color:#555;margin-top:3rem}</style>
</head>
<body>
<main>
<h1>${esc(c.headline)}</h1>
${c.subheadline ? `<p>${esc(c.subheadline)}</p>` : ''}
<p><a class="cta" id="aos-cta" data-aos-capture="${CAPTURE_PARAMS.join(',')}" data-aos-prefix="${prefix}" href="${esc(href)}">${esc(c.cta_text)}</a></p>
<ul>${c.benefits.map((b) => `<li><strong>${esc(b.title)}</strong> - ${esc(b.text)}</li>`).join('')}</ul>
${proof ? `<h2>Our work</h2><ul>${proof}</ul>` : ''}
${faq ? `<h2>Questions</h2>${faq}` : ''}
<footer><a href="${esc(c.privacy_url)}" rel="noopener">Privacy</a> · <a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a></footer>
</main>
<script>
(function(){var a=document.getElementById('aos-cta');if(!a)return;var p=new URLSearchParams(location.search);
var c=(p.get('utm_campaign')||p.get('campaignid')||'direct').replace(/[^A-Za-z0-9_]/g,'').slice(0,40)||'direct';
a.href=a.href.replace(/LP-${prefix}-direct/,'LP-${prefix}-'+c);})();
</script>
</body>
</html>
`;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export type VerificationChecks = { reachable: boolean; carries_approved_version: boolean; links_to_approved_whatsapp: boolean; captures_tracking: boolean };

/** What was FOUND at the public address, judged against what was approved. Pure: the fetch happens elsewhere. */
export function judgeFetchedPage(input: { status: number; body: string; contentHash: string; whatsappNumber: string; versionId: string }): VerificationChecks {
  const body = input.body;
  const marker = /<meta name="aos-version" content="([0-9a-f]{64})"/.exec(body)?.[1];
  const numbers = [...body.matchAll(/https:\/\/wa\.me\/(\d+)/g)].map((m) => m[1]);
  return {
    reachable: input.status === 200,
    carries_approved_version: marker === input.contentHash,
    links_to_approved_whatsapp: numbers.length > 0 && numbers.every((n) => n === digits(input.whatsappNumber)),
    captures_tracking: body.includes('data-aos-capture=') && body.includes(`data-aos-prefix="${versionPrefix(input.versionId)}"`),
  };
}
