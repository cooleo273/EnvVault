import { Bell } from 'lucide-react';
import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata: Metadata = { title: 'Notifications' };

export default function Page() {
  return (
    <ModulePlaceholder
      title="Notifications"
      description="Invitations, approval requests and rotation reminders."
      icon={Bell}
      upcoming="Notifications will appear once workspaces, change approvals and rotation policies are active."
    />
  );
}
