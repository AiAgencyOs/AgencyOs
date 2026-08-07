import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/db/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /**
     * Run on every path except static assets and image files.
     *
     * Route protection is deliberately NOT done here — it lands in Feature 3
     * (Authentication) as layout-level guards, where the role claims are
     * available. Middleware only refreshes the session.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
