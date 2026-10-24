# EnvVault

A centralized environment variable and secrets management platform for developers,
teams and enterprises: workspaces, projects, unlimited custom environments, and
encrypted, versioned, audited secrets.

> **Status: Phase 4C (public API conventions, TypeScript and Python SDKs, developer documentation).**
> Authentication runs on **Neon Auth**. Workspaces, members and invitations (Phase 1), and
> projects, custom environments and per environment access (Phase 2), are implemented.
> Phase 3A added envelope encryption (AES-256-GCM, one data key per secret version); Phase 3B
> stores, versions, reveals and audits environment variables; Phase 3C adds .env import,
> export, history with rollback and bulk actions; Phase 3D adds environment comparison,
> inheritance, validation and snapshots; Phase 3E adds key rotation tooling, encrypted keyring
> backups, retention, shared rate limits, audit seals, idempotency and deployment configuration;
> Phase 4A adds the `envvault` CLI with browser approved sign in and `envvault run`; Phase 4B adds
> machine identities with service credentials for CI pipelines and servers; Phase 4C documents
> the public API, extends the TypeScript SDK, adds a Python SDK, examples and an API reference page.
> **Do not store real secrets in EnvVault yet**: keys are self managed on the API host and the
> remaining production blockers are listed in
> [docs/security-hardening.md](docs/security-hardening.md#10-remaining-risks-and-production-blockers).

See [docs/architecture.md](docs/architecture.md) for the architecture, trust
boundaries and encryption design, and [docs/database.md](docs/database.md) for the
data model, ERD, tenancy boundaries and authorization flow.
[docs/authentication.md](docs/authentication.md) covers Neon Auth, token verification,
revocation, step-up and the required configuration.
[docs/workspaces.md](docs/workspaces.md) covers roles, endpoints, invitations and onboarding.
[docs/projects.md](docs/projects.md), [docs/environments.md](docs/environments.md) and
[docs/authorization.md](docs/authorization.md) cover projects, environments and the
workspace → project → environment permission model.
[docs/secrets.md](docs/secrets.md) covers variables: types, versions, the secrets API,
reveal rules, .env import syntax, export, history and rollback, bulk actions, rate limits,
audit events and the dashboard.
[docs/environment-comparison.md](docs/environment-comparison.md),
[docs/configuration-inheritance.md](docs/configuration-inheritance.md),
[docs/configuration-validation.md](docs/configuration-validation.md) and
[docs/configuration-snapshots.md](docs/configuration-snapshots.md) cover comparing
environments, base environments and overrides, validation rules and readiness, and snapshots,
drift and restore.
[docs/encryption.md](docs/encryption.md), [docs/key-management.md](docs/key-management.md)
and [docs/threat-model.md](docs/threat-model.md) cover envelope encryption, key setup,
rotation, backups and the limitations of self managed keys.
[docs/security-hardening.md](docs/security-hardening.md) has the security review, findings and
remaining risks; [docs/disaster-recovery.md](docs/disaster-recovery.md),
[docs/deployment.md](docs/deployment.md) and
[docs/operational-runbook.md](docs/operational-runbook.md) cover recovery, the reference
deployment and operator procedures.
[docs/cli.md](docs/cli.md) and [docs/cli-authentication.md](docs/cli-authentication.md) cover
the `envvault` CLI: commands, `run` and `pull`, exit codes, platforms and the device sign in
flow. [docs/machine-identities.md](docs/machine-identities.md),
[docs/service-credentials.md](docs/service-credentials.md) and
[docs/ci-authentication.md](docs/ci-authentication.md) cover machine identities, credential
issue, exchange, rotation and revocation, and CI examples.
[docs/developer-guide.md](docs/developer-guide.md) is the starting point for using EnvVault from
code; [docs/api-reference.md](docs/api-reference.md),
[docs/api-authentication.md](docs/api-authentication.md) and
[docs/api-versioning.md](docs/api-versioning.md) cover the REST API's conventions, callers and
compatibility policy; [docs/sdk-typescript.md](docs/sdk-typescript.md) and
[docs/sdk-python.md](docs/sdk-python.md) cover the SDKs. [docs/roadmap.md](docs/roadmap.md)
lists completed and planned phases. The API's OpenAPI document is served
at `GET /api/v1/openapi.json`, and `/developers/api` in the web app renders it. UI conventions are in
[docs/design-system.md](docs/design-system.md); open `/design-system` in the running
app for the component reference.

## Repository layout

```
apps/
  web/                 Next.js App Router frontend (Tailwind CSS, shadcn/ui)
  api/                 NestJS REST API
  cli/                 envvault command line client
packages/
  shared/              Zod schemas and API contracts shared by all apps
  sdk/                 Typed TypeScript client for the REST API
  sdk-python/          Python SDK (machine identities, runtime configuration, runner)
  database/            Prisma schema, migrations and client (server-only)
  crypto/              Envelope encryption boundary (server-only)
  config/              Shared TypeScript / ESLint / Prettier config
infrastructure/
  docker/              Docker Compose for PostgreSQL and Redis
  deployment/          Deployment manifests (planned)
examples/              Node.js, Next.js, Python and CI examples (placeholder credentials)
docs/                  Architecture documentation
```

## Prerequisites

| Tool                    | Version             | Notes                                                   |
| ----------------------- | ------------------- | ------------------------------------------------------- |
| Node.js                 | **22.12+** (22 LTS) | `.nvmrc` pins 22                                        |
| pnpm                    | **11.x**            | `corepack enable` picks up the `packageManager` version |
| Docker + Docker Compose | Docker Engine 24+   | Only needed for local PostgreSQL/Redis                  |

## Getting started

```bash
# 1. Install dependencies (also runs Prisma's allow-listed install scripts)
corepack enable
pnpm install

# 2. Create your local environment file and replace every "change-me" value.
#    Set NEON_AUTH_BASE_URL to the Auth URL of your *development* Neon branch and
#    generate NEON_AUTH_COOKIE_SECRET with: openssl rand -base64 32
cp .env.example .env

# 3. Start PostgreSQL and Redis (bound to 127.0.0.1 only)
pnpm infra:up
pnpm infra:ps        # wait until both services report "healthy"

# 4. Apply database migrations, align built-in roles, load the development seed
pnpm db:migrate:deploy
pnpm db:sync-catalog
pnpm db:seed

# 5. Start the web app and the API in watch mode
pnpm dev
```

| Service       | URL                                          |
| ------------- | -------------------------------------------- |
| Web           | http://localhost:3000 (sign up at `/signup`) |
| API liveness  | http://localhost:4000/api/v1/health          |
| API readiness | http://localhost:4000/api/v1/health/ready    |

```bash
curl http://localhost:4000/api/v1/health
# {"status":"ok","service":"envvault-api","version":"0.0.0","uptimeSeconds":1.2,"timestamp":"..."}
```

The API starts without a database: liveness reports `ok`, and readiness returns
`503` with `"database": {"status": "down"}` until PostgreSQL is reachable with the
credentials in `DATABASE_URL`.

### Using the CLI

```bash
pnpm --filter @envvault/cli build
alias envvault="node $PWD/apps/cli/dist/bin.js"
envvault health                  # API reachable?
envvault login                   # approve in the browser (password confirmation)
cd path/to/your/app
envvault init                    # writes .envvault.json (ids only)
envvault run -- npm run dev      # values go to the child's environment only
envvault doctor                  # what is missing, and how to fix it
```

See [docs/cli.md](docs/cli.md) for every command, exit codes and platform notes.

In CI, give the job a machine identity's credential instead of signing in:

```bash
export ENVVAULT_SERVICE_CREDENTIAL=…   # from the CI secret store
envvault run --env qa -- npm run build
```

See [docs/ci-authentication.md](docs/ci-authentication.md).

### Using the SDKs

```ts
import { machineClientFromEnvironment } from '@envvault/sdk/node';

const envvault = machineClientFromEnvironment(); // ENVVAULT_API_URL, ENVVAULT_SERVICE_CREDENTIAL
const config = await envvault.runtimeValues('staging');
```

```python
from envvault import EnvVaultClient

with EnvVaultClient.from_environment() as client:
    config = client.get_runtime_config(environment="staging")
```

Neither SDK is published yet. The Python SDK needs a virtual environment for its tests and for
the API integration suite:

```bash
cd packages/sdk-python && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

See [docs/developer-guide.md](docs/developer-guide.md) and `examples/`.

## Scripts

Run from the repository root:

| Command                                                    | Description                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`                                                 | Start web (`:3000`) and API (`:4000`) in watch mode                           |
| `pnpm dev:web` / `dev:api`                                 | Start a single app                                                            |
| `pnpm build`                                               | Build all packages and apps                                                   |
| `pnpm lint`                                                | ESLint across the monorepo                                                    |
| `pnpm typecheck`                                           | TypeScript checks (strict mode) across the monorepo                           |
| `pnpm test`                                                | Unit tests and API tests without a database                                   |
| `pnpm test:e2e`                                            | Playwright browser tests for the web app (run `pnpm build` first)             |
| `pnpm test:e2e:auth`                                       | Full stack auth tests: Next.js, API and Postgres (needs `E2E_DATABASE_URL`)   |
| `pnpm format` / `format:check`                             | Prettier write / check                                                        |
| `pnpm test:integration`                                    | Database and API integration tests (needs `TEST_DATABASE_URL`)                |
| `pnpm db:generate`                                         | Regenerate the Prisma client                                                  |
| `pnpm db:migrate:deploy` / `db:migrate:status`             | Apply / inspect migrations                                                    |
| `pnpm db:migrate:dev`                                      | Create and apply a new migration (development)                                |
| `pnpm db:sync-catalog`                                     | Align permissions and built in roles of every workspace (idempotent)          |
| `pnpm db:check-drift`                                      | Fail if the database differs from the Prisma schema                           |
| `pnpm db:seed`                                             | Load safe development data (refuses `NODE_ENV=production`)                    |
| `pnpm infra:up` / `infra:down` / `infra:logs` / `infra:ps` | Manage local Docker services                                                  |
| `pnpm crypto:init:dev`                                     | Create the development encryption keyring (once; refuses to overwrite)        |
| `pnpm crypto:rotate:dev` / `crypto:status:dev`             | Add a new active key version / list key versions (never prints keys)          |
| `pnpm ops <command>`                                       | Operator tool: keys, rewrap, keyring backups, audit seals (`pnpm ops --help`) |
| `pnpm scan:secrets`                                        | Scan tracked files for key material and credentials                           |
| `pnpm audit:deps`                                          | Fail on high or critical advisories in production dependencies                |
| `pnpm --filter @envvault/api bench` / `drill`              | Performance measurements / disaster recovery drill (disposable databases)     |

### Database

The seed creates three `@example.test` users (`alice` owner, `bob` developer,
`carol` reviewer), the `acme-dev` workspace and a `checkout-api` project with
development, staging and protected production environments. It contains no secret
values, ciphertext, keys or tokens.

Integration tests need a **disposable** database: the Docker init script creates
`envvault_test`, and `TEST_DATABASE_URL` in `.env` points to it. The test setup
drops and recreates that database's schema, and refuses to run unless the database
name contains `test`. **Never point `TEST_DATABASE_URL` or `E2E_DATABASE_URL` at a
Neon branch that holds data you want to keep.**

```bash
pnpm test:integration
```

No Docker? Any PostgreSQL 15+ works: create two databases (for example `envvault` and
`envvault_test`) and point `DATABASE_URL` and `TEST_DATABASE_URL` at them.

If your PostgreSQL volume was created before Phase 0.2 (PostgreSQL 17 image), recreate
it, because the image is now PostgreSQL 18: `docker compose -f
infrastructure/docker/docker-compose.yml --env-file .env down -v`. This **deletes**
local data.

### Playwright

Install the browser once before running the browser tests:

```bash
pnpm --filter @envvault/web exec playwright install chromium
pnpm build
pnpm test:e2e

# Full-stack auth flows (uses a local Better Auth stand-in, never your Neon project).
# The Docker init script creates envvault_e2e_test; set E2E_DATABASE_URL to it.
pnpm test:e2e:auth
```

## Configuration

All configuration is validated at startup; invalid values abort startup with a message
that names the variable without printing its value.

- **Root `.env`** (from `.env.example`): Docker Compose credentials, API settings,
  Neon Auth settings and web settings. The API and the Prisma CLI read it automatically
  in development. The web app reads only its allow-listed keys (`NEON_AUTH_BASE_URL`,
  `NEON_AUTH_COOKIE_SECRET`, `APP_BASE_URL`, `API_INTERNAL_URL`, `NEXT_PUBLIC_*`).
  Database URLs are never loaded into the web server.
- **Neon:** set `DATABASE_URL` to the pooled connection string and `DIRECT_URL` to the
  direct one, both for the same branch. Use separate branches for development and
  production. See [docs/authentication.md §7](docs/authentication.md#7-environments).
- **`apps/api/.env`** (optional): per-developer API overrides.
- **`apps/web/.env.local`** (optional): web overrides. `NEXT_PUBLIC_*` variables are
  shipped to the browser. Never put secrets in them.

Real environment variables always take precedence over `.env` files. `.env*` files are
git-ignored; only `*.env.example` templates with placeholder values are committed.

## Security notes

- Never commit `.env` files, credentials, keys or certificates; `.gitignore` blocks the
  common patterns, but review your diffs.
- The API never logs headers, query strings or request bodies. See
  [Logging policy](docs/architecture.md#44-request-ids-and-logging).
- Production secret storage should use a **managed KMS** (AWS KMS, Google Cloud KMS, Azure
  Key Vault or HashiCorp Vault Transit). No KMS provider ships yet. Production accepts only an
  explicitly acknowledged self managed keyring file
  ([key-management.md, section 7](docs/key-management.md#7-self-managed-keys-in-production));
  development keyrings are refused there.
- Back up the keyring with `pnpm ops keyring:backup` and keep the recovery key offline:
  database backups alone cannot be decrypted ([disaster-recovery.md](docs/disaster-recovery.md)).
- Variable values are encrypted before they reach PostgreSQL, are decrypted only by the
  audited reveal route, and every secrets response is sent with `Cache-Control: no-store`.
- EnvVault stores no passwords: credentials and sessions belong to Neon Auth. The
  browser never receives an API token; see [authentication.md](docs/authentication.md).
- The CLI signs in through browser approval with a password confirmation, keeps its tokens
  in the operating system credential store, and may call only a short list of read routes.
  Prefer `envvault run` over `envvault pull`: it never writes values to disk
  ([cli.md](docs/cli.md)).
- Machine identities never inherit anyone's access: they hold only explicit environment grants,
  limited to metadata and runtime loading, and their credentials are stored as keyed digests,
  shown once and exchanged for 15 minute tokens
  ([machine-identities.md](docs/machine-identities.md)).
- The local Docker setup is for development only.

## Contributing

1. Create a branch, make your change, add tests.
2. Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
3. Open a pull request; CI runs the same checks plus Playwright.
