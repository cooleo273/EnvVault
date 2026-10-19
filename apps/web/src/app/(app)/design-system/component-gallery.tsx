'use client';

import {
  ENVIRONMENT_KIND_LABELS,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  PERMISSION_KEYS,
} from '@envvault/shared';
import { useMemo, useState } from 'react';
import type * as React from 'react';
import { DataTable, type DataTableColumn } from '@/components/data/data-table';
import { FilterDropdown } from '@/components/data/filter-dropdown';
import { SearchInput } from '@/components/data/search-input';
import { EnvironmentBadge, PermissionBadge } from '@/components/domain/badges';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { CopyField } from '@/components/forms/copy-field';
import { FormField } from '@/components/forms/form-field';
import { SecretMaskedField } from '@/components/forms/secret-masked-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { STATUS_TONES } from '@/design/tokens';

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      <div className="flex flex-col gap-4 rounded-lg border bg-surface p-5">{children}</div>
    </section>
  );
}

/* Example rows: synthetic names, clearly not real configuration. */
interface ExampleRow {
  id: string;
  key: string;
  kind: EnvironmentKind;
  version: number;
}

const EXAMPLE_ROWS: ExampleRow[] = Array.from({ length: 240 }, (_, index) => {
  const n = index + 1;
  return {
    id: `example-${String(n)}`,
    key: `EXAMPLE_VAR_${String(n).padStart(3, '0')}`,
    kind: ENVIRONMENT_KINDS[n % ENVIRONMENT_KINDS.length] ?? 'OTHER',
    version: ((n * 7) % 12) + 1,
  };
});

const exampleColumns: DataTableColumn<ExampleRow>[] = [
  {
    id: 'key',
    header: 'Key',
    isRowHeader: true,
    sortValue: (row) => row.key,
    cell: (row) => <span className="font-mono text-xs">{row.key}</span>,
  },
  {
    id: 'environment',
    header: 'Environment',
    sortValue: (row) => row.kind,
    cell: (row) => <EnvironmentBadge kind={row.kind} isProtected={row.kind === 'PRODUCTION'} />,
  },
  {
    id: 'version',
    header: 'Version',
    align: 'end',
    hideBelow: 'sm',
    sortValue: (row) => row.version,
    cell: (row) => `v${String(row.version)}`,
  },
];

const kindOptions = ENVIRONMENT_KINDS.map((kind) => ({
  value: kind,
  label: ENVIRONMENT_KIND_LABELS[kind],
}));

function ExampleTable() {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<EnvironmentKind[]>([]);
  const rows = useMemo(
    () =>
      EXAMPLE_ROWS.filter(
        (row) =>
          row.key.toLowerCase().includes(query.trim().toLowerCase()) &&
          (kinds.length === 0 || kinds.includes(row.kind)),
      ),
    [query, kinds],
  );
  return (
    <DataTable
      caption="Example variables"
      columns={exampleColumns}
      data={rows}
      getRowId={(row) => row.id}
      pageSize={20}
      toolbar={
        <>
          <SearchInput
            label="Search example variables"
            value={query}
            onValueChange={setQuery}
            className="sm:max-w-xs"
          />
          <FilterDropdown
            label="Environment"
            options={kindOptions}
            selected={kinds}
            onSelectedChange={setKinds}
          />
        </>
      }
      emptyState={
        <EmptyState title="No matching variables" description="Try a different search or filter." />
      }
    />
  );
}

export function ComponentGallery() {
  const [name, setName] = useState('');
  const nameError =
    name !== '' && !/^[a-z0-9-]+$/.test(name)
      ? 'Use lowercase letters, numbers and dashes.'
      : undefined;

  return (
    <div className="flex flex-col gap-8">
      <Section id="buttons" title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
        </div>
      </Section>

      <Section id="badges" title="Status, environment and permission badges">
        <div className="flex flex-wrap gap-2">
          {STATUS_TONES.map((tone) => (
            <StatusBadge
              key={tone}
              tone={tone}
              label={tone.charAt(0).toUpperCase() + tone.slice(1)}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {ENVIRONMENT_KINDS.map((kind) => (
            <EnvironmentBadge key={kind} kind={kind} isProtected={kind === 'PRODUCTION'} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {PERMISSION_KEYS.filter((key) => key.startsWith('secret:')).map((key) => (
            <PermissionBadge key={key} permission={key} />
          ))}
        </div>
      </Section>

      <Section id="forms" title="Form fields">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label="Environment slug"
            description="Used in URLs and the CLI."
            required
            {...(nameError ? { error: nameError } : {})}
          >
            {(control) => (
              <Input
                {...control}
                value={name}
                placeholder="staging-eu"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </FormField>
          <CopyField
            label="Example identifier"
            value="example-0000-0000"
            description="Non-secret values only."
          />
        </div>
        <SecretMaskedField
          label="EXAMPLE_SECRET"
          loadValue={() =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve('example-value-not-a-real-secret');
              }, 300);
            })
          }
        />
      </Section>

      <Section id="table" title="Data table (240 example rows)">
        <ExampleTable />
      </Section>

      <Section id="overlays" title="Dialogs and toasts">
        <div className="flex flex-wrap gap-2">
          <ResponsiveModal
            title="Example modal"
            description="Bottom sheet on small screens, centred dialog on larger ones."
            trigger={<Button variant="outline">Open modal</Button>}
            footer={<Button>Done</Button>}
          >
            <p>Focus is trapped while open. Press Escape to close.</p>
          </ResponsiveModal>
          <ConfirmDialog
            title="Delete example environment?"
            description="This is a demonstration; nothing will be deleted."
            confirmLabel="Delete"
            destructive
            confirmationText="example"
            trigger={<Button variant="destructive">Open confirm dialog</Button>}
            onConfirm={() => {
              notify.success('Confirmed (example only)');
            }}
          />
          <Button
            variant="outline"
            onClick={() => {
              notify.success('Example success toast');
            }}
          >
            Show toast
          </Button>
        </div>
      </Section>

      <Section id="states" title="Loading, empty and error states">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border p-4">
            <LoadingSkeleton variant="list" rows={3} />
          </div>
          <div className="rounded-lg border">
            <EmptyState
              title="No secrets yet"
              description="Add your first variable to get started."
            />
          </div>
          <div className="rounded-lg border">
            <ErrorState
              onRetry={() => {
                notify.info('Retry clicked (example only)');
              }}
            />
          </div>
        </div>
      </Section>
    </div>
  );
}
