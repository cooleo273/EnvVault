# Developer guide

How to get configuration from EnvVault into your code: which tool to use, how
to authenticate, and the patterns that keep values out of logs, files and
browsers.

## 1. Pick a tool

| You are writing                                        | Use                                                                                             | Authenticate as                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Local development on your machine                      | CLI: `envvault run -- <command>` ([cli.md](cli.md))                                             | You, through the browser approved sign in |
| A CI job                                               | CLI: `envvault auth service` then `envvault run` ([ci-authentication.md](ci-authentication.md)) | A machine identity                        |
| A Node.js or Next.js server, a worker                  | TypeScript SDK ([sdk-typescript.md](sdk-typescript.md))                                         | A machine identity                        |
| A Python script or service                             | Python SDK ([sdk-python.md](sdk-python.md))                                                     | A machine identity                        |
| Tooling that manages workspaces, projects or variables | TypeScript SDK `EnvVaultClient` or the REST API ([api-reference.md](api-reference.md))          | A person, through the web app or the CLI  |
| Any other language                                     | REST API ([api-reference.md](api-reference.md), `GET /api/v1/openapi.json`)                     | A machine identity                        |

The browsable reference is at `/developers/api` in the web app.

## 2. Set up a machine identity

1. In the dashboard, open the project, then **Machine identities**, and
   create one per workload (for example "billing worker, staging").
2. Grant it the environments it needs with the `environment-runtime` role.
   Protected environments need their own direct grant.
3. Issue a service credential with the narrowest scopes that work
   (`secret:runtime` alone is enough to load values) and a short expiry.
   It is shown once.
4. Store it in your CI provider's or platform's secret store as
   `ENVVAULT_SERVICE_CREDENTIAL`, next to `ENVVAULT_API_URL`.

Details: [machine-identities.md](machine-identities.md),
[service-credentials.md](service-credentials.md).

## 3. Load configuration

TypeScript:

```ts
import { machineClientFromEnvironment } from '@envvault/sdk/node';

const envvault = machineClientFromEnvironment();
const config = await envvault.runtimeValues('staging');
await envvault.close();
```

Python:

```python
from envvault import EnvVaultClient

with EnvVaultClient.from_environment() as client:
    config = client.get_runtime_config(environment="staging")
```

Any process:

```bash
envvault run --env staging -- npm start
python -m envvault run --env staging -- gunicorn app:app
```

## 4. Rules for values

- Load at startup, keep in memory, pass to what needs them. Do not write
  them to `.env` files, disk caches, images or build artifacts.
- Never log or print values. Log counts or key names when you need a
  signal ("Configuration loaded: 12 values").
- Never put values or tokens into frontend code. In Next.js load them only
  in server modules (`import 'server-only'`); do not prefix them with
  `NEXT_PUBLIC_`. Anything in a browser bundle is public.
- Do not pass values as command line arguments; other users can see them in
  the process list.
- Environment variables are readable by the same OS user and by
  administrators, and are inherited by child processes. They are delivery,
  not isolation.
- Reload on restart or on a schedule rather than calling the API per
  request: runtime loads are rate limited and audited.

## 5. Handle failure

- Fail startup when configuration cannot be loaded; do not continue with
  defaults that may be insecure.
- Branch on error `code`, never on `message`. Quote `requestId` when asking
  for help; never paste tokens.
- `401` with `CREDENTIAL_EXPIRED` or `CREDENTIAL_REVOKED`: issue a new
  credential. `403 SCOPE_NOT_GRANTED` or `404`: check the grant and the
  credential's scopes.
- `429`: wait `Retry-After`. The SDKs only retry reads automatically.

## 6. Examples

Runnable examples with placeholder credentials are in `examples/`:

| Example                   | Shows                                           |
| ------------------------- | ----------------------------------------------- |
| `examples/node-backend`   | Node.js server loading values at startup        |
| `examples/nextjs-server`  | Next.js server only loader and route handler    |
| `examples/python-script`  | One off Python script                           |
| `examples/python-service` | Python web service                              |
| `examples/ci-generic`     | Generic CI script and a GitHub Actions workflow |

`apps/api/test/examples.int-spec.ts` runs the Node, Python and CI examples
against a local API with synthetic values and checks that no value or
credential appears in their output. The Next.js example is type checked.

## 7. Working on the API and SDKs

- The contract is the Zod schemas in `packages/shared`. Route metadata
  (callers, permissions, step up, deprecation) comes from decorators. The
  OpenAPI document is generated from both; `apps/api/test/openapi.int-spec.ts`
  fails if they drift.
- Follow [api-reference.md](api-reference.md) for new routes: envelope
  errors with stable codes, one of the three pagination styles, idempotency
  for mutations that create or change secrets, `Cache-Control: no-store` on
  anything holding values.
- Do not break clients: see [api-versioning.md](api-versioning.md).
- Tests: `pnpm --filter @envvault/sdk test`; Python checks in
  [sdk-python.md](sdk-python.md#8-tests-and-checks); SDK and example
  integration tests run with the API integration suite against local
  PostgreSQL (`pnpm --filter @envvault/api test:integration`).
