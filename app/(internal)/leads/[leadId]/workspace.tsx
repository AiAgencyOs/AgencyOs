'use client';

import { useState } from 'react';

import { cx } from '@/ui';

/**
 * Three panes: what the business knows about the person, the conversation,
 * and what to do about it — the reference's Lead 360 layout, with the chat
 * in the middle where a chat belongs and the deal beside it, the way
 * WhatsApp Web puts contact info in a rail.
 *
 * At `xl` all three are on screen. Between `lg` and `xl` there is room for
 * two columns, so the information pane folds into the top of the deal
 * column. Below `lg` the panes become two tabs and the chat is the one that
 * opens first: that is what somebody reaching for a phone came to read.
 *
 * The panes are rendered on the server and passed in as props. This component
 * owns which one is visible and nothing else, so no query, capability check or
 * business rule is dragged into the browser to make a tab work.
 */
export function LeadWorkspace({
  chat,
  details,
  side,
  detailsCount,
}: {
  chat: React.ReactNode;
  details: React.ReactNode;
  /** Read-only information about the lead — rendered beside the chat at `xl`, above the details below it. */
  side?: React.ReactNode;
  /** Badge on the Details tab, so a proposal awaiting a decision is visible from the chat. */
  detailsCount?: number;
}) {
  const [tab, setTab] = useState<'chat' | 'details'>('chat');

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        role="tablist"
        aria-label="Lead panes"
        className="flex gap-1 rounded-xl border border-line bg-surface p-1 lg:hidden"
      >
        <Tab active={tab === 'chat'} onClick={() => setTab('chat')}>
          Conversation
        </Tab>
        <Tab active={tab === 'details'} onClick={() => setTab('details')}>
          Deal &amp; requirements
          {detailsCount ? (
            <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold text-warning">
              {detailsCount}
            </span>
          ) : null}
        </Tab>
      </div>

      <div className={cx('grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,380px)]', side ? 'xl:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.6fr)_minmax(320px,1fr)]' : null)}>
        {side ? <div className={cx('hidden min-w-0 xl:block', tab === 'details' ? 'block' : 'hidden')}>{side}</div> : null}
        <div className={cx('min-w-0', tab === 'chat' ? 'block' : 'hidden lg:block')}>{chat}</div>
        <div className={cx('min-w-0', tab === 'details' ? 'block' : 'hidden lg:block')}>
          {side ? <div className="mb-4 hidden lg:block xl:hidden">{side}</div> : null}
          {details}
        </div>
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        'flex min-h-10 flex-1 items-center justify-center rounded-lg text-[13px] font-medium transition-colors',
        active ? 'bg-brand text-brand-fg shadow-xs' : 'text-muted hover:bg-surface-hover',
      )}
    >
      {children}
    </button>
  );
}
