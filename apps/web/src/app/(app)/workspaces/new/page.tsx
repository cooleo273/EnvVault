import type { Metadata } from 'next';
import { PageHeader } from '@/components/layout/page-header';
import { CreateWorkspaceForm } from '@/features/workspaces/create-workspace-form';

export const metadata: Metadata = { title: 'New workspace' };

export default function NewWorkspacePage() {
  return (
    <>
      <PageHeader
        title="New workspace"
        description="You will be the owner. Projects, members and encryption keys are isolated per workspace."
        breadcrumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: 'New workspace' }]}
      />
      <div className="max-w-xl rounded-lg border bg-surface p-5">
        <CreateWorkspaceForm />
      </div>
    </>
  );
}
