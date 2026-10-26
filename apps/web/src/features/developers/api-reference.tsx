'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import { SearchInput } from '@/components/data/search-input';
import { EmptyState } from '@/components/feedback/states';
import { StatusBadge } from '@/components/feedback/status-badge';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/textarea';
import type { StatusTone } from '@/design/tokens';
import { examplesFor } from './examples';
import type { Operation, Reference, Schema } from './openapi';

const METHOD_TONES: Record<string, StatusTone> = {
  GET: 'info',
  POST: 'success',
  PUT: 'warning',
  PATCH: 'warning',
  DELETE: 'danger',
};

const CALLERS: { value: string; label: string; description: string }[] = [
  { value: 'person', label: 'People', description: 'Signed in through the web app' },
  { value: 'cli', label: 'CLI', description: 'CLI access token (evv_at_)' },
  { value: 'machine', label: 'Machines', description: 'Machine access token (evv_mt_)' },
  {
    value: 'service-credential',
    label: 'Service credential',
    description: 'Token exchange only (evv_sk_)',
  },
  { value: 'anonymous', label: 'Public', description: 'No authentication' },
];

const callerLabel = (value: string) => CALLERS.find((c) => c.value === value)?.label ?? value;

function typeOf(schema: Schema): string {
  if (schema.$ref) return schema.$ref.split('/').at(-1) ?? 'object';
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.anyOf ?? schema.oneOf) {
    return (schema.anyOf ?? schema.oneOf ?? []).map(typeOf).join(' | ');
  }
  const base = Array.isArray(schema.type) ? schema.type.join(' | ') : (schema.type ?? 'object');
  if (base === 'array' && schema.items) return `${typeOf(schema.items)}[]`;
  return `${base}${schema.format ? ` (${schema.format})` : ''}${schema.nullable ? ' | null' : ''}`;
}

function constraints(schema: Schema): string {
  const parts = [
    schema.minLength !== undefined ? `min length ${String(schema.minLength)}` : null,
    schema.maxLength !== undefined ? `max length ${String(schema.maxLength)}` : null,
    schema.minimum !== undefined ? `min ${String(schema.minimum)}` : null,
    schema.maximum !== undefined ? `max ${String(schema.maximum)}` : null,
    schema.default !== undefined ? `default ${JSON.stringify(schema.default)}` : null,
  ].filter(Boolean);
  return parts.join(', ');
}

/** Object properties as rows, nested up to a few levels. */
function SchemaFields({ schema, depth = 0 }: { schema: Schema; depth?: number }) {
  const target = schema.type === 'array' && schema.items ? schema.items : schema;
  const properties = Object.entries(target.properties ?? {});
  if (properties.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground">{typeOf(schema)}</p>;
  }
  return (
    <ul className={depth > 0 ? 'ml-3 border-l pl-3' : ''}>
      {properties.map(([name, child]) => {
        const nested = child.type === 'array' ? child.items : child;
        return (
          <li key={name} className="py-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <code className="font-mono text-xs font-semibold">{name}</code>
              <span className="font-mono text-xs text-muted-foreground">{typeOf(child)}</span>
              {target.required?.includes(name) ? (
                <span className="text-xs text-danger">required</span>
              ) : null}
              {constraints(child) ? (
                <span className="text-xs text-muted-foreground">{constraints(child)}</span>
              ) : null}
            </div>
            {child.description ? (
              <p className="text-xs text-muted-foreground">{child.description}</p>
            ) : null}
            {depth < 3 && nested?.properties ? (
              <SchemaFields schema={nested} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function OperationDetail({ operation }: { operation: Operation }) {
  const [example, setExample] = useState(0);
  const examples = examplesFor({
    method: operation.method,
    path: operation.path,
    callers: operation.callers,
    hasBody: operation.body !== null,
  });
  const current = examples[example] ?? examples[0];
  return (
    <article aria-labelledby={`op-${operation.id}`} className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={METHOD_TONES[operation.method] ?? 'neutral'}
            label={operation.method}
            dot={false}
          />
          <code className="break-all font-mono text-sm">{operation.path}</code>
          {operation.deprecated ? (
            <StatusBadge tone="warning" label="deprecated" dot={false} />
          ) : null}
        </div>
        <h2 id={`op-${operation.id}`} className="text-lg font-semibold tracking-tight">
          {operation.summary}
        </h2>
        {operation.description ? (
          <p className="text-sm text-muted-foreground">{operation.description}</p>
        ) : null}
      </header>

      <section aria-label="Authentication" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Who can call it</h3>
        <div className="flex flex-wrap gap-1.5">
          {operation.callers.map((caller) => (
            <Badge key={caller} variant="secondary">
              {callerLabel(caller)}
            </Badge>
          ))}
        </div>
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
          {operation.permission ? (
            <>
              <dt className="text-muted-foreground">Permission</dt>
              <dd className="font-mono text-xs">{operation.permission}</dd>
            </>
          ) : null}
          {operation.stepUp ? (
            <>
              <dt className="text-muted-foreground">Step up</dt>
              <dd>Recent password confirmation required</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Operation id</dt>
          <dd className="font-mono text-xs">{operation.id}</dd>
        </dl>
      </section>

      {operation.parameters.length > 0 ? (
        <section aria-label="Parameters" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Parameters</h3>
          <ul className="divide-y rounded-md border">
            {operation.parameters.map((p) => (
              <li
                key={`${p.in}-${p.name}`}
                className="flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-sm"
              >
                <code className="font-mono text-xs font-semibold">{p.name}</code>
                <span className="text-xs text-muted-foreground">{p.in}</span>
                <span className="font-mono text-xs text-muted-foreground">{typeOf(p.schema)}</span>
                {p.required ? <span className="text-xs text-danger">required</span> : null}
                {constraints(p.schema) ? (
                  <span className="text-xs text-muted-foreground">{constraints(p.schema)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {operation.body ? (
        <section aria-label="Request body" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Request body</h3>
          <div className="rounded-md border px-3 py-2">
            <SchemaFields schema={operation.body} />
          </div>
        </section>
      ) : null}

      <section aria-label="Responses" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Responses</h3>
        <ul className="divide-y rounded-md border">
          {operation.responses.map((r) => (
            <li key={r.status} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <StatusBadge
                  tone={
                    r.status.startsWith('2') ? 'success' : r.status === '429' ? 'warning' : 'danger'
                  }
                  label={r.status}
                  dot={false}
                />
                <span>{r.description}</span>
              </div>
              {r.schema && r.status.startsWith('2') ? <SchemaFields schema={r.schema} /> : null}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Errors use one envelope:{' '}
          <code className="font-mono">
            {'{ error: { statusCode, code, message, requestId, issues } }'}
          </code>
          . Branch on <code className="font-mono">code</code>; see the error codes below.
        </p>
      </section>

      <section aria-label="Examples" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Example</h3>
          <div role="tablist" aria-label="Example language" className="flex gap-1">
            {examples.map((e, index) => (
              <button
                key={e.label}
                type="button"
                role="tab"
                aria-selected={index === example}
                className="focus-ring rounded-md px-2 py-0.5 text-xs aria-selected:bg-secondary"
                onClick={() => {
                  setExample(index);
                }}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
        {current ? (
          <pre
            className="overflow-x-auto rounded-md border bg-surface-muted p-3 font-mono text-xs"
            role="tabpanel"
          >
            <code>{current.code}</code>
          </pre>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Placeholders only. Keep tokens in environment variables or a secrets manager; this page
          never uses or stores your credentials.
        </p>
      </section>
    </article>
  );
}

// replaceState fires no hashchange, so selections made on the page notify subscribers directly.
const hashListeners = new Set<() => void>();

function subscribeToHash(onChange: () => void): () => void {
  hashListeners.add(onChange);
  window.addEventListener('hashchange', onChange);
  return () => {
    hashListeners.delete(onChange);
    window.removeEventListener('hashchange', onChange);
  };
}

function selectOperation(id: string): void {
  window.history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  for (const listener of hashListeners) listener();
}

function readHash(): string {
  return decodeURIComponent(window.location.hash.slice(1));
}

/**
 * Searchable API reference generated from the API's own OpenAPI document.
 * Read only: there is no request console and no token input.
 */
export function ApiReference({ reference }: { reference: Reference }) {
  const [query, setQuery] = useState('');
  const [caller, setCaller] = useState('');
  // The URL hash is the selection, so deep links and later hash changes always win.
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => '');
  const fromHash = reference.operations.some((o) => o.id === hash) ? hash : null;
  const selected = fromHash ?? reference.operations[0]?.id ?? '';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reference.operations.filter(
      (o) =>
        (caller === '' || o.callers.includes(caller)) &&
        (q === '' ||
          o.path.toLowerCase().includes(q) ||
          o.summary.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q) ||
          o.tag.toLowerCase().includes(q)),
    );
  }, [reference.operations, query, caller]);

  const groups = useMemo(() => {
    const order = reference.tags.map((t) => t.name);
    const byTag = new Map<string, Operation[]>();
    for (const op of filtered) byTag.set(op.tag, [...(byTag.get(op.tag) ?? []), op]);
    return [...byTag.entries()].sort(
      ([a], [b]) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999),
    );
  }, [filtered, reference.tags]);

  const operation =
    filtered.find((o) => o.id === selected) ?? reference.operations.find((o) => o.id === selected);

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <nav
          aria-label="Endpoints"
          className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
        >
          <SearchInput
            label="Search endpoints"
            placeholder="Search paths and summaries"
            value={query}
            onValueChange={setQuery}
          />
          <NativeSelect
            aria-label="Who can call it"
            value={caller}
            onChange={(e) => {
              setCaller(e.target.value);
            }}
          >
            <option value="">Every caller</option>
            {CALLERS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}: {c.description}
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {filtered.length} of {reference.operations.length} endpoints
          </p>
          {groups.length === 0 ? (
            <EmptyState title="No endpoint matches" className="py-4" />
          ) : (
            <div className="flex flex-col gap-2">
              {groups.map(([tag, ops]) => (
                <details
                  key={tag}
                  open={query !== '' || caller !== '' || ops.some((o) => o.id === selected)}
                  className="rounded-md border"
                >
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    {tag} <span className="text-muted-foreground">({ops.length})</span>
                  </summary>
                  <ul className="flex flex-col pb-1">
                    {ops.map((op) => (
                      <li key={op.id}>
                        <button
                          type="button"
                          aria-current={op.id === selected ? 'true' : undefined}
                          className="focus-ring flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent aria-[current=true]:bg-secondary"
                          onClick={() => {
                            selectOperation(op.id);
                          }}
                        >
                          <span className="w-12 shrink-0 font-mono font-semibold">{op.method}</span>
                          <span className="min-w-0 break-all">{op.summary}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </nav>
        <div className="min-w-0">
          {operation ? <OperationDetail key={operation.id} operation={operation} /> : null}
        </div>
      </div>

      <section aria-labelledby="error-codes" className="flex flex-col gap-3 border-t pt-6">
        <h2 id="error-codes" className="text-lg font-semibold tracking-tight">
          Error codes
        </h2>
        <p className="text-sm text-muted-foreground">
          Every error carries one of these in <code className="font-mono">error.code</code>. Missing
          resources and resources outside your access both answer{' '}
          <code className="font-mono">NOT_FOUND</code>.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(reference.errorCodes).map(([group, codes]) => (
            <div key={group} className="rounded-md border p-3">
              <h3 className="mb-2 text-sm font-medium capitalize">{group}</h3>
              <ul className="flex flex-wrap gap-1">
                {codes.map((code) => (
                  <li key={code}>
                    <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                      {code}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
