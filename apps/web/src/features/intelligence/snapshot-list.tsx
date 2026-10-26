'use client';

import { INTELLIGENCE_LIMITS, type SnapshotPage } from '@envvault/shared';
import { Camera } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Pagination } from '@/components/data/pagination';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { EmptyState } from '@/components/feedback/states';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { createSnapshotAction } from './actions';

const timeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Snapshots of an environment. A snapshot records names, metadata and
 * version references; it never holds a value or ciphertext.
 */
export function SnapshotList({
  workspaceId,
  projectId,
  environmentId,
  page,
  canCreate,
}: {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  page: SnapshotPage;
  canCreate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function create(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await createSnapshotAction(workspaceId, projectId, environmentId, {
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      if (result.ok) {
        notify.success(result.message ?? 'Snapshot saved.');
        setOpen(false);
        setDescription('');
        setError(undefined);
        router.push(`${pathname}/${result.data.id}`);
      } else {
        setError(result.fieldErrors?.description ?? result.message);
      }
    } finally {
      setPending(false);
    }
  }

  function goTo(next: number) {
    const query = new URLSearchParams(params.toString());
    query.set('page', String(next));
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          A snapshot records each variable&apos;s name, metadata and value version. Values stay
          encrypted in the version history and are never copied into the snapshot.
        </p>
        {canCreate ? (
          <Button
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
          >
            <Camera aria-hidden="true" />
            Take snapshot
          </Button>
        ) : null}
      </div>

      {page.items.length === 0 ? (
        <div className="rounded-lg border bg-surface">
          <EmptyState
            icon={Camera}
            title="No snapshots yet"
            description={
              canCreate
                ? 'Take a snapshot before a risky change so you can compare or restore later.'
                : 'Nobody has taken a snapshot of this environment.'
            }
          />
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-surface" aria-label="Snapshots">
          {page.items.map((snapshot) => (
            <li key={snapshot.id} data-testid="snapshot-item">
              <Link
                href={`${pathname}/${snapshot.id}`}
                className="focus-ring flex flex-col gap-0.5 px-4 py-2.5 hover:bg-accent/50 sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="flex-1 truncate text-sm font-medium">
                  {snapshot.description ?? (
                    <span className="text-muted-foreground italic">No description</span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {snapshot.entryCount} variables ·{' '}
                  {timeFormat.format(new Date(snapshot.createdAt))}
                  {snapshot.createdBy
                    ? ` · ${snapshot.createdBy.displayName ?? snapshot.createdBy.email}`
                    : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {page.total > page.pageSize ? (
        <Pagination
          page={page.page}
          pageCount={Math.ceil(page.total / page.pageSize)}
          totalItems={page.total}
          pageSize={page.pageSize}
          onPageChange={goTo}
        />
      ) : null}

      <ResponsiveModal
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
        title="Take snapshot"
        description="Records the current names, metadata and value versions of every live variable."
      >
        <form className="flex flex-col gap-4" onSubmit={(event) => void create(event)}>
          <FormField
            label="Description"
            description="What this snapshot is for, such as the release it precedes."
            error={error}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                maxLength={INTELLIGENCE_LIMITS.snapshotDescription}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            )}
          </FormField>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save snapshot'}
            </Button>
          </div>
        </form>
      </ResponsiveModal>
    </div>
  );
}
