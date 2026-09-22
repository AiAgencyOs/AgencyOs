'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { createLeadAction } from '@/modules/crm/actions';
import { createClientAccountAction } from '@/modules/sales/actions';
import { filterCommands, type Command } from '@/lib/admin/command-palette-eval';
import { globalSearch, type SearchResult } from '@/lib/admin/global-search';
import { Button, cx, Field, FormMessage, IconChevronRight, IconSearch, inputClass } from '@/ui';

const SEARCH_DEBOUNCE_MS = 200;

type CreateMode = 'lead' | 'client' | null;

/** One row the palette can show: a page/record to jump to, or an action to run. */
type Entry = { key: string; label: string; group: string; href?: string; onSelect?: () => void };

/**
 * The ⌘K command palette — a keyboard-first way to jump anywhere in the control
 * plane, and — since SCR-004 confirmed the gap — to start the two records
 * nothing in the product could create from nothing: a lead entered directly
 * rather than arriving by chat, and a client onboarded before any deal exists
 * to convert. The command list is prepared on the server and is already
 * capability-filtered, so the palette can only ever navigate to pages, or
 * offer creates, the role may actually perform; it makes no authority
 * decision of its own, only text matching, navigation, and — for the two
 * create forms — a call to the same gated service the rest of the product
 * uses.
 *
 * One instance, two triggers' worth of appearance: a search field on a desktop
 * and a single icon on a phone, switched by CSS. Rendering the component twice
 * to get both would bind ⌘K twice and open two dialogs on top of each other.
 */
export function CommandPalette({
  commands,
  canCreateLead = false,
  canCreateClient = false,
}: {
  commands: Command[];
  canCreateLead?: boolean;
  canCreateClient?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced real-record search — leads/clients/projects/invoices,
  // RLS-scoped the same as their own pages. The page-link filter below stays
  // instant and client-side; this is the part that needed a round trip.
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
    if (canCreateLead) entries.push({ key: 'create-lead', label: 'New lead', group: 'Create', onSelect: () => setCreateMode('lead') });
    if (canCreateClient) entries.push({ key: 'create-client', label: 'New client', group: 'Create', onSelect: () => setCreateMode('client') });
    if (entries.length === 0) return entries;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;
    return entries.filter((e) => terms.every((t) => `${e.label} ${e.group}`.toLowerCase().includes(t)));
  }, [canCreateLead, canCreateClient, query]);

  // Creates first — starting something new is rarer than finding something
  // that exists, but exactly as fast to offer, and "new lead" should not have
  // to outrank every page whose name contains "lead". Records next, since a
  // specific record is almost always what somebody typing more than a page
  // name is looking for.
  const results = useMemo<Entry[]>(
    () => [
      ...createEntries,
      ...records.map((r) => ({ key: r.href, label: r.label, group: r.group, href: r.href })),
      ...pageResults.map((c) => ({ key: c.href, label: c.label, group: c.group, href: c.href })),
    ],
    [createEntries, records, pageResults],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const select = (entry: Entry) => {
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
          'md:h-9 md:w-full md:max-w-sm md:justify-start md:border md:border-line md:bg-surface-sunken md:px-3 md:hover:border-line-strong md:hover:bg-surface',
        )}
      >
        <IconSearch size={18} className="shrink-0" />
        <span className="hidden flex-1 text-left text-[13px] md:block">Search…</span>
        <kbd className="hidden rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint md:block">
          ⌘K
        </kbd>
      </button>

      {open && mounted
        ? createPortal(
        <div
          className="animate-fade fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="animate-rise w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-overlay shadow-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            {createMode ? (
              <CreateForm
                mode={createMode}
                onCancel={() => setCreateMode(null)}
                onCreated={go}
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
                      <li key={c.key}>
                        <button
                          type="button"
                          onClick={() => select(c)}
                          onMouseEnter={() => setActive(i)}
                          className={cx(
                            'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                            i === active ? 'bg-brand-soft text-brand' : 'text-foreground',
                          )}
                        >
                          <span className="flex-1 font-medium">{c.label}</span>
                          <span className="text-xs text-muted">{c.group}</span>
                          <IconChevronRight size={14} className="text-faint" />
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </>
            )}
          </div>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The two forms Quick Create actually needs, inline in the same dialog rather
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
}: {
  mode: 'lead' | 'client';
  onCancel: () => void;
  onCreated: (href: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState({
    title: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    name: '',
    billingEmail: '',
  });

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
