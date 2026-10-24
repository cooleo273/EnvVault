# Python SDK

`envvault` (`packages/sdk-python`): load the configuration a machine identity
may read from the EnvVault API, from scripts, services and CI jobs.

- Python 3.10, 3.11, 3.12 and 3.13 (CI tests 3.10 and 3.13).
- One runtime dependency: `httpx` (0.27 or 0.28).
- No cryptography in Python: the API decrypts, authorizes and audits every
  value. The SDK only receives what the identity is allowed to load.
- Not on PyPI yet (see section 9).

## 1. Install

From a checkout:

```bash
pip install ./packages/sdk-python
```

For development:

```bash
cd packages/sdk-python
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## 2. Configure

| Variable                           | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `ENVVAULT_API_URL`                 | API origin. `https` required except for `localhost`, `127.0.0.1` and `::1` |
| `ENVVAULT_SERVICE_CREDENTIAL`      | The machine identity's service credential (`evv_sk_`)                      |
| `ENVVAULT_SERVICE_CREDENTIAL_FILE` | Or a file holding it, readable only by its owner (mode 0600)               |

Put the credential in your CI provider's or platform's secret store. Never
in code, images, notebooks or logs.

## 3. Synchronous client

```python
from envvault import EnvVaultClient

with EnvVaultClient.from_environment() as client:
    config = client.get_runtime_config(environment="staging")
    print("Configuration loaded:", len(config))
    database_url = config["DATABASE_URL"]
```

With ids instead of a name (the project must be the identity's own):

```python
config = client.get_runtime_config(project_id=PROJECT_ID, environment_id=ENVIRONMENT_ID)
```

| Method                            | Returns                                                        | Scope needed       |
| --------------------------------- | -------------------------------------------------------------- | ------------------ |
| `identity()`                      | `MachineIdentity`: name, project, environments and permissions | any                |
| `environments()`                  | `list[Environment]` with grants                                | `environment:read` |
| `resolve_environment(ref)`        | `Environment` by name, slug or id                              | `environment:read` |
| `list_variables(env)`             | `list[Variable]`: names and metadata, never values             | `secret:list`      |
| `get_runtime_config(...)`         | `RuntimeConfig`                                                | `secret:runtime`   |
| `meta()`, `check_compatibility()` | `Meta`                                                         | none               |
| `close()`                         | Ends the access token, closes connections                      |                    |

`RuntimeConfig` is a read only mapping of key to value. It also has
`entries` (with each value's source), `missing_required`,
`withheld_inherited` and `as_dict()`. Its `repr` lists keys only.
`MachineToken`'s `repr` hides the token. Never print or log values.

## 4. Asynchronous client

```python
from envvault import AsyncEnvVaultClient

async with AsyncEnvVaultClient.from_environment() as client:
    config = await client.get_runtime_config(environment="staging")
```

Same methods, awaited; `aclose()` instead of `close()`; `iter_projects` and
`iter_environments` are async iterators.

## 5. Options

```python
EnvVaultClient(
    "https://api.envvault.example.com",
    credential=read_from_secret_store,  # str or a function returning it
    scopes=["secret:runtime"],          # narrow the access tokens
    environment_ids=[STAGING_ID],
    timeout=10.0,                       # seconds per attempt
    retries=2,                          # network errors and 502, 503, 504
    rate_limit_retries=0,               # 429: wait Retry-After, then retry
    max_retry_after=30.0,
    renew_before=60.0,
    user_agent="billing-worker/2.1",
)
```

Retries apply only to reads (`GET`). Token exchanges and runtime loads are
`POST` requests and are never repeated after a network error or a 5xx,
because the first attempt may have run; the error reaches your code instead.
The one exception is a rejected access token, described next: the server
did nothing, so the request is sent once more with a new token.

Token handling: the credential is exchanged on first use (one exchange at a
time, also across threads), the access token is renewed `renew_before`
seconds before it expires and exchanged again once after `TOKEN_EXPIRED`,
`TOKEN_REVOKED` or `TOKEN_INVALID`. The credential is sent only to
`POST /machine/token`.

With `access_token=` instead of `credential=` (for example a CLI token) the
client sends that token as is; `list_workspaces`, `iter_projects`,
`iter_environments` and `get_runtime_config(workspace_id=..., project_id=...,
environment_id=...)` work, within what the CLI may call.

## 6. Errors

| Exception                 | When                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `AuthenticationError`     | 401: invalid, expired or revoked token or credential (`code` says which)    |
| `PermissionDeniedError`   | 403: missing scope, grant or permission                                     |
| `NotFoundError`           | 404: missing, or not available to this identity                             |
| `RateLimitError`          | 429, with `retry_after` seconds                                             |
| `ValidationError`         | 400 or 422, with `issues`                                                   |
| `ApiError`                | Base of the above; `status_code`, `code`, `message`, `request_id`           |
| `NetworkError`            | Unreachable or timed out                                                    |
| `ConfigurationError`      | Missing URL or credential, insecure URL, credential file readable by others |
| `IncompatibleApiError`    | Protocol mismatch                                                           |
| `ResponseValidationError` | Unexpected response shape                                                   |
| `MissingRequiredError`    | `run` found required variables without values                               |

All derive from `EnvVaultError`. Messages never contain tokens or values.

## 7. Running a command with the values

```bash
python -m envvault run --env staging -- python manage.py migrate
python -m envvault whoami
```

Or from Python: `envvault.run(["python", "manage.py", "migrate"], environment="staging")`.

- The values go into the child's environment only. Nothing is written to
  disk and no value is passed as an argument.
- The command starts without a shell. `ENVVAULT_SERVICE_CREDENTIAL` and
  `ENVVAULT_SERVICE_CREDENTIAL_FILE` are removed from its environment, and
  the access token is ended before it starts.
- `--no-override` keeps variables already set; `--no-inherited` leaves out
  inherited values; `--allow-missing` runs even with required values missing.
- `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGQUIT` are forwarded to the child.
- Exit status: the child's own; 128 plus the signal number when a signal
  ended it; 127 when the command does not exist. Before the child starts:
  2 usage, 3 configuration, 4 authentication, 5 permission, 6 not found,
  7 API unavailable or other API error, 8 required values missing, 9 rate
  limited.

Limits of environment variables: any process running as the same OS user
(and administrators) can read a process's environment on most systems, child
processes inherit it, and crash reporters may capture it. Python cannot wipe
strings from memory. Treat the environment as convenient delivery, not as
isolation. The runner is tested on Linux and macOS. On Windows `SIGHUP` and
`SIGQUIT` do not exist, `SIGTERM` ends the child without letting it clean
up, and signals Windows cannot deliver to a child are dropped.

## 8. Tests and checks

```bash
cd packages/sdk-python
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/mypy
.venv/bin/pytest
```

The unit tests use an in process fake API. `tests/integration` runs against
a real API and is skipped unless its `ENVVAULT_IT_*` settings are present;
`apps/api/test/python-sdk.int-spec.ts` prepares them with synthetic data on a
local database.

## 9. Release (not automated)

The package carries the `Private :: Do Not Upload` classifier, which PyPI
rejects, and a proprietary licence identifier. To publish:

1. Choose the licence and set `license` in `pyproject.toml`.
2. Remove the `Private :: Do Not Upload` classifier.
3. Update `version` in `pyproject.toml` and `src/envvault/_version.py`, and
   `CHANGELOG.md`.
4. `.venv/bin/python -m build` then `.venv/bin/twine check dist/*`; inspect
   the wheel's contents.
5. Upload from CI with PyPI trusted publishing (no stored token), first to
   TestPyPI.
