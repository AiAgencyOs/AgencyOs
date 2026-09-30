'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { helpAnchor, searchScreens, type HelpScreen } from '@/lib/help/screens';
import { Badge, Card, cx, EmptyState, IconSearch, inputClass } from '@/ui';

/**
 * The Help index with a search box — filters the generated entries in the
 * browser, one card per screen, grouped by the module the inventory puts
 * them under. The list itself came from the server as data; nothing here is
 * fetched or invented.
 */
export function HelpSearch({ screens, initialQuery }: { screens: readonly HelpScreen[]; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const matches = useMemo(() => searchScreens(query, screens), [query, screens]);

  const groups = useMemo(() => {
    const byModule = new Map<string, HelpScreen[]>();
    for (const s of matches) {
      const list = byModule.get(s.module) ?? [];
      list.push(s);
      byModule.set(s.module, list);
    }
    return [...byModule.entries()];
  }, [matches]);

  return (
    <div className="flex flex-col gap-5">
      <label className="relative block">
        <span className="sr-only">Search screens</span>
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          name="q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by screen, route, capability or what it reads…"
          autoComplete="off"
          className={cx(inputClass, 'pl-9')}
        />
      </label>
      <p className="text-[13px] text-muted">
        {matches.length} of {screens.length} screens
        {query.trim() ? (
          <>
            {' '}
            match &ldquo;{query.trim()}&rdquo;
          </>
        ) : null}
      </p>

      {groups.length === 0 ? (
        <EmptyState title="No screen matches" description="Try a route like /invoices, a capability like lead.read, or a word from a screen's name." />
      ) : (
        groups.map(([module, items]) => (
          <section key={module} className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{module}</h2>
            {items.map((s) => (
              <Card key={s.id} id={helpAnchor(s.id)} className="scroll-mt-20 px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      <span className="mr-2 font-mono text-[11px] font-medium text-muted">{s.id}</span>
                      {s.title}
                    </p>
                    <p className="mt-0.5 text-[13px] text-muted">
                      {s.routes.length > 0 ? (
                        s.routes.map((r, i) => (
                          <span key={r}>
                            {i > 0 ? ' · ' : null}
                            {r.includes('[') || r.startsWith('/api/') ? (
                              <code className="font-mono text-[12px]">{r}</code>
                            ) : (
                              <Link href={r} className="font-mono text-[12px] underline-offset-2 hover:underline">
                                {r}
                              </Link>
                            )}
                          </span>
                        ))
                      ) : (
                        <span>{s.route}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
                    <Badge wrap tone={s.status.startsWith('COMPLETE') ? 'success' : s.status.startsWith('GROUPED') ? 'info' : 'warning'}>
                      {s.status}
                    </Badge>
                    <Badge tone="neutral">{s.capability}</Badge>
                  </div>
                </div>
                <dl className="mt-2.5 grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[6rem_1fr]">
                  <dt className="text-muted">Reads</dt>
                  <dd className="break-words text-foreground">{s.reads || '—'}</dd>
                  <dt className="text-muted">Live</dt>
                  <dd className="text-foreground">{s.live || '—'}</dd>
                </dl>
              </Card>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
