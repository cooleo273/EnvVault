import { getAuth } from '@/lib/auth/server';

/**
 * Neon Auth API proxy (sign-in, sign-up, session refresh, email verification,
 * password reset, OAuth callbacks). Keeps auth cookies first-party.
 */
interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return getAuth().handler().GET(request, context);
}

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return getAuth().handler().POST(request, context);
}
