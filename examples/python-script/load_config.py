"""
A one off script that loads its configuration from EnvVault.

    export ENVVAULT_API_URL=https://api.envvault.example.com
    export ENVVAULT_SERVICE_CREDENTIAL=...   # from your secret store, never from code
    python load_config.py staging

Prints how many values were loaded, never the values themselves.
"""

from __future__ import annotations

import sys

from envvault import EnvVaultClient, EnvVaultError


def main(environment: str) -> int:
    try:
        with EnvVaultClient.from_environment() as client:
            config = client.get_runtime_config(environment=environment)
    except EnvVaultError as error:
        print(f"Could not load configuration: {error}", file=sys.stderr)
        return 1
    print("Configuration loaded:", len(config))
    if config.missing_required:
        print("Missing required values:", ", ".join(config.missing_required), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "development"))
