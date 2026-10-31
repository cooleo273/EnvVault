# Docker and Docker Compose

Running containers with an EnvVault environment's values, from a developer
machine or a trusted host, without writing them to files or images.

Related: [cloud-runtime.md](cloud-runtime.md), [../cli.md](../cli.md),
[github-actions.md](github-actions.md).

## 1. `envvault docker run`

```bash
envvault docker run --env development -- --rm -p 3000:3000 my-app:latest
```

- Signs in like `envvault run`: your CLI session, or a machine identity when
  `ENVVAULT_SERVICE_CREDENTIAL` (or `..._FILE`) is set.
- Starts `docker run --env KEY1 --env KEY2 ... <your arguments>`. With a bare
  name, Docker takes the value from the docker CLI's own environment, so
  values never appear on a command line (`ps`, shell history) or in a file.
- `--keys A,B` passes only those variables; missing keys fail before Docker
  starts.
- `--docker /usr/local/bin/docker` uses that executable (absolute path,
  checked to be an executable file); otherwise `docker` from `PATH`.
- Exit status: the docker CLI's, 128 plus the signal number when a signal
  ended it, 127 when docker is not found. `SIGINT`, `SIGTERM`, `SIGHUP` and
  `SIGQUIT` are forwarded.
- Arguments after `--` are passed to Docker unchanged; no shell is involved.

**Container variables are not secret storage.** Anyone who can run
`docker inspect` on the host (members of the `docker` group, root), and every
process in the container, can read them. They can also end up in crash
reports or debug output. Use Compose secrets (section 2) for values that
should be files instead.

### Names never passed

Values whose names would reconfigure Docker or the process rather than the
container are refused, and the command lists them: `DOCKER_*` (for example
`DOCKER_HOST` would send the values to another daemon), `COMPOSE_*`,
`BUILDKIT_*`, `LD_*`, `DYLD_*`, `ENVVAULT_*`, `PATH`, `HOME`, `SHELL`,
`NODE_OPTIONS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`. The service credential is
removed from the docker CLI's environment.

## 2. `envvault docker compose`

```bash
envvault docker compose --env development -- up --build
```

Starts `docker compose <arguments>` with the values in Compose's
environment. The Compose file decides what each service receives:

```yaml
services:
  app:
    image: my-app:latest
    environment:
      - LOG_LEVEL # passed through as a container variable
    secrets:
      - database_url # mounted as /run/secrets/database_url
secrets:
  database_url:
    environment: DATABASE_URL
```

`secrets:` with an `environment:` source (Compose specification, supported by
current Docker Compose v2) mounts the value as a file in `/run/secrets/`
inside the container. It is not a container variable, so `docker inspect`
does not show it. Locally, Compose still keeps the value in a file on the
Docker host for the container's lifetime, and the container's processes can
read it: this is better isolation from inspection, not encryption. Docker
Swarm secrets (encrypted at rest in the swarm) are a separate feature that
EnvVault does not manage.

A complete example is `examples/container/compose.yaml`.

## 3. Images: never bake values in

- Never use `ARG` or `ENV` for secrets in a Dockerfile, and never
  `--build-arg` with a value: both are stored in the image and its history.
- Never `COPY` a `.env` file into an image.
- For values needed while building (a package registry token), use BuildKit
  secrets, which are mounted for one `RUN` and not stored:

  ```bash
  envvault run --env build -- docker build --secret id=npm_token,env=NPM_TOKEN .
  ```

  ```dockerfile
  RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN npm ci
  ```

- For values needed at run time in production, let the application load them
  itself with a machine identity ([cloud-runtime.md](cloud-runtime.md),
  `examples/container/Dockerfile`), with the credential mounted as a file.

## 4. Tests

`apps/cli/src/__tests__/docker.test.ts` (arguments, refused names, binary
checks) and `apps/api/test/cli-docker.int-spec.ts` (the built CLI against the
local API with a fake docker executable that records its arguments and which
variables arrived). No real Docker daemon was available when Phase 5B was
verified, so container behaviour itself (inspect visibility, Compose secret
mounts) was not tested; check it manually:

1. `envvault docker run --env development -- --rm alpine env` lists the keys.
2. `docker inspect <container>` shows them (expected for variables).
3. `envvault docker compose --env development -- up` with the example file:
   `/run/secrets/database_url` exists; `docker inspect` does not show it.
