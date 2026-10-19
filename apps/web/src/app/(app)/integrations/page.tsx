import { Blocks } from 'lucide-react';
import type { Metadata } from 'next';
import { ModulePlaceholder } from '@/components/layout/module-placeholder';

export const metadata: Metadata = { title: 'Integrations' };

export default function Page() {
  return (
    <ModulePlaceholder
      title="Integrations"
      description="Connect EnvVault to CI/CD pipelines and cloud platforms."
      icon={Blocks}
      upcoming="Sync environments to GitHub, GitLab, Vercel and cloud secret stores using scoped machine identities (Phase 3)."
      primaryActionLabel="Add integration"
    />
  );
}
