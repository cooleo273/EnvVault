# CI authentication

Running `envvault` in CI pipelines, build servers and containers with a
machine identity. Background: [machine-identities.md](machine-identities.md)
and [service-credentials.md](service-credentials.md).

Every example below uses a placeholder credential. Real ones look like
`evv_sk_` followed by 60 characters; keep them in your CI system's secret
store.

## 1. Setup

1. In the project, open **Machine identities** and create one per pipeline
   (for example "GitHub Actions QA").
2. Grant it **Runtime loader** on the environments it needs. Protected
   environments need someone who holds runtime access there to grant it.
3. Create a credential with the scopes it needs and the shortest practical
   lifetime. Copy it once into the CI secret store as
   `ENVVAULT_SERVICE_CREDENTIAL`.
4. Make the CLI available in the job (it is not on a package registry yet:
   build it from this repository with `pnpm --filter @envvault/cli build` and
   run `node apps/cli/dist/bin.js`, or ship that build in your CI image).
5. Set `ENVVAULT_API_URL` to the API's HTTPS address.

Then:

```bash
envvault auth service --from-env      # checks the credential, prints identity and access
envvault run --env qa -- npm run build
```

With `ENVVAULT_SERVICE_CREDENTIAL` (or `ENVVAULT_SERVICE_CREDENTIAL_FILE`)
set, every command acts as the machine identity:

- the credential is exchanged for a 15 minute access token per command, and
  that token is revoked when the command finishes;
- nothing is written to disk: no credential file, no `.env` file;
- `envvault run` strips the credential variables from the child's
  environment, so the build only sees the values it was granted;
- person commands (`login`, `init`, `workspace`, `project`) and `pull` are
  refused;
- a committed `.envvault.json` of the same project supplies the default
  environment; one of another project is an error.

The credential is never accepted as a command line argument: arguments end up
in process listings and logs. Use the environment, a file
(`--from-file`, mode `0600`) or standard input (`--from-stdin`).

## 2. GitHub Actions

```yaml
name: build
on: [push]

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      ENVVAULT_API_URL: https://api.envvault.example.com
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      # Install the envvault CLI here (see Setup, step 4).
      - name: Check EnvVault access
        run: envvault auth service --from-env
        env:
          ENVVAULT_SERVICE_CREDENTIAL: ${{ secrets.ENVVAULT_SERVICE_CREDENTIAL }}
      - name: Build with QA configuration
        run: envvault run --env qa -- npm run build
        env:
          ENVVAULT_SERVICE_CREDENTIAL: ${{ secrets.ENVVAULT_SERVICE_CREDENTIAL }}
```

- Pass the secret only to the steps that need it, not to the whole job.
- GitHub masks secret values in logs, but only exact matches: never print
  derived forms of values.
- Pull requests from forks do not receive repository secrets; keep it that
  way for credentials that reach real environments.
- Use an environment with required reviewers for Production credentials.

## 3. Generic CI (GitLab, Jenkins, Buildkite and others)

```bash
#!/usr/bin/env sh
set -eu
# ENVVAULT_SERVICE_CREDENTIAL comes from the CI system's masked secret variables.
: "${ENVVAULT_SERVICE_CREDENTIAL:?missing}"
export ENVVAULT_API_URL="https://api.envvault.example.com"

envvault auth service --from-env
envvault run --env staging -- ./scripts/build.sh
```

Systems that provide secrets as files:

```bash
export ENVVAULT_SERVICE_CREDENTIAL_FILE="$CI_SECRETS_DIR/envvault"   # mode 0600
envvault run --env staging -- ./scripts/build.sh
```

From a secrets manager, without touching the disk:

```bash
vault kv get -field=credential secret/ci/envvault | envvault auth service --from-stdin
```

(`--from-stdin` is for checking; `run` reads the environment or a file.)

## 4. Docker builds

Never pass the credential as `--build-arg` or `ENV`: both end up in the
image history. Use a BuildKit secret mount, which exists only during one
`RUN` step:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS build
ARG ENVVAULT_API_URL
WORKDIR /app
COPY . .
RUN npm ci
# The secret file is mounted read only for this step and is not in any layer.
RUN --mount=type=secret,id=envvault,target=/run/secrets/envvault,mode=0400 \
    ENVVAULT_SERVICE_CREDENTIAL_FILE=/run/secrets/envvault \
    envvault run --env staging -- npm run build
```

```bash
DOCKER_BUILDKIT=1 docker build \
  --secret id=envvault,env=ENVVAULT_SERVICE_CREDENTIAL \
  --build-arg ENVVAULT_API_URL=https://api.envvault.example.com \
  -t app:staging .
```

Values loaded during the build can still end up in the image if the build
embeds them (for example browser bundles that inline `NEXT_PUBLIC_*`
variables, or generated config files). Prefer loading server side values at
container start instead:

```dockerfile
CMD ["envvault", "run", "--env", "production", "--", "node", "server.js"]
```

and provide `ENVVAULT_SERVICE_CREDENTIAL` to the container from the
orchestrator's secret store.

## 5. Failures and exit codes

| Exit code | Meaning in CI                                                                                             | What to do                                           |
| --------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 3         | No valid credential in the variable or file (malformed, file readable by others, link to another project) | Fix the secret or the file mode                      |
| 4         | Credential invalid, expired or revoked; identity disabled or expired                                      | Issue or rotate a credential; check the identity     |
| 5         | Scope or permission missing; `pull` attempted                                                             | Check the grants and credential scopes               |
| 6         | Environment not granted to this identity, or archived                                                     | Grant it, or fix `--env`                             |
| 7         | API unreachable or incompatible                                                                           | Check `ENVVAULT_API_URL` and the network             |
| 8         | Required variables have no value                                                                          | Set them, or pass `--allow-missing`                  |
| 9         | Rate limited                                                                                              | Retry later; avoid running `envvault` in tight loops |

`envvault run` otherwise exits with the command's own exit code. Messages
never include the credential, tokens or values.

## 6. Expiry and rotation in CI

- Credentials expire (30 days by default). Track `credentialExpiresAt` from
  `envvault auth service --json` and rotate before it.
- Rotate with an overlap (24 hours by default): update the CI secret to the
  new credential within the window; the old one keeps working until then.
- After a suspected leak, revoke the credential: running jobs fail on their
  next EnvVault request.

## 7. GitHub OIDC (Phase 5A)

GitHub Actions jobs can authenticate with their OIDC token instead of a stored
credential: see [integrations/github-actions.md](integrations/github-actions.md)
and [integrations/github-oidc.md](integrations/github-oidc.md). The credential
flow above remains for other CI systems and as an explicit fallback.

Pushing values to hosting providers is a later phase.
