import { type CliDeviceRequest, USER_CODE_PATTERN } from '@envvault/shared';
import type { Metadata } from 'next';
import { CliAuthorize, CliCodeForm } from '@/features/cli/cli-authorize';
import { withApi } from '@/lib/api/server-api';

export const metadata: Metadata = { title: 'Sign in the CLI' };

/** Approval page for `envvault login` (opened by the CLI with ?code=). */
export default async function CliAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const raw = typeof query.code === 'string' ? query.code.trim().toUpperCase() : '';
  let request: CliDeviceRequest | null = null;
  if (USER_CODE_PATTERN.test(raw)) {
    request = await withApi((api) => api.cliLoginRequest(raw)).catch(() => null);
  }
  return (
    <section aria-labelledby="cli-heading" className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <h1 id="cli-heading" className="text-lg font-semibold tracking-tight">
        Sign in the EnvVault CLI
      </h1>
      {request ? (
        <CliAuthorize request={request} />
      ) : (
        <>
          {raw ? (
            <p role="alert" className="text-sm text-danger">
              No open sign in request has this code. It may have expired; run{' '}
              <code className="font-mono">envvault login</code> again.
            </p>
          ) : null}
          <CliCodeForm />
        </>
      )}
    </section>
  );
}
