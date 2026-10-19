import { PlusIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { ProjectsView } from './projects-view';

export const metadata: Metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return (
    <>
      <PageHeader
        title="Projects"
        description="Applications in the current workspace and their environments."
        status="preview"
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Projects' }]}
        actions={
          <Button disabled title="Available in Phase 1">
            <PlusIcon aria-hidden="true" />
            New project
          </Button>
        }
      />
      <ProjectsView />
    </>
  );
}
