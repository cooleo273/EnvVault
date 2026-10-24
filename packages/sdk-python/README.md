# EnvVault Python SDK

Load configuration that a machine identity is allowed to read from the
EnvVault API, without copying secrets into files.

- Python 3.10 to 3.13. One dependency: `httpx`.
- Synchronous (`EnvVaultClient`) and asynchronous (`AsyncEnvVaultClient`) clients.
- Machine identity authentication: the service credential is exchanged for
  short lived access tokens, renewed before they expire.
- Typed models and errors, timeouts, controlled retries, pagination.
- `python -m envvault run` starts a command with the values in its
  environment only.

All decryption happens on the EnvVault API; this package implements no
cryptography.

## Install

Not on PyPI yet. From a checkout of the repository:

```bash
pip install ./packages/sdk-python
```

## Quick start

```bash
export ENVVAULT_API_URL=https://api.envvault.example.com
export ENVVAULT_SERVICE_CREDENTIAL=...   # from your CI or secrets manager, never from code
```

```python
from envvault import EnvVaultClient

with EnvVaultClient.from_environment() as client:
    config = client.get_runtime_config(environment="staging")
    print("Configuration loaded:", len(config))
    database_url = config["DATABASE_URL"]
```

`config` is a read only mapping. Its `repr` lists keys only, never values.
Do not print or log values.

## Run a command with the values

```bash
python -m envvault run --env staging -- python manage.py migrate
```

The command starts without a shell; the service credential is removed from
its environment; the exit status is passed through (128 plus the signal
number when a signal ends it, 127 when the command does not exist).

## Errors

| Exception               | When                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `AuthenticationError`   | 401: credential invalid, expired or revoked (`code` tells which)                |
| `PermissionDeniedError` | 403: missing scope or grant                                                     |
| `NotFoundError`         | 404: missing, or not available to this identity                                 |
| `RateLimitError`        | 429: wait `retry_after` seconds                                                 |
| `ValidationError`       | 400 or 422, with `issues`                                                       |
| `NetworkError`          | API unreachable or too slow                                                     |
| `ConfigurationError`    | Missing API URL or credential, insecure URL, credential file readable by others |

Every `ApiError` has `status_code`, `code`, `message` and `request_id`.

See `docs/sdk-python.md` in the repository for the full guide.
