import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { defaultTemplateText, PM_LANGUAGES, PM_TEMPLATES } from '@/modules/projects/pm-template-model';
import { listPmTemplateVersions, type PmTemplateVersion } from '@/modules/projects/pm-template-service';
import { Badge, Card, CardHeader } from '@/ui';

import { DecisionForm, DraftEditor, VersionActions } from './template-forms';

export const metadata: Metadata = { title: 'PM message templates' };

const LANGUAGE_LABEL: Record<string, string> = { en: 'English', hinglish: 'Hinglish', hindi: 'Hindi' };

/**
 * PM client-message templates (P2-PM-006, P2-FLOW-026). What the PM says to a client is the wording in code until an Admin approves a different one: anyone
 * who can write may draft and submit a version, only an owner or ops admin approves or rejects, an approved version supersedes the previous one, and nothing
 * that left draft is edited or deleted. A body may use only the placeholders the template offers and may not state an amount, make a promise, carry a link
 * or name the model behind the PM; the database refuses it otherwise.
 */
export default async function PmTemplatesPage() {
  const context = await requireInternal('/settings/pm-templates');
  const mayDraft = can(context, 'project.write');
  const mayDecide = can(context, 'organization.settings');
  const versions = await listPmTemplateVersions();
  const slot = (key: string, language: string) => versions.filter((v) => v.templateKey === key && v.language === language);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[13px] text-muted">
        Until a version is approved, the PM uses the built-in wording shown here. A draft or a version waiting for review changes nothing a client sees.
      </p>
      {PM_TEMPLATES.map((t) => (
        <Card key={t.key}>
          <CardHeader title={t.label} description={`${t.when}${t.placeholders.length > 0 ? ` Placeholders: ${t.placeholders.map((p) => `{${p}}`).join(', ')}.` : ''}`} />
          <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
            {PM_LANGUAGES.map((language) => {
              const rows: PmTemplateVersion[] = slot(t.key, language);
              const approved = rows.find((r) => r.status === 'approved') ?? null;
              const open = rows.find((r) => r.status === 'draft' || r.status === 'pending_review') ?? null;
              const history = rows.filter((r) => r !== approved && r !== open);
              const builtIn = defaultTemplateText(t.key, language);
              return (
                <details key={language} className="rounded-lg border border-line px-3 py-2" open={open !== null}>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium">{LANGUAGE_LABEL[language]}</span>
                    {approved ? <Badge tone="success">Approved version {approved.version} is live</Badge> : <Badge tone="neutral">Built-in wording</Badge>}
                    {open ? <Badge tone="warning">{open.status === 'draft' ? `Draft v${open.version}` : `Version ${open.version} awaiting review`}</Badge> : null}
                  </summary>
                  <div className="mt-3 flex flex-col gap-3 text-[13px]">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted">{approved ? `Live (version ${approved.version})` : 'Live (built in)'}</p>
                      <p className="whitespace-pre-wrap rounded bg-surface-hover p-2">{approved ? approved.body : builtIn}</p>
                    </div>
                    {open ? (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted">{open.status === 'draft' ? 'Your draft' : 'Waiting for an Admin'}</p>
                        <p className="whitespace-pre-wrap rounded bg-surface-hover p-2">{open.body}</p>
                        <div className="mt-2 flex flex-col gap-2">
                          {mayDraft ? <VersionActions id={open.id} status={open.status} /> : null}
                          {mayDecide && open.status === 'pending_review' ? <DecisionForm id={open.id} /> : null}
                        </div>
                      </div>
                    ) : null}
                    {mayDraft && (!open || open.status === 'draft') ? (
                      <DraftEditor templateKey={t.key} language={language} initial={open?.body ?? approved?.body ?? builtIn} hasDraft={open !== null} />
                    ) : null}
                    {history.length > 0 ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted">History ({history.length})</summary>
                        <ul className="mt-2 flex flex-col gap-2">
                          {history.map((h) => (
                            <li key={h.id} className="rounded border border-line p-2">
                              <span className="font-medium">Version {h.version}</span> · {h.status.replace('_', ' ')}
                              {h.decisionNote ? <span className="text-muted"> · {h.decisionNote}</span> : null}
                              <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{h.body}</p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}
