import type { NextRequest } from 'next/server';
import { AUTH_ROUTES } from '@/config/routes';
import { getAuth } from '@/lib/auth/server';

const LOGIN_URL = AUTH_ROUTES.login;

/**
 * Route protection (Next.js 16 proxy, formerly middleware). Neon Auth's
 * middleware validates the session cookie, refreshes it when needed and
 * redirects anonymous visitors to sign-in. Server layouts re-check the session
 * (defence in depth) and the API independently verifies every request.
 */
export default async function proxy(request: NextRequest) {
  const response = await getAuth().middleware({ loginUrl: LOGIN_URL })(request);

  // Remember where the visitor was going; sign-in validates it before use.
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) {
    const target = new URL(location, request.url);
    if (target.pathname === LOGIN_URL && !target.searchParams.has('redirectTo')) {
      target.searchParams.set('redirectTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
      response.headers.set('location', target.toString());
    }
  }
  return response;
}

export const config = {
  // Authenticated application routes. Public: '/', the auth pages
  // (/login, /signup, ...), '/invite' (prompts to sign in) and '/api/auth/*'.
  matcher: [
    '/dashboard/:path*',
    '/onboarding/:path*',
    '/workspaces/:path*',
    '/projects/:path*',
    '/members/:path*',
    '/audit-logs/:path*',
    '/integrations/:path*',
    '/notifications/:path*',
    '/settings/:path*',
    '/design-system/:path*',
  ],
};
