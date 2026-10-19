import { redirect } from 'next/navigation';
import { resolveLanding } from '@/lib/workspaces/landing';
import { getMe } from '@/lib/workspaces/server';

/** Shortcut from the main navigation to the active workspace's members. */
export default async function MembersShortcut() {
  const me = await getMe();
  if (!me) redirect('/workspaces');
  const landing = resolveLanding(me);
  redirect(landing.kind === 'onboarding' ? '/onboarding' : `${landing.href}/members`);
}
