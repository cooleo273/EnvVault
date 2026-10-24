# TypeScript SDK

`@envvault/sdk` (`packages/sdk`): a typed client for the EnvVault API. The web
app's server and the CLI use it, so every route they call is covered.

- Node.js 20.3 or later, or any server runtime with `fetch` and
  `AbortSignal.any`. Server side only: never ship tokens or values to a
  browser bundle.
- Inputs and outputs are typed from the same Zod schemas the API validates
  with; responses are validated before they reach your code.
- Not published to npm yet (see section 9).

## 1. Two clients

| Client                                                   | For                                                   | Authenticates with                                          |
| -------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| `EnvVaultClient` (`createEnvVaultClient`)                | People through the web app's server, the CLI, tooling | A function that returns a short lived token per request     |
| `EnvVaultMachineClient` (`machineClientFromEnvironment`) | CI jobs, servers, workers                             | A service credential, exchanged for 15 minute access tokens |

They are separate on purpose: the machine client exposes only the `/machine`
routes, and the API refuses machine tokens everywhere else.

## 2. Machine identities

```ts
import { machineClientFromEnvironment } from '@envvault/sdk/node';

// ENVVAULT_API_URL, and ENVVAULT_SERVICE_CREDENTIAL or
// ENVVAULT_SERVICE_CREDENTIAL_FILE (a file readable only by its owner).
const envvault = machineClientFromEnvironment(process.env, { timeoutMs: 5_000 });

const values = await envvault.runtimeValues('staging'); // name, slug or id
console.log('Configuration loaded:', Object.keys(values).length);

await envvault.close(); // ends the current access token
```

| Method                               | Returns                                          | Scope needed       |
| ------------------------------------ | ------------------------------------------------ | ------------------ |
| `identity()`                         | The identity, its project, credential and token  | any                |
| `environments()`                     | Environments this identity has grants on         | `environment:read` |
| `resolveEnvironment(ref)`            | One environment by name, slug or id              | `environment:read` |
| `variables(env)`                     | Variable names and metadata, never values        | `secret:list`      |
| `runtime(env, { includeInherited })` | Values with their source, plus `missingRequired` | `secret:runtime`   |
| `runtimeValues(env)`                 | `Record<string, string>`                         | `secret:runtime`   |

Construct it directly when the credential comes from somewhere else:

```ts
import { EnvVaultMachineClient } from '@envvault/sdk';

const envvault = new EnvVaultMachineClient({
  baseUrl: process.env.ENVVAULT_API_URL!,
  credential: () => secretsManager.read('envvault-credential'),
  scopes: ['secret:runtime'], // narrow the access tokens
  environmentIds: [stagingId], // to these environments only
  renewBeforeMs: 60_000,
});
```

Token handling: exchanged on first use (concurrent calls share one exchange),
renewed `renewBeforeMs` before expiry, exchanged again once after
`TOKEN_EXPIRED`, `TOKEN_REVOKED` or `TOKEN_INVALID`. The credential is sent
only to `POST /machine/token`. `JSON.stringify` and `util.inspect` of the
client show no credential or token.

## 3. People and the CLI

```ts
import { createEnvVaultClient } from '@envvault/sdk';

const api = createEnvVaultClient({
  baseUrl: 'https://api.envvault.example.com',
  getAccessToken: () => session.accessToken(), // called for every request
  timeoutMs: 10_000,
  retries: 2,
  userAgent: 'my-tool/1.0',
});

const me = await api.me();
for await (const project of api.iterateProjects(workspaceId)) {
  console.log(project.name);
}
```

Methods follow the API's resources: workspaces, members, invitations,
projects, environments, access, variables (metadata, reveal, versions,
import, export, bulk), comparison, inheritance, validation, snapshots,
retention, machine identities and credentials, CLI sessions. Routes that a
CLI token may not call answer `CLI_TOKEN_NOT_ALLOWED`; step up actions need a
person's session.

## 4. Options

| Option             | Default  | Meaning                                                            |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `baseUrl`          | required | API origin; `/api/v1` is appended                                  |
| `getAccessToken`   | none     | Token per request (people and CLI)                                 |
| `timeoutMs`        | 10000    | Per attempt                                                        |
| `retries`          | 0        | Retries after network errors and 502, 503, 504, safe requests only |
| `rateLimitRetries` | 0        | Retries after 429, waiting `Retry-After`, safe requests only       |
| `maxRetryAfterMs`  | 30000    | Longer waits are surfaced as errors instead                        |
| `signal`           | none     | Cancels every request of the client                                |
| `userAgent`        | none     | Sent as `User-Agent` where the runtime allows                      |
| `fetch`            | global   | Custom fetch (tests, proxies)                                      |

"Safe" means reads, and mutations sent with an idempotency key. A mutation
without a key is never repeated automatically, because the first attempt may
have been applied. Responses holding values or credentials are never
replayed by the server, so they are not retried either.

## 5. Idempotency and cancellation

```ts
const key = crypto.randomUUID();
await api.withIdempotencyKey(key).createSecret(ws, project, env, input);

const controller = new AbortController();
setTimeout(() => controller.abort(), 2_000);
await api.withSignal(controller.signal).listWorkspaces();
```

Both return a new client and leave the original unchanged. Use one key per
user action and reuse it only to retry that action. A cancelled request
throws `EnvVaultAbortError`; the server may still have applied a mutation,
so retry it with the same key.

## 6. Pagination

| Style  | Iterator                                                                       |
| ------ | ------------------------------------------------------------------------------ |
| Pages  | `iterateProjects`, `iterateEnvironments`, `iterateSecrets`, `iterateSnapshots` |
| Cursor | `iterateProjectActivity`, `iterateMachineIdentityActivity`                     |
| Before | `iterateSecretVersions`                                                        |

The page and cursor iterators take the list's filters (`q`, `status`, and
`sort` and `order` where the route has them) and stop after 1000 pages. `collect(iterator, limit)` gathers into an
array. `paginate`, `paginateCursor` and `paginateBefore` wrap any page
function.

## 7. Errors

| Class                                  | When                                              | Useful fields                                                                                |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `EnvVaultApiError`                     | Any non 2xx response                              | `statusCode`, `code`, `message`, `requestId`, `issues`, `retryAfterSeconds`, `isRateLimited` |
| `EnvVaultNetworkError`                 | Unreachable or timed out                          | `reason` (`unreachable`, `timeout`)                                                          |
| `EnvVaultAbortError`                   | Your signal aborted                               |                                                                                              |
| `EnvVaultResponseValidationError`      | Response did not match the schema                 |                                                                                              |
| `EnvVaultIncompatibleApiError`         | Protocol mismatch                                 | `serverVersion`, `clientVersion`                                                             |
| `EnvVaultConfigurationError` (`/node`) | Missing URL or credential, unsafe credential file |                                                                                              |

```ts
try {
  await envvault.runtimeValues('production');
} catch (error) {
  if (error instanceof EnvVaultApiError && error.code === 'SCOPE_NOT_GRANTED') {
    // ask for a grant; report error.requestId, never the token
  }
  throw error;
}
```

## 8. Compatibility

`await api.checkCompatibility()` compares the server's protocol version with
`API_PROTOCOL_VERSION` before you send credentials. See
[api-versioning.md](api-versioning.md).

## 9. Release (not automated)

The package is `private: true` with `license: UNLICENSED` until the licence
and registry are decided. To publish:

1. Choose the licence and set `license`; remove `private`.
2. Publish `@envvault/shared` first, or bundle it, since the SDK imports it.
3. Update `version` and `CHANGELOG.md`.
4. `pnpm --filter @envvault/sdk build && pnpm --filter @envvault/sdk test`.
5. `pnpm --filter @envvault/sdk pack` and inspect the tarball: only `dist`
   (no tests), `README.md`, `CHANGELOG.md`, `package.json`.
6. `npm publish --provenance` from CI with a scoped, short lived registry
   token. Never from a laptop, never with a token in the repository.
