import type { Metadata } from 'next';
import { ErrorState } from '@/components/feedback/states';
import { ApiReference } from '@/features/developers/api-reference';
import { loadReference } from '@/features/developers/openapi';

export const metadata: Metadata = {
  title: 'API reference',
  description: 'EnvVault REST API: authentication, endpoints, schemas and error codes.',
};

// Rendered per request from the live API description (cached for five minutes).
export const dynamic = 'force-dynamic';

export default async function ApiReferencePage() {
  const reference = await loadReference();
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">API reference</h1>
        <p className="text-sm text-muted-foreground">
          The EnvVault REST API at <code className="font-mono">/api/v1</code>, generated from the
          validators and guards the API runs. People call it through the web app; the CLI uses CLI
          tokens on a short list of routes; machine identities exchange a service credential for 15
          minute tokens. Values only leave the API through reveal, export and runtime routes, each
          audited.
        </p>
        {reference ? (
          <p className="text-xs text-muted-foreground">
            API {reference.version}, protocol {reference.protocolVersion}. Raw document:{' '}
            <code className="font-mono">GET /api/v1/openapi.json</code>.
          </p>
        ) : null}
      </header>
      {reference ? (
        <ApiReference reference={reference} />
      ) : (
        <ErrorState
          title="The API description is not available"
          description="The EnvVault API could not be reached. Try again later, or read docs/api-reference.md in the repository."
        />
      )}
    </div>
  );
}
