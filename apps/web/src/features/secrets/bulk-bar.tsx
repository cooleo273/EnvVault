'use client';

import { SUGGESTED_SECRET_CATEGORIES, type SecretSelection } from '@envvault/shared';
import { Download, RotateCcw, Tags, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResponsiveModal } from '@/components/feedback/responsive-modal';
import { notify } from '@/components/feedback/toast';
import { FormField } from '@/components/forms/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/textarea';
import { bulkAction, selectionAction } from './actions';

export type SelectedSecret = SecretSelection['items'][number];

export interface BulkBarProps {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  selected: readonly SelectedSecret[];
  status: 'active' | 'deleted';
  /** Variables matching the current filters (all pages). */
  matching: number;
  filters: {
    q?: string;
    type?: string[];
    category?: string[];
    tag?: string;
  };
  canWrite: boolean;
  canDelete: boolean;
  canExport: boolean;
  onSelect: (items: SelectedSecret[]) => void;
  onClear: () => void;
  onExport: () => void;
}

function tags(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/**
 * Actions on the selected variables. The selection can span pages (Select
 * all matching asks the server for every id under the filters, up to the
 * bulk limit). Every request names each variable with the revision seen, so
 * the server refuses the whole batch if any changed meanwhile.
 */
export function BulkBar({
  workspaceId,
  projectId,
  environmentId,
  selected,
  status,
  matching,
  filters,
  canWrite,
  canDelete,
  canExport,
  onSelect,
  onClear,
  onExport,
}: BulkBarProps) {
  const listId = useId();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'restore' | null>(null);
  const [category, setCategory] = useState<{ mode: 'keep' | 'set' | 'clear'; value: string }>({
    mode: 'keep',
    value: '',
  });
  const [addTags, setAddTags] = useState('');
  const [removeTags, setRemoveTags] = useState('');
  const [required, setRequired] = useState<'keep' | 'yes' | 'no'>('keep');
  const [pending, setPending] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const count = selected.length;
  const items = selected.map((s) => ({ id: s.id, expectedRevision: s.revision }));

  async function selectAll() {
    setPending(true);
    try {
      const outcome = await selectionAction(workspaceId, projectId, environmentId, {
        ...filters,
        status,
      });
      if (!outcome.ok) {
        notify.error(outcome.message);
        return;
      }
      onSelect(outcome.data.items);
      setTruncated(outcome.data.truncated);
    } finally {
      setPending(false);
    }
  }

  async function run(input: object): Promise<boolean> {
    const outcome = await bulkAction(workspaceId, projectId, environmentId, input);
    if (!outcome.ok) {
      notify.error(
        outcome.code === 'SECRET_CONFLICT'
          ? 'Some selected variables changed meanwhile. Nothing was changed; select them again.'
          : outcome.message,
      );
      return false;
    }
    notify.success(`${String(outcome.data.count)} variables updated.`);
    onClear();
    return true;
  }

  async function applyEdit() {
    setPending(true);
    try {
      const patch = {
        ...(category.mode === 'set' ? { category: category.value } : {}),
        ...(category.mode === 'clear' ? { category: null } : {}),
        ...(tags(addTags).length ? { addTags: tags(addTags) } : {}),
        ...(tags(removeTags).length ? { removeTags: tags(removeTags) } : {}),
        ...(required === 'keep' ? {} : { isRequired: required === 'yes' }),
      };
      if (Object.keys(patch).length === 0) {
        notify.error('Choose at least one change.');
        return;
      }
      if (await run({ action: 'update', items, patch })) setEditing(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/40 px-3 py-2 text-sm"
    >
      <span className="font-medium tabular-nums" data-testid="selection-count">
        {count} selected
      </span>
      {count < matching && !truncated ? (
        <Button variant="link" size="sm" disabled={pending} onClick={() => void selectAll()}>
          Select all {matching} matching
        </Button>
      ) : null}
      {truncated ? (
        <span className="text-xs text-muted-foreground">
          Only the first {count} can be changed at once.
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {status === 'active' && canWrite ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            <Tags aria-hidden="true" />
            Edit details
          </Button>
        ) : null}
        {status === 'active' && canExport ? (
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download aria-hidden="true" />
            Export
          </Button>
        ) : null}
        {status === 'active' && canDelete ? (
          <Button
            variant="outline"
            size="sm"
            className="text-danger"
            onClick={() => {
              setConfirm('delete');
            }}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        ) : null}
        {status === 'deleted' && canDelete ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setConfirm('restore');
            }}
          >
            <RotateCcw aria-hidden="true" />
            Restore
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X aria-hidden="true" />
          Clear selection
        </Button>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title={
          confirm === 'delete'
            ? `Delete ${String(count)} variables?`
            : `Restore ${String(count)} variables?`
        }
        description={
          confirm === 'delete'
            ? 'They disappear from this environment. Their encrypted versions are kept and they can be restored from Deleted.'
            : 'They come back with their current values. Names already in use stop the whole restore.'
        }
        destructive={confirm === 'delete'}
        {...(confirm === 'delete' ? { confirmationText: `delete ${String(count)}` } : {})}
        confirmLabel={confirm === 'delete' ? `Delete ${String(count)}` : `Restore ${String(count)}`}
        onConfirm={async () => {
          const ok = await run({ action: confirm ?? 'delete', items });
          if (!ok) throw new Error('Bulk action failed');
          setConfirm(null);
        }}
      />

      <ResponsiveModal
        open={editing}
        onOpenChange={(next) => {
          if (!pending) setEditing(next);
        }}
        title={`Edit ${String(count)} variables`}
        description="Only the fields you change are applied. Values are not touched."
        footer={
          <>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button disabled={pending} aria-busy={pending} onClick={() => void applyEdit()}>
              {pending ? 'Saving…' : 'Apply'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Category">
            {(control) => (
              <div className="flex flex-col gap-2 sm:flex-row">
                <NativeSelect
                  {...control}
                  value={category.mode}
                  className="sm:w-40"
                  onChange={(e) => {
                    setCategory((c) => ({
                      ...c,
                      mode: e.target.value as 'keep' | 'set' | 'clear',
                    }));
                  }}
                >
                  <option value="keep">Keep as is</option>
                  <option value="set">Set to</option>
                  <option value="clear">Remove</option>
                </NativeSelect>
                {category.mode === 'set' ? (
                  <>
                    <Input
                      aria-label="New category"
                      list={listId}
                      value={category.value}
                      onChange={(e) => {
                        setCategory({ mode: 'set', value: e.target.value });
                      }}
                    />
                    <datalist id={listId}>
                      {SUGGESTED_SECRET_CATEGORIES.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </>
                ) : null}
              </div>
            )}
          </FormField>
          <FormField label="Add tags" description="Separate with commas or spaces.">
            {(control) => (
              <Input
                {...control}
                value={addTags}
                onChange={(e) => {
                  setAddTags(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label="Remove tags">
            {(control) => (
              <Input
                {...control}
                value={removeTags}
                onChange={(e) => {
                  setRemoveTags(e.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label="Required">
            {(control) => (
              <NativeSelect
                {...control}
                value={required}
                className="sm:w-40"
                onChange={(e) => {
                  setRequired(e.target.value as 'keep' | 'yes' | 'no');
                }}
              >
                <option value="keep">Keep as is</option>
                <option value="yes">Required</option>
                <option value="no">Optional</option>
              </NativeSelect>
            )}
          </FormField>
        </div>
      </ResponsiveModal>
    </div>
  );
}
