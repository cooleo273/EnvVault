"""A long running Python worker that keeps its EnvVault configuration current.

    ENVVAULT_API_URL=https://api.envvault.example.com \\
    ENVVAULT_SERVICE_CREDENTIAL_FILE=/run/secrets/envvault \\
    ENVVAULT_ENVIRONMENT=production python worker.py

Same behaviour as examples/node-worker: fail closed at startup, refresh every
REFRESH_SECONDS with jitter, keep the last configuration through a short
outage (at most MAX_STALE_SECONDS), stop when access is revoked. Values stay
in memory and are never printed.
"""

from __future__ import annotations

import os
import random
import signal
import sys
import time
from collections.abc import Mapping

from envvault import ApiError, EnvVaultClient, NetworkError

ENVIRONMENT = os.environ.get("ENVVAULT_ENVIRONMENT", "development")
REFRESH = float(os.environ.get("REFRESH_SECONDS", "300"))
MAX_STALE = float(os.environ.get("MAX_STALE_SECONDS", "1800"))
EXIT_REVOKED = 3
EXIT_STALE = 4


def load() -> Mapping[str, str]:
    with EnvVaultClient.from_environment(timeout=10.0, retries=2) as client:
        return client.get_runtime_config(environment=ENVIRONMENT).as_dict()


def revoked(error: Exception) -> bool:
    return isinstance(error, ApiError) and error.status_code in (401, 403, 404)


def transient(error: Exception) -> bool:
    return isinstance(error, NetworkError) or (
        isinstance(error, ApiError) and (error.status_code >= 500 or error.status_code == 429)
    )


def describe(error: Exception) -> str:
    if isinstance(error, ApiError):
        return f"{error.code} (request {error.request_id or 'unknown'})"
    return "network error" if isinstance(error, NetworkError) else "unexpected error"


def main() -> int:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        config = load()
    # Startup fails closed whatever went wrong.
    except Exception as error:
        print(f"Configuration could not be loaded ({describe(error)}); not starting.", flush=True)
        return EXIT_REVOKED if revoked(error) else EXIT_STALE
    loaded_at = time.monotonic()
    print(f"Configuration loaded: {len(config)} values from {ENVIRONMENT}", flush=True)
    while True:
        # Jitter keeps a fleet of workers from reloading at the same moment.
        time.sleep(REFRESH * (1 + 0.1 * random.random()))  # noqa: S311 - not security sensitive
        try:
            config = load()
            loaded_at = time.monotonic()
            print(f"Configuration loaded: {len(config)} values from {ENVIRONMENT}", flush=True)
        except Exception as error:
            if revoked(error):
                print(f"Access to EnvVault ended ({describe(error)}); stopping.", flush=True)
                return EXIT_REVOKED
            if not transient(error) or time.monotonic() - loaded_at > MAX_STALE:
                reason = describe(error)
                print(f"Configuration could not be refreshed ({reason}); stopping.", flush=True)
                return EXIT_STALE
            reason = describe(error)
            print(f"Refresh failed ({reason}); keeping the last configuration.", flush=True)


if __name__ == "__main__":
    sys.exit(main())
