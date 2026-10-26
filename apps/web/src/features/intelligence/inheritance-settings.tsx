'use client';

import type { EffectiveConfiguration, EnvironmentSummary } from '@envvault/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StatusBadge } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { SettingsSection } from '@/components/layout/settings-section';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/textarea';
import { setBaseEnvironmentAction } from './actions';

const BASE_STATE_NOTES: Record<
  NonNullable<EffectiveConfiguration['base']>['state'],
  string | null
> = {
  ok: null,
  archived:
    'The base environment is archived, so nothing is inherited until it is restored or replaced.',
  deleted:
    'The base environment was deleted, so nothing is inherited. Pick another base or remove it.',
  protected: 'The base environment became protected, so nothing is inherited from it.',
  no_access: 'You cannot read the base environment, so its variables are not shown.',
};

/**
 * InheritanceSettings. One base environment per environment; only variables
 * marked inheritable (never SECRET ones) flow down, and local variables with
 * the same name override them. Nothing is copied.
 */
export function InheritanceSettings({
  ids,
  environmentName,
  current,
  candidates,
  canEdit,
}: {
  ids: { workspaceId: string; projectId: string; environmentId: string };
  environmentName: string;
  current: EffectiveConfiguration | null;
  candidates: readonly Pick<EnvironmentSummary, 'id' | 'name' | 'isProtected' | 'status'>[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [baseId, setBaseId] = useState(current?.base?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const base = current?.base ?? null;
  const usable = candidates.filter(
    (c) => c.id !== ids.environmentId && !c.isProtected && c.status === 'ACTIVE',
  );
  const dirty = baseId !== (base?.id ?? '');

  async function save() {
    setPending(true);
    try {
      const result = await setBaseEnvironmentAction(
        ids.workspaceId,
        ids.projectId,
        ids.environmentId,
        {
          baseEnvironmentId: baseId || null,
        },
      );
      if (result.ok) {
        setError(null);
        notify.success(result.message ?? 'Saved.');
        router.refresh();
      } else {
        setError(result.message);
      }
    } finally {
      setPending(false);
    }
  }

  const note = base ? BASE_STATE_NOTES[base.state] : null;

  return (
    <SettingsSection
      id="inheritance"
      title="Inheritance"
      description={`Use another environment as the base of ${environmentName}. Variables marked inheritable there apply here unless a variable with the same name is defined here. Secret variables are never inherited.`}
      badge={
        base ? (
          <StatusBadge
            tone={base.state === 'ok' ? 'success' : 'warning'}
            label={`Base: ${base.state === 'no_access' ? 'Restricted environment' : base.name}`}
            dot={false}
          />
        ) : (
          <StatusBadge tone="neutral" label="No base" dot={false} />
        )
      }
      footer={
        canEdit ? (
          <Button size="sm" disabled={pending || !dirty} onClick={() => void save()}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {note ? (
          <p role="status" className="text-sm text-warning">
            {note}
          </p>
        ) : null}
        <label className="flex max-w-sm flex-col gap-1 text-sm">
          Base environment
          <NativeSelect
            aria-label="Base environment"
            value={baseId}
            disabled={!canEdit || pending}
            onChange={(e) => {
              setBaseId(e.target.value);
            }}
          >
            <option value="">None</option>
            {base && !usable.some((c) => c.id === base.id) ? (
              <option value={base.id}>
                {base.state === 'no_access' ? 'Restricted environment' : base.name} (unavailable)
              </option>
            ) : null}
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        {current ? (
          <p className="text-xs text-muted-foreground">
            {current.summary.inherited} inherited · {current.summary.overridden} overridden here ·{' '}
            {current.summary.local} defined here
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Only one level is supported: a base cannot inherit from another environment, and an
          environment other environments inherit from cannot get a base. Protected and archived
          environments cannot be a base.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
