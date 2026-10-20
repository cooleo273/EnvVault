import { redirect } from 'next/navigation';
import { resolveLanding } from '@/lib/workspaces/landing';
import { getMe } from '@/lib/workspaces/server';

/** Sidebar shortcut: the projects of the active workspace. */
export default async function ProjectsShortcut() {
  const me = await getMe();
  if (!me) redirect('/workspaces');
  const landing = resolveLanding(me);
  redirect(landing.kind === 'onboarding' ? '/onboarding' : `${landing.href}/projects`);
}
