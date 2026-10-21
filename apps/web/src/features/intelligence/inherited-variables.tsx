'use client';

import { type EffectiveConfiguration, SECRET_TYPE_LABELS } from '@envvault/shared';
import { CornerDownRight, Layers } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { StatusBadge } from '@/components/feedback/status-badge';
import { Button } from '@/components/ui/button';
import { VariableDialog } from '@/features/secrets/variable-dialog';

/** Marks where a variable comes from when an environment has a base. */
export function InheritedVariableIndicator({
  source,
  baseName,
}: {
  source: 'inherited' | 'overrides';
  baseName: string;
}) {
  return source === 'inherited' ? (
    <StatusBadge
      tone="info"
      label={`Inherited from ${baseName}`}
      dot={false}
      data-testid="inherited-indicator"
    />
  ) : (
    <StatusBadge
      tone="neutral"
      label={`Overrides ${baseName}`}
      dot={false}
      data-testid="override-indicator"
    />
  );
}

/**
 * Creates a local variable with the inherited one's name and metadata. The
 * value is typed by the user; the base value is never read or copied.
 */
export function OverrideEditor({
  ids,
  variable,
  knownKeys,
}: {
  ids: { workspaceId: string; projectId: string; environmentId: string };
  variable: EffectiveConfiguration['items'][number];
  knownKeys: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-6 text-2xs"
        onClick={() => {
          setOpen(true);
        }}
      >
        Override
      </Button>
      {open ? (
        <VariableDialog
          {...ids}
          open
          onOpenChange={setOpen}
          initialKey={variable.key}
          prefill={{
            type: variable.meta.type,
            description: variable.meta.description,
            category: variable.meta.category,
            tags: variable.meta.tags,
            isRequired: variable.meta.isRequired,
          }}
          knownKeys={knownKeys}
          categories={variable.meta.category ? [variable.meta.category] : []}
        />
      ) : null}
    </>
  );
}

/**
 * Variables this environment gets from its base. They are resolved when
 * read, so a change in the base shows here without copying anything.
 */
export function InheritedVariables({
  ids,
  configuration,
  baseHref,
  canOverride,
  knownKeys,
}: {
  ids: { workspaceId: string; projectId: string; environmentId: string };
  configuration: EffectiveConfiguration;
  baseHref: string | null;
  canOverride: boolean;
  knownKeys: readonly string[];
}) {
  const base = configuration.base;
  if (!base) return null;
  const baseName = base.state === 'no_access' ? 'Restricted environment' : base.name;
  const inherited = configuration.items.filter((i) => i.source === 'inherited');

  return (
    <section
      aria-labelledby="inherited-heading"
      className="flex flex-col gap-2"
      data-testid="inherited-variables"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Layers aria-hidden="true" className="size-4 text-muted-foreground" />
        <h3 id="inherited-heading" className="text-sm font-semibold">
          Inherited variables
        </h3>
        <span className="text-xs text-muted-foreground">
          from{' '}
          {baseHref && base.state === 'ok' ? (
            <Link
              href={baseHref}
              className="focus-ring font-medium text-foreground hover:underline"
            >
              {baseName}
            </Link>
          ) : (
            baseName
          )}{' '}
          · {configuration.summary.inherited} inherited · {configuration.summary.overridden}{' '}
          overridden here
        </span>
      </div>
      {base.state !== 'ok' ? (
        <p
          role="status"
          className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning"
        >
          {base.state === 'no_access'
            ? 'You cannot read the base environment, so inherited variables are hidden.'
            : `The base environment is ${base.state}, so nothing is inherited from it.`}
        </p>
      ) : inherited.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Nothing is inherited: the base has no inheritable variables, or this environment defines
          all of them.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-surface" aria-label="Inherited variables">
          {inherited.map((v) => (
            <li
              key={v.key}
              className="flex flex-wrap items-center gap-2 px-3 py-2"
              data-testid="inherited-row"
            >
              <CornerDownRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <code className="font-mono text-xs font-medium">{v.key}</code>
              <StatusBadge tone="neutral" label={SECRET_TYPE_LABELS[v.meta.type]} dot={false} />
              <InheritedVariableIndicator source="inherited" baseName={baseName} />
              {!v.meta.hasValue ? (
                <span className="text-xs text-muted-foreground italic">no value</span>
              ) : null}
              {v.meta.description ? (
                <span className="truncate text-xs text-muted-foreground">{v.meta.description}</span>
              ) : null}
              {canOverride ? (
                <span className="ml-auto">
                  <OverrideEditor ids={ids} variable={v} knownKeys={knownKeys} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
