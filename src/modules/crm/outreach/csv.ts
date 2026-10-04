/**
 * Prospect list parsing - pure. A pasted CSV (header row required) becomes the rows
 * `crm.add_outreach_prospects` accepts. Nothing here decides whether anyone may be emailed:
 * that is the database's (provenance, lawful basis, suppression) and the chokepoint's.
 */

export type ProspectRow = {
  email: string;
  fullName?: string;
  company?: string;
  jobTitle?: string;
  website?: string;
  language?: 'en' | 'hinglish' | 'hindi';
  tags?: string[];
  provenance: string;
  lawfulBasis?: 'consent' | 'existing_relationship' | 'b2b_legitimate_interest';
};

export type ParsedProspects = { rows: ProspectRow[]; problems: { line: number; problem: string }[] };

const ALIASES: Record<string, keyof ProspectRow> = {
  email: 'email', 'e-mail': 'email', mail: 'email',
  name: 'fullName', fullname: 'fullName', full_name: 'fullName', 'full name': 'fullName',
  company: 'company', organisation: 'company', organization: 'company',
  title: 'jobTitle', jobtitle: 'jobTitle', job_title: 'jobTitle', role: 'jobTitle',
  website: 'website', site: 'website', url: 'website',
  language: 'language', lang: 'language',
  tags: 'tags', tag: 'tags',
  provenance: 'provenance', source: 'provenance',
  basis: 'lawfulBasis', lawfulbasis: 'lawfulBasis', lawful_basis: 'lawfulBasis',
};

/** Split one CSV record, honouring double quotes ("a, b") and doubled quotes inside them. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseProspectCsv(text: string, defaults: { provenance?: string; lawfulBasis?: ProspectRow['lawfulBasis'] } = {}): ParsedProspects {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  const result: ParsedProspects = { rows: [], problems: [] };
  if (lines.length < 2) {
    result.problems.push({ line: 1, problem: 'Paste a header row (email, name, company, ...) and at least one person.' });
    return result;
  }
  const header = splitCsvLine(lines[0]!).map((h) => ALIASES[h.toLowerCase().replace(/\s+/g, ' ')] ?? null);
  if (!header.includes('email')) {
    result.problems.push({ line: 1, problem: 'The first row must name an "email" column.' });
    return result;
  }
  if (lines.length - 1 > 2000) {
    result.problems.push({ line: 1, problem: 'At most 2,000 people at a time.' });
    return result;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    header.forEach((key, idx) => { if (key && cells[idx]) row[key] = cells[idx]!; });
    const email = (row.email ?? '').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { result.problems.push({ line: i + 1, problem: `"${row.email ?? ''}" is not an email address` }); continue; }
    const provenance = row.provenance || defaults.provenance || '';
    if (provenance.trim().length < 3) { result.problems.push({ line: i + 1, problem: 'say how this address was obtained (a provenance column, or one for the whole list)' }); continue; }
    const language = row.language === 'hinglish' || row.language === 'hindi' ? row.language : 'en';
    const basisRaw = (row.lawfulBasis || defaults.lawfulBasis || 'b2b_legitimate_interest') as string;
    if (!['consent', 'existing_relationship', 'b2b_legitimate_interest'].includes(basisRaw)) { result.problems.push({ line: i + 1, problem: `unknown basis "${basisRaw}"` }); continue; }
    result.rows.push({
      email,
      fullName: row.fullName, company: row.company, jobTitle: row.jobTitle, website: row.website,
      language,
      tags: row.tags ? row.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : undefined,
      provenance: provenance.trim(),
      lawfulBasis: basisRaw as ProspectRow['lawfulBasis'],
    });
  }
  return result;
}
