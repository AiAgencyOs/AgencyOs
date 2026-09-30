'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { createLeadAction } from '@/modules/crm/actions';
import { createClientAccountAction } from '@/modules/sales/actions';
import { filterCommands, type Command } from '@/lib/admin/command-palette-eval';
import { globalSearch, type SearchResult } from '@/lib/admin/global-search';
import { isPreviewGroup } from '@/lib/admin/entity-preview-types';
import type { DraftKind, RecentCommand } from '@/lib/admin/palette-memory';
import type { SavedSearch } from '@/lib/admin/saved-searches';
import { Button, cx, Field, FormMessage, IconChevronRight, IconSearch, inputClass } from '@/ui';

import {
  discardCreateDraftAction,
  listCreateDraftsAction,
  listRecentCommandsAction,
  recordCommandAction,
  saveCreateDraftAction,
} from './palette-actions';
import { CreateChangeRequestForm, CreateQuotationForm, CreateTaskForm, RequestMeetingForm } from './palette-forms';
import { PreviewButton, PreviewDrawerProvider } from './preview-drawer';
import { CreateProjectForm, MilestoneInvoiceForm } from './quick-create-forms';
import { listMySearchesAction } from './search/search-actions';

import { OPEN_CREATE_EVENT, type CreateMode as RequestedMode } from './shell-controls';

const SEARCH_DEBOUNCE_MS = 200;

type CreateMode = DraftKind | null;

/** One row the palette can show: a page/record to jump to, or an action to run. */
type Entry = { key: string; label: string; group: string; href?: string; onSelect?: () => void; previewGroup?: string; previewId?: string };

/**
 * The ⌘K command palette — a keyboard-first way to jump anywhere in the control
 * plane, and — since SCR-004 confirmed the gap — to start the records nothing
 * in the product could create from nothing. The command list is prepared on
 * the server and is already capability-filtered, so the palette can only ever
 * navigate to pages, or offer creates, the role may actually perform; it
 * makes no authority decision of its own, only text matching, navigation,
 * and — for the create forms — a call to the same gated door the rest of the
 * product uses.
 *
 * Bucket F (stream F-A) finished SCR-004's list: in-place forms for a task,
 * a quotation, a meeting and a change request (existing doors); the current
 * route's project, lead or client pre-fills the form; the last twenty
 * commands the person ran are offered back (`core.recent_commands`); and a
 * form closed halfway is saved as a draft and restored when it opens again
 * (`core.create_drafts`). Record results carry a Preview that opens the
 * shared `PreviewDrawer`.
 *
 * One instance, two triggers' worth of appearance: a search field on a desktop
 * and a single icon on a phone, switched by CSS. Rendering the component twice
 * to get both would bind ⌘K twice and open two dialogs on top of each other.
 */
export function CommandPalette({
  commands,
  canCreateLead = false,
  canCreateClient = false,
  canCreateQuotation = false,
  canCreateTask = false,
  canCreateProject = false,
  canCreateInvoice = false,
}: {
  commands: Command[];
  canCreateLead?: boolean;
  canCreateClient?: boolean;
  canCreateQuotation?: boolean;
  canCreateTask?: boolean;
  /** `project.write` — the by-hand project door (SCR-004). */
  canCreateProject?: boolean;
  /** `invoice.create` — the milestone-invoice picker (SCR-004). */
  canCreateInvoice?: boolean;
}) {
  const pathname = usePathname();
  // Route context: a create started from inside a project, a lead or a
  // client lands on that record rather than on an empty picker.
  const projectMatch = /^\/projects\/([0-9a-f-]{36})/.exec(pathname);
  const leadMatch = /^\/leads\/([0-9a-f-]{36})/.exec(pathname);
  const clientMatch = /^\/clients\/([0-9a-f-]{36})/.exec(pathname);
  const context = useMemo(
    () => ({ projectId: projectMatch?.[1], leadId: leadMatch?.[1], clientAccountId: clientMatch?.[1] }),
    [projectMatch, leadMatch, clientMatch],
  );
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  // SCR-002: the person's own recent and saved searches, read when the
  // palette opens (the layout itself makes no database read).
  const [mySearches, setMySearches] = useState<{ saved: SavedSearch[]; recent: SavedSearch[] }>({ saved: [], recent: [] });
  // SCR-004: recent commands and saved drafts, read the same way.
  const [recentCommands, setRecentCommands] = useState<RecentCommand[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<DraftKind, Record<string, string>>>>({});
  // The fields of the form currently showing, kept in a ref so reporting
  // them does not re-render the palette on every keystroke.
  const liveFields = useRef<{ kind: DraftKind; fields: Record<string, string> } | null>(null);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced real-record search — leads/clients/projects/invoices and the
  // rest, RLS-scoped the same as their own pages. The page-link filter below
  // stays instant and client-side; this is the part that needed a round trip.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setRecords([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = setTimeout(() => {
      globalSearch(trimmed)
        .then((r) => setRecords(r))
        .catch(() => setRecords([]))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Portalled to <body> for the same reason the nav drawer is: this trigger
  // sits inside a `backdrop-blur` header, and a backdrop-filter turns that
  // header into the containing block for `fixed` children — which would
  // squeeze the dialog into a 56px strip instead of centring it on screen.
  useEffect(() => setMounted(true), []);

  const pageResults = useMemo(() => filterCommands(commands, query), [commands, query]);

  const createEntries = useMemo(() => {
    const entries: Entry[] = [];
    const where = projectMatch ? ' in this project' : '';
    const forLead = leadMatch ? ' for this lead' : '';
    if (canCreateLead) entries.push({ key: 'create-lead', label: 'New lead', group: 'Create', onSelect: () => setCreateMode('lead') });
    if (canCreateClient) entries.push({ key: 'create-client', label: 'New client', group: 'Create', onSelect: () => setCreateMode('client') });
    if (canCreateQuotation) entries.push({ key: 'create-quotation', label: `New quotation${forLead}`, group: 'Create', onSelect: () => setCreateMode('quotation') });
    if (canCreateTask) entries.push({ key: 'create-task', label: `New task${where}`, group: 'Create', onSelect: () => setCreateMode('task') });
    if (canCreateLead) entries.push({ key: 'create-meeting', label: `Request a meeting${forLead}`, group: 'Create', onSelect: () => setCreateMode('meeting') });
    // SCR-004 — the two records that had no by-hand door: a project not
    // born from a won deal, and an invoice drafted for a milestone without
    // first opening the project's billing panel.
    if (canCreateProject) entries.push({ key: 'create-project', label: clientMatch ? 'New project for this client' : 'New project', group: 'Create', onSelect: () => setCreateMode('project') });
    if (canCreateInvoice) entries.push({ key: 'create-invoice', label: `Invoice from milestone${where}`, group: 'Create', onSelect: () => setCreateMode('invoice') });
    if (canCreateProject) entries.push({ key: 'create-change-request', label: `New change request${where}`, group: 'Create', onSelect: () => setCreateMode('change_request') });
    if (entries.length === 0) return entries;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;
    return entries.filter((e) => terms.every((t) => `${e.label} ${e.group}`.toLowerCase().includes(t)));
  }, [canCreateLead, canCreateClient, canCreateQuotation, canCreateTask, canCreateProject, canCreateInvoice, projectMatch, leadMatch, clientMatch, query]);

  // Creates first — starting something new is rarer than finding something
  // that exists, but exactly as fast to offer, and "new lead" should not have
  // to outrank every page whose name contains "lead". Records next, since a
  // specific record is almost always what somebody typing more than a page
  // name is looking for.
  const results = useMemo<Entry[]>(() => {
    const trimmed = query.trim();
    // SCR-002: the palette shows five per entity; the /search page shows all
    // of them, with type and date filters. Offered whenever a record search
    // is even possible, so an empty palette still has somewhere to go.
    const seeAll: Entry[] =
      trimmed.length >= 2
        ? [
            {
              key: `see-all:${trimmed}`,
              label: `See all results for “${trimmed}”`,
              group: 'Search',
              href: `/search?q=${encodeURIComponent(trimmed)}`,
            },
          ]
        : [];
    const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    // SCR-004: recent commands — every one on an empty palette (the pages
    // among them ahead of the full page list), the matching ones otherwise.
    const commandEntries: Entry[] = recentCommands
      .filter((c) => terms.every((t) => c.label.toLowerCase().includes(t)))
      .slice(0, trimmed ? 5 : RECENT_SHOWN)
      .map((c) => ({ key: `recent-command:${c.key}`, label: c.label, group: 'Recent command', href: c.href ?? undefined }));
    // Saved and recent searches: all of them on an empty palette, and the
    // ones whose name or query contains the typed text otherwise.
    const matches = (e: SavedSearch) => terms.every((t) => `${e.name ?? ''} ${e.query}`.toLowerCase().includes(t));
    const searchEntries: Entry[] = [
      ...mySearches.saved.filter(matches).map((e) => ({ key: `saved:${e.id}`, label: `${e.name} — “${e.query}”`, group: 'Saved search', href: e.href })),
      ...mySearches.recent.filter(matches).slice(0, 5).map((e) => ({ key: `recent:${e.id}`, label: `“${e.query}”`, group: 'Recent search', href: e.href })),
    ];
    return [
      ...createEntries,
      ...records.map((r) => ({
        key: `${r.group}:${r.id}`,
        label: r.label,
        group: r.group,
        href: r.href,
        ...(isPreviewGroup(r.group) ? { previewGroup: r.group, previewId: r.id } : {}),
      })),
      ...seeAll,
      ...commandEntries,
      ...searchEntries,
      ...pageResults.map((c) => ({ key: c.href, label: c.label, group: c.group, href: c.href })),
    ];
  }, [createEntries, records, pageResults, query, mySearches, recentCommands]);

  // A draft is saved when the dialog closes on a form with something typed,
  // and discarded when the record is created. `liveFields` is what the form
  // reported last; nothing is read back from the DOM.
  const flushDraft = useCallback(() => {
    const current = liveFields.current;
    if (!current) return;
    liveFields.current = null;
    const meaningful = Object.values(current.fields).some((v) => v.trim().length > 0);
    setDrafts((d) => ({ ...d, [current.kind]: meaningful ? current.fields : undefined }));
    saveCreateDraftAction(current.kind, current.fields).catch(() => undefined);
  }, []);

  const close = useCallback(() => {
    flushDraft();
    setOpen(false);
  }, [flushDraft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => {
          if (o) flushDraft();
          return !o;
        });
      } else if (e.key === 'Escape') {
        close();
      }
    };
    // The header's "+ Create" button and the dashboard's quick actions: open
    // straight onto the requested create when the role may perform it, else
    // the first create it may, else the search.
    const onCreate = (e: Event) => {
      const wanted = (e as CustomEvent<RequestedMode | undefined>).detail;
      const allowed: Record<Exclude<RequestedMode, undefined>, boolean> = {
        lead: canCreateLead,
        client: canCreateClient,
        project: canCreateProject,
        invoice: canCreateInvoice,
        task: canCreateTask,
        quotation: canCreateQuotation,
        meeting: canCreateLead,
        change_request: canCreateProject,
      };
      const mode: CreateMode = wanted && allowed[wanted] ? wanted : canCreateLead ? 'lead' : canCreateClient ? 'client' : null;
      setOpen(true);
      setTimeout(() => setCreateMode(mode), 0);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_CREATE_EVENT, onCreate);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_CREATE_EVENT, onCreate);
    };
  }, [canCreateLead, canCreateClient, canCreateProject, canCreateInvoice, canCreateTask, canCreateQuotation, close, flushDraft]);

  useEffect(() => {
    if (open) {
      listMySearchesAction()
        .then(setMySearches)
        .catch(() => setMySearches({ saved: [], recent: [] }));
      listRecentCommandsAction()
        .then(setRecentCommands)
        .catch(() => setRecentCommands([]));
      listCreateDraftsAction()
        .then((rows) => setDrafts(Object.fromEntries(rows.map((r) => [r.kind, r.draft]))))
        .catch(() => setDrafts({}));
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setCreateMode(null);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  /** The record was created: the draft is spent, and the palette moves on. */
  const created = (kind: DraftKind) => (href: string) => {
    liveFields.current = null;
    setDrafts((d) => ({ ...d, [kind]: undefined }));
    discardCreateDraftAction(kind).catch(() => undefined);
    go(href);
  };

  const cancelForm = () => {
    flushDraft();
    setCreateMode(null);
  };

  const select = (entry: Entry) => {
    if (!entry.key.startsWith('recent-command:') && !entry.key.startsWith('see-all:')) {
      recordCommandAction({ key: entry.key, label: entry.label, href: entry.href ?? null }).catch(() => undefined);
    }
    if (entry.onSelect) entry.onSelect();
    else if (entry.href) go(entry.href);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = results[active];
      if (c) select(c);
    }
  };

  const onFieldsFor = (kind: DraftKind) => (fields: Record<string, string>) => {
    liveFields.current = { kind, fields };
  };

  const formProps = (kind: DraftKind) => ({
    onCancel: cancelForm,
    onCreated: created(kind),
    draft: drafts[kind],
    onFields: onFieldsFor(kind),
    context,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search pages"
        className={cx(
          'flex items-center gap-2 rounded-lg text-muted transition-colors',
          // Phone: a 40px icon target. Desktop: a real search field.
          'h-10 w-10 justify-center hover:bg-surface-hover hover:text-foreground',
          'md:h-9 md:w-full md:max-w-[26rem] md:flex-1 md:justify-start md:border md:border-line md:bg-surface-sunken md:px-3 md:hover:border-line-strong md:hover:bg-surface',
        )}
      >
        <IconSearch size={18} className="shrink-0" />
        <span className="hidden flex-1 truncate text-left text-[13px] md:block">Search anything… (leads, clients, projects, messages)</span>
        <kbd className="hidden rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted md:block">
          ⌘K
        </kbd>
      </button>

      {open && mounted
        ? createPortal(
        <PreviewDrawerProvider>
        <div
          className="animate-fade fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
          onClick={close}
          role="presentation"
        >
          <div
            className="animate-rise w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-overlay shadow-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            {createMode === 'project' ? (
              <CreateProjectForm onCancel={cancelForm} onCreated={created('project')} draft={drafts.project} onFields={onFieldsFor('project')} initialClientAccountId={context.clientAccountId} />
            ) : createMode === 'invoice' ? (
              <MilestoneInvoiceForm onCancel={cancelForm} onCreated={created('invoice')} initialProjectId={context.projectId} />
            ) : createMode === 'task' ? (
              <CreateTaskForm {...formProps('task')} />
            ) : createMode === 'quotation' ? (
              <CreateQuotationForm {...formProps('quotation')} />
            ) : createMode === 'meeting' ? (
              <RequestMeetingForm {...formProps('meeting')} />
            ) : createMode === 'change_request' ? (
              <CreateChangeRequestForm {...formProps('change_request')} />
            ) : createMode ? (
              <CreateForm
                mode={createMode}
                onCancel={cancelForm}
                onCreated={created(createMode)}
                draft={drafts[createMode]}
                onFields={onFieldsFor(createMode)}
              />
            ) : (
              <>
                <div className="flex items-center gap-2.5 border-b border-line px-4">
                  <IconSearch size={18} className="shrink-0 text-faint" />
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onInputKey}
                    placeholder="Search leads, clients, projects, invoices, or jump to a page…"
                    aria-label="Command search"
                    className="w-full bg-transparent py-3.5 text-[15px] text-foreground outline-none placeholder:text-faint"
                  />
                </div>
                <ul className="max-h-[60vh] overflow-y-auto p-1.5">
                  {results.length === 0 ? (
                    <li className="px-3 py-6 text-center text-sm text-muted">
                      {searching ? 'Searching…' : 'No matches.'}
                    </li>
                  ) : (
                    results.map((c, i) => (
                      <li key={c.key} className="flex items-center">
                        <button
                          type="button"
                          onClick={() => select(c)}
                          onMouseEnter={() => setActive(i)}
                          className={cx(
                            'flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                            i === active ? 'bg-brand-soft text-brand' : 'text-foreground',
                          )}
                        >
                          <span className="flex-1 truncate font-medium">
                            {c.label}
                            {c.key.startsWith('create-') && drafts[c.key.slice('create-'.length).replace(/-/g, '_') as DraftKind] ? (
                              <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">draft saved</span>
                            ) : null}
                          </span>
                          <span className="text-xs text-muted">{c.group}</span>
                          <IconChevronRight size={14} className="text-faint" />
                        </button>
                        {c.previewGroup && c.previewId ? (
                          <PreviewButton group={c.previewGroup} id={c.previewId} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground" />
                        ) : null}
                      </li>
                    ))
                  )}
                </ul>
              </>
            )}
          </div>
        </div>
        </PreviewDrawerProvider>,
            document.body,
          )
        : null}
    </>
  );
}

/** How many recent commands an empty palette shows before the page list. */
const RECENT_SHOWN = 8;

/**
 * The two forms Quick Create first needed, inline in the same dialog rather
 * than a second overlay on top of it. Deliberately minimal: a lead needs a
 * title and a reachable contact (`createLeadSchema`'s own rule, restated here
 * only as which fields are required — the service is still where it is
 * enforced); a client needs a name. Everything else these records can carry
 * is added later, on the record's own page.
 */
function CreateForm({
  mode,
  onCancel,
  onCreated,
  draft,
  onFields,
}: {
  mode: 'lead' | 'client';
  onCancel: () => void;
  onCreated: (href: string) => void;
  draft?: Record<string, string>;
  onFields?: (fields: Record<string, string>) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState(() => ({
    title: draft?.title ?? '',
    contactName: draft?.contactName ?? '',
    contactEmail: draft?.contactEmail ?? '',
    contactPhone: draft?.contactPhone ?? '',
    name: draft?.name ?? '',
    billingEmail: draft?.billingEmail ?? '',
  }));

  useEffect(() => {
    onFields?.(fields);
  }, [fields, onFields]);

  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    if (mode === 'lead') {
      const result = await createLeadAction({
        title: fields.title,
        contactName: fields.contactName,
        contactEmail: fields.contactEmail,
        contactPhone: fields.contactPhone,
      });
      setSubmitting(false);
      if (!result.ok) return setError(result.error.message);
      onCreated(`/leads/${result.data.leadId}`);
    } else {
      const result = await createClientAccountAction({
        name: fields.name,
        billingEmail: fields.billingEmail,
      });
      setSubmitting(false);
      if (!result.ok) return setError(result.error.message);
      onCreated(`/clients/${result.data.clientAccountId}`);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">{mode === 'lead' ? 'New lead' : 'New client'}</h2>
      {draft && Object.values(draft).some(Boolean) ? <p className="text-xs text-muted">Restored from the draft you left.</p> : null}

      {mode === 'lead' ? (
        <>
          <Field label="Lead title" htmlFor="qc-title" required>
            <input
              id="qc-title"
              required
              value={fields.title}
              onChange={set('title')}
              className={inputClass}
              placeholder="e.g. Website redesign for Acme"
            />
          </Field>
          <Field label="Contact name" htmlFor="qc-contact-name" required>
            <input
              id="qc-contact-name"
              required
              value={fields.contactName}
              onChange={set('contactName')}
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" htmlFor="qc-email" hint="Email or phone is required.">
              <input
                id="qc-email"
                type="email"
                value={fields.contactEmail}
                onChange={set('contactEmail')}
                className={inputClass}
              />
            </Field>
            <Field label="Phone" htmlFor="qc-phone">
              <input id="qc-phone" value={fields.contactPhone} onChange={set('contactPhone')} className={inputClass} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Client name" htmlFor="qc-name" required>
            <input id="qc-name" required value={fields.name} onChange={set('name')} className={inputClass} />
          </Field>
          <Field label="Billing email" htmlFor="qc-billing-email">
            <input
              id="qc-billing-email"
              type="email"
              value={fields.billingEmail}
              onChange={set('billingEmail')}
              className={inputClass}
            />
          </Field>
        </>
      )}

      <FormMessage status={error ? 'error' : 'idle'} message={error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
