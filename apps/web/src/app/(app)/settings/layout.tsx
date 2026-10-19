import { PageHeader } from '@/components/layout/page-header';
import { WorkspaceTabs } from '@/features/workspaces/workspace-tabs';

export default function AccountSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader
        title="Account settings"
        description="Your profile and sign-in security. Your identity is managed by Neon Auth."
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Account settings' }]}
      />
      <WorkspaceTabs
        tabs={[
          { href: '/settings/profile', label: 'Profile' },
          { href: '/settings/security', label: 'Security' },
        ]}
      />
      {children}
    </>
  );
}
