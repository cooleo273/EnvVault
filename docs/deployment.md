# Deployment

A reference deployment for a small installation: one host with Docker Compose, TLS at Caddy,
the web and API containers, Redis for shared rate limits, and Neon for PostgreSQL. No
Kubernetes. Files are in [infrastructure/deployment](../infrastructure/deployment).

> **Status.** These files are reviewed configuration. They were **not** built or run as part
> of Phase 3E (no container runtime was available). Build, deploy and verify them on a staging
> host before relying on them. Production also needs the decisions in
> [security-hardening.md, section 10](security-hardening.md#10-remaining-risks-and-production-blockers),
> above all a managed KMS.

## 1. Topology

```
Internet ─443─► caddy ──► web:3000 ──► api:4000 ──► Neon (TLS)
                (edge)     (edge, backend)  (backend) ├─► redis:6379 (backend)
                                                       └─► /run/envvault/keys (read only)
```

1. Only Caddy publishes ports (80 redirects to 443). The API is **not** exposed: browsers talk
   to the web server, which calls the API on the backend network.
2. Caddy obtains certificates from Let's Encrypt and accepts TLS 1.2 and 1.3 only, with HSTS.
3. Redis has a password, no persistence and no published port.
4. Containers run as uid 10001 with a read only root filesystem, all capabilities dropped and
   `no-new-privileges`. Application files are owned by root, so the process cannot modify
   them.

## 2. Images

| Image                  | Dockerfile                                 | Notes                                                                |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `envvault-api`         | `docker/api.Dockerfile` (target `runtime`) | Production dependencies only (`pnpm deploy --prod`)                  |
| `envvault-api-migrate` | `docker/api.Dockerfile` (target `migrate`) | Runs `prisma migrate deploy` once                                    |
| `envvault-web`         | `docker/web.Dockerfile`                    | Next.js standalone server; `NEXT_PUBLIC_API_URL` is a build argument |

```bash
docker build -f infrastructure/deployment/docker/api.Dockerfile --target runtime -t envvault-api .
docker build -f infrastructure/deployment/docker/api.Dockerfile --target migrate -t envvault-api-migrate .
docker build -f infrastructure/deployment/docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://app.example.com -t envvault-web .
```

`.dockerignore` keeps environment files, keyrings, recovery keys, backups, integrity keys and
build output out of the build context, so no secret reaches an image layer. Pin base images
by digest in your registry.

## 3. Configuration and secrets

| File on the host                            | Mode              | Contents                                  |
| ------------------------------------------- | ----------------- | ----------------------------------------- |
| `infrastructure/deployment/env/api.env`     | 0600              | From `api.env.example`                    |
| `infrastructure/deployment/env/web.env`     | 0600              | From `web.env.example`                    |
| `infrastructure/deployment/env/migrate.env` | 0600              | Pooled and direct Neon URLs               |
| `/srv/envvault/keys/keyring.json`           | 0400, owner 10001 | `pnpm ops keys:init --usage self-managed` |
| `/srv/envvault/keys/integrity.json`         | 0400, owner 10001 | `pnpm ops integrity:init-key`             |
| `/srv/envvault/redis-password`              | 0400, owner 999   | Random password, also in `REDIS_URL`      |

Environment separation: production uses its own Neon branch, its own Neon Auth URL, its own
keyring, integrity key and recovery key. Never copy development keys or branches into
production.

**Startup validation.** With `NODE_ENV=production` the API refuses to start unless origins and
Neon Auth URLs are https, `INTEGRITY_KEY_FILE` is set, a keyring file (not an inline keyring)
is configured, `ENCRYPTION_SELF_MANAGED_ACKNOWLEDGED=true` is set, and the keyring's usage is
`self-managed`. It warns when rate limits are per instance or logging is verbose.

## 4. First deployment

1. Create the Neon production branch; enable Neon Auth on it.
2. On the host, as an operator: create the keyring, the integrity key, a recovery key (move it
   offline at once) and a first keyring backup. See [operational-runbook.md](operational-runbook.md).
3. Fill in the three env files.
4. Build the images (section 2) or pull them from your registry.
5. Apply migrations: `docker compose -f infrastructure/deployment/compose.production.yml --profile migrate run --rm migrate`.
6. Run `pnpm db:sync-catalog` against the branch from a trusted machine (built in roles).
7. Start: `docker compose -f infrastructure/deployment/compose.production.yml up -d`.
8. Check `https://<domain>/` and the API readiness from inside the network:
   `docker compose exec api wget -qO- http://127.0.0.1:4000/api/v1/health/ready`.

## 5. Migrations

Migrations are a release step, never part of API startup. Review each migration, take a dump,
apply it with the `migrate` service, then roll out the new images. Every migration runs in a
single transaction. Phase 3D and 3E migrations are listed in
[operational-runbook.md, section 9](operational-runbook.md#9-pending-database-changes).

## 6. Health, monitoring and shutdown

| Probe     | Path                       | Meaning                                                                         |
| --------- | -------------------------- | ------------------------------------------------------------------------------- |
| Liveness  | `GET /api/v1/health`       | The process serves requests                                                     |
| Readiness | `GET /api/v1/health/ready` | Database migrated and reachable, keys usable; also reports the rate limit store |

Monitoring hooks: structured JSON logs on stdout (request id on every line, no values or
headers), the readiness endpoint, audit events (`authz.denied`, `security.rate_limited`,
`secret.access_denied`, `encryption.*`, `retention.*`) and a daily `pnpm ops audit:verify`.
On SIGTERM the API stops accepting connections, finishes requests, stops background work and
exits within 25 seconds (`stop_grace_period: 30s`).

## 7. Scaling beyond one host

Set `RATE_LIMIT_STORE=redis` with a shared Redis (TLS) before running more than one API
instance; mount the same keyring and integrity key on every instance; run at most one
maintenance worker or rely on its job locking; and move key material to a managed KMS.

**Not yet verified:** the Redis store has only been tested against an in process Redis
emulator, and no test has run more than one API instance. Before scaling out, test against a
real Redis server: counters shared across instances, the 503 policy when Redis stops, and
recovery when it returns.

**Global limit.** `RATE_LIMIT_MAX` (per client address) defaults to 1000 requests per minute,
a provisional value: every browser request reaches the API from the web server, so this limit
is shared by all users and only stops floods. Per user limits (600 per minute) and the
sensitive action limits are the real controls and stay strict. Review the value with real
traffic.
