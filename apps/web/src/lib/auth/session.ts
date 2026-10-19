import 'server-only';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getAuth } from './server';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

/**
 * The current Neon Auth session user, or null. Deduplicated per request.
 * Identity for display and routing only: the EnvVault API re-verifies a
 * signed token on every call and makes all authorization decisions.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  let data;
  try {
    ({ data } = await getAuth().getSession());
  } catch {
    // With a stale or revoked session cookie the SDK may try to rewrite
    // cookies, which Next.js forbids while rendering a Server Component.
    // Fail closed: treat the visitor as signed out.
    return null;
  }
  const user = data?.user;
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name || null,
    emailVerified: user.emailVerified,
  };
});

/** Redirects to sign-in (preserving the destination) unless signed in with a verified email. */
export async function requireVerifiedUser(returnTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?redirectTo=${encodeURIComponent(returnTo)}`);
  }
  if (!user.emailVerified) {
    redirect('/verify-email');
  }
  return user;
}
