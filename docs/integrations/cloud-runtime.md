# Cloud runtimes

Loading configuration at run time in services, workers and containers on any
platform (VMs, Kubernetes, ECS, Fly, Render, Railway and similar), with a
machine identity and the existing SDKs.

Related: [../machine-identities.md](../machine-identities.md),
[../sdk-typescript.md](../sdk-typescript.md), [../sdk-python.md](../sdk-python.md),
[docker.md](docker.md).

## 1. Pattern

1. **One machine identity per workload and environment**, granted only that
   environment with the Runtime loader role. Protected environments need a
   direct grant.
2. **A service credential with only `environment:read` and `secret:runtime`**,
   a short expiry, rotated with overlap
   ([../service-credentials.md](../service-credentials.md)).
3. **The platform delivers the credential**, preferably as a mounted secret
   file (`ENVVAULT_SERVICE_CREDENTIAL_FILE`, readable only by the process
   user), otherwise as a platform secret variable. Never in the image or
   repository.
4. **The process loads its values itself** at startup: the SDK exchanges the
   credential for a 15 minute access token, loads the environment (bound by
   name or id; the identity's project is fixed by the credential), and ends
   the token.
5. **Values stay in memory**, never logged, never written to disk, never sent
   to browsers or public APIs.

## 2. Startup, refresh, revocation

The examples `examples/node-worker/worker.mjs` and
`examples/python-worker/worker.py` implement:

| Situation                             | Behaviour                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Startup without configuration         | Exit (3 if access was refused, 4 otherwise); never start with defaults                          |
| Refresh                               | Every `REFRESH_SECONDS` (default 300) plus up to 10% jitter, so a fleet does not reload at once |
| Transient failure (network, 5xx, 429) | Keep the last configuration, retry sooner (30 s), log the error code                            |
| Too long without a refresh            | After `MAX_STALE_SECONDS` (default 1800), exit 4 rather than run on old values                  |
| Access ended (401, 403, 404)          | Exit 3 at the next refresh: credential revoked or expired, identity disabled, grant removed     |
| `SIGTERM`                             | Drop the values and exit 0                                                                      |

Retries: the SDKs retry reads after network errors and 5xx (`retries: 2`);
token exchanges and runtime loads are not retried blindly. Rate limits are
reported with `Retry-After`.

Revocation takes effect at the next request: access tokens are checked on
every call, so a revoked credential or a removed grant stops the next load
even within the token's 15 minutes. Values already loaded stay in the
process until it reloads or exits; revocation cannot reach into memory.

Choosing the refresh interval: shorter intervals pick up rotations and
revocations sooner but load more (runtime loads are rate limited per identity
and environment, `MACHINE_RUNTIME_RESOURCE_RATE_LIMIT`, default 60 per minute,
and each load is audited). Minutes, not seconds, suit most services.

## 3. Containers

`examples/container/Dockerfile` builds an image with no values and no
credential; the container receives `ENVVAULT_API_URL` and
`ENVVAULT_SERVICE_CREDENTIAL_FILE` at run time and the worker loads the rest.
In Kubernetes, mount the credential from a Secret as a file (`defaultMode:
0400`) and keep the API address in the pod spec.

## 4. Audit

Every load records `secret.runtime_loaded` for the identity, with the
credential id; refusals record `machine.access_denied` or
`machine.token_rejected`. See [../machine-identities.md](../machine-identities.md#7-audit-events).

## 5. Limits

- Environment variables and process memory are readable by the same OS user
  and administrators of the host; JavaScript and Python cannot wipe strings
  from memory.
- A stolen service credential works until it is revoked or expires; give it
  the shortest practical lifetime and rotate it.
- On platforms with workload identity (GitHub Actions today), prefer OIDC
  federation over stored credentials ([github-oidc.md](github-oidc.md)).

## 6. Tests

`apps/api/test/cloud-runtime.int-spec.ts` runs both workers against the local
API: they load, refresh, and exit 3 after the credential is revoked, without
printing values or the credential; a worker with an invalid credential does
not start.
