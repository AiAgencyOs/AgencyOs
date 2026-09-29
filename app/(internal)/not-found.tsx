import Link from 'next/link';

import { buttonClass, EmptyState, IconSearch } from '@/ui';

/**
 * The shared rule's "not-found state" (bucket F, stream F-A). Until now a
 * URL that names nothing fell through to Next's default 404 — a page with
 * no rail, no header and no way back. This one keeps the shell (it is the
 * internal group's own boundary, so the layout still wraps it) and says the
 * only two things worth saying: this address names nothing, and here is
 * where to go instead. It makes no database read and guesses at nothing:
 * whether an id was ever valid is a question for the audit log.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col justify-center">
      <EmptyState
        icon={<IconSearch size={22} />}
        title="There is nothing at this address"
        description="The page or record this link names does not exist, was removed, or is not one your role may open. Nothing has been changed."
        action={
          <span className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/dashboard" className={buttonClass('primary', 'sm')}>
              Back to the Command Center
            </Link>
            <Link href="/search" className={buttonClass('secondary', 'sm')}>
              Search for it
            </Link>
          </span>
        }
      />
    </div>
  );
}
