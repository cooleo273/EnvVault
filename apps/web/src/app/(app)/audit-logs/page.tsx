import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata: Metadata = { title: 'Audit Logs' };

export default function Page() {
  return (
    <ModulePlaceholder
      title="Audit Logs"
      description="An append-only record of who accessed or changed what, and when."
      icon={ScrollText}
      upcoming="Every secret read, write and permission change will be recorded here — never the secret values themselves. Requires authentication (Phase 1)."
    />
  );
}
