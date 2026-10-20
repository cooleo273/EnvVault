# EnvVault

A centralized environment variable and secrets management platform for developers,
teams and enterprises: workspaces, projects, unlimited custom environments, and
encrypted, versioned, audited secrets.

> **Status: Phase 3B (secrets and the variables dashboard).** Authentication runs on **Neon
> Auth**. Workspaces, members and invitations (Phase 1), and projects, custom environments
> and per environment access (Phase 2), are implemented. Phase 3A added envelope encryption
> (AES-256-GCM, one data key per secret version) with a **self-managed development key
> provider**; Phase 3B stores, versions, reveals and audits environment variables through
> it. **Do not store real secrets in EnvVault yet**: keys are still self managed, and the
> development key provider must never be used in production.

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
reveal rules, audit events and the dashboard.
[docs/encryption.md](docs/encryption.md), [docs/key-management.md](docs/key-management.md)
and [docs/threat-model.md](docs/threat-model.md) cover envelope encryption, local key
setup and rotation, and the security limitations of self-managed keys. The API's OpenAPI document is served
at `GET /api/v1/openapi.json`. UI conventions are in
[docs/design-system.md](docs/design-system.md); open `/design-system` in the running
app for the component reference.

## Repository layout

```
apps/
  web/                 Next.js App Router frontend (Tailwind CSS, shadcn/ui)
  api/                 NestJS REST API
  cli/                 envvault command-line client
packages/
  shared/              Zod schemas and API contracts shared by all apps
  sdk/                 Typed TypeScript client for the REST API
  database/            Prisma schema, migrations and client (server-only)
  crypto/              Envelope encryption boundary (server-only)
  config/              Shared TypeScript / ESLint / Prettier config
infrastructure/
  docker/              Docker Compose for PostgreSQL and Redis
  deployment/          Deployment manifests (planned)
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

You can also check the API from the CLI:

```bash
pnpm --filter @envvault/cli build
node apps/cli/dist/bin.js health            # or: --api-url http://localhost:4000 --json
```

## Scripts

Run from the repository root:

| Command                                                    | Description                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`                                                 | Start web (`:3000`) and API (`:4000`) in watch mode                        |
| `pnpm dev:web` / `dev:api`                                 | Start a single app                                                         |
| `pnpm build`                                               | Build all packages and apps                                                |
| `pnpm lint`                                                | ESLint across the monorepo                                                 |
| `pnpm typecheck`                                           | TypeScript checks (strict mode) across the monorepo                        |
| `pnpm test`                                                | Unit tests + API end-to-end tests (no database required)                   |
| `pnpm test:e2e`                                            | Playwright browser tests for the web app (run `pnpm build` first)          |
| `pnpm test:e2e:auth`                                       | Full-stack auth tests: Next.js + API + Postgres (needs `E2E_DATABASE_URL`) |
| `pnpm format` / `format:check`                             | Prettier write / check                                                     |
| `pnpm test:integration`                                    | Database and API integration tests (needs `TEST_DATABASE_URL`)             |
| `pnpm db:generate`                                         | Regenerate the Prisma client                                               |
| `pnpm db:migrate:deploy` / `db:migrate:status`             | Apply / inspect migrations                                                 |
| `pnpm db:migrate:dev`                                      | Create and apply a new migration (development)                             |
| `pnpm db:sync-catalog`                                     | Align permissions and built-in roles of every workspace (idempotent)       |
| `pnpm db:check-drift`                                      | Fail if the database differs from the Prisma schema                        |
| `pnpm db:seed`                                             | Load safe development data (refuses `NODE_ENV=production`)                 |
| `pnpm infra:up` / `infra:down` / `infra:logs` / `infra:ps` | Manage local Docker services                                               |
| `pnpm crypto:init:dev`                                     | Create the development encryption keyring (once; refuses to overwrite)     |
| `pnpm crypto:rotate:dev` / `crypto:status:dev`             | Add a new active key version / list key versions (never prints keys)       |

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
- Production secret storage requires a **managed KMS** (AWS KMS, Google Cloud KMS, Azure
  Key Vault or HashiCorp Vault Transit). No KMS provider ships yet. The only provider today
  is the self managed development keyring ([key-management.md](docs/key-management.md)),
  which the API refuses to load with `NODE_ENV=production`.
- Variable values are encrypted before they reach PostgreSQL, are decrypted only by the
  audited reveal route, and every secrets response is sent with `Cache-Control: no-store`.
- EnvVault stores no passwords: credentials and sessions belong to Neon Auth. The
  browser never receives an API token; see [authentication.md](docs/authentication.md).
- The local Docker setup is for development only.

## Contributing

1. Create a branch, make your change, add tests.
2. Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
3. Open a pull request; CI runs the same checks plus Playwright.
