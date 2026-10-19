import type { Metadata } from 'next';
import Link from 'next/link';
import { StatusBadge } from '@/components/feedback/status-badge';
import { SettingsSection } from '@/components/layout/settings-section';
import { ProfileForm } from '@/features/account/profile-form';
import { requireVerifiedUser } from '@/lib/auth/session';
import { getMe } from '@/lib/workspaces/server';
import { AppearanceSettings } from '../appearance-settings';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfileSettingsPage() {
  const user = await requireVerifiedUser('/settings/profile');
  const me = await getMe();
  return (
    <>
      <ProfileForm name={user.name} email={user.email} />

      <SettingsSection
        id="account"
        title="Account"
        badge={<StatusBadge tone="success" label="Email verified" dot={false} />}
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">EnvVault user ID</dt>
          <dd className="font-mono text-xs break-all">{me?.user.id ?? '—'}</dd>
          <dt className="text-muted-foreground">Member since</dt>
          <dd>
            {me
              ? new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(
                  new Date(me.user.createdAt),
                )
              : '—'}
          </dd>
          <dt className="text-muted-foreground">Workspaces</dt>
          <dd>{me ? me.workspaces.length : '—'}</dd>
        </dl>
      </SettingsSection>

      <SettingsSection id="appearance" title="Appearance" description="Saved in this browser.">
        <AppearanceSettings />
      </SettingsSection>

      <SettingsSection id="developer" title="Developer">
        <Link
          href="/design-system"
          className="focus-ring rounded-sm text-sm text-brand hover:underline"
        >
          Open the design system reference
        </Link>
      </SettingsSection>
    </>
  );
}
