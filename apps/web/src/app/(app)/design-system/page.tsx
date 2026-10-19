import { InfoIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/layout/page-header';
import { ComponentGallery } from './component-gallery';

export const metadata: Metadata = { title: 'Design system' };

export default function DesignSystemPage() {
  return (
    <>
      <PageHeader
        title="Design system"
        description="Reference for EnvVault's shared components. Future modules must use these building blocks."
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Design system' }]}
      />
      <div
        role="note"
        className="flex gap-3 rounded-lg border border-info-border bg-info-subtle px-4 py-3 text-sm text-info"
      >
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          <strong className="font-semibold">Example data only.</strong> Everything on this page is
          synthetic and exists to demonstrate components. It is not connected to any workspace.
        </p>
      </div>
      <ComponentGallery />
    </>
  );
}
