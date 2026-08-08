import { redirect } from 'next/navigation';

import { isClientRole, isInternalRole } from '@/lib/auth/claims';
import { getAuthContext } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** Routes each audience to its own shell. */
export default async function HomePage() {
  const context = await getAuthContext();

  if (!context) redirect('/login');
  if (isInternalRole(context.role)) redirect('/dashboard');
  if (isClientRole(context.role)) redirect('/portal');

  redirect('/no-access');
}
