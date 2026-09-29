import { IconLock } from '../icons';
import { EmptyState } from './empty-state';

/**
 * The explicit "you may not see this" screen — the page-5 shared rule's
 * permission-denied state, and until now, missing everywhere. Every gated
 * page used to `redirect()` past the person instead: correct for keeping the
 * data out of reach (RLS refuses it either way), but silent about why nothing
 * loaded, which is indistinguishable from a bug to whoever hit it.
 *
 * Deliberately the same shape as `EmptyState` rather than a full-page wall —
 * a role without one capability still has the sidebar and every other screen;
 * this replaces one page's content, not the app around it.
 */
export function PermissionDenied({
  description = 'Your role does not include this. If you believe that is wrong, ask an owner or ops admin.',
}: {
  description?: string;
}) {
  return (
    <EmptyState
      icon={<IconLock size={22} />}
      title="You don't have access to this"
      description={description}
    />
  );
}
