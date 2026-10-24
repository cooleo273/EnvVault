# @envvault/sdk

Typed TypeScript client for the EnvVault REST API (`/api/v1`).

- `EnvVaultClient`: everything a person (through the web app's server) or the
  CLI does, with typed inputs and outputs validated against the API's schemas.
- `EnvVaultMachineClient`: machine identities (CI jobs, servers, workers). It
  exchanges the service credential for short lived access tokens and renews
  them.
- Timeouts, cancellation (`AbortSignal`), retries limited to safe requests,
  rate limit metadata, pagination iterators, protocol compatibility checks.

Node.js 20.3 or later (or any runtime with `fetch` and `AbortSignal.any`).

## Machine identities

```ts
import { machineClientFromEnvironment } from '@envvault/sdk/node';

// ENVVAULT_API_URL and ENVVAULT_SERVICE_CREDENTIAL (or ..._FILE) from the environment.
const envvault = machineClientFromEnvironment();
const values = await envvault.runtimeValues('staging');
console.log('Configuration loaded:', Object.keys(values).length);
await envvault.close();
```

Never log values, and never pass them to code that runs in a browser.

## People and the CLI

```ts
import { createEnvVaultClient } from '@envvault/sdk';

const api = createEnvVaultClient({
  baseUrl: 'https://api.envvault.example.com',
  getAccessToken: () => session.accessToken(),
  timeoutMs: 10_000,
  retries: 2,
});
for await (const project of api.iterateProjects(workspaceId)) {
  console.log(project.name);
}
```

## Errors

`EnvVaultApiError` (`statusCode`, `code`, `message`, `requestId`, `issues`,
`retryAfterSeconds`), `EnvVaultNetworkError`, `EnvVaultAbortError`,
`EnvVaultResponseValidationError`, `EnvVaultIncompatibleApiError`.
Branch on `code`.

See `docs/sdk-typescript.md` in the repository for the full guide.
