"""
``python -m envvault``: a small command line for machine identities.

    python -m envvault whoami
    python -m envvault run --env staging -- python manage.py migrate

Reads ENVVAULT_API_URL and ENVVAULT_SERVICE_CREDENTIAL (or
ENVVAULT_SERVICE_CREDENTIAL_FILE). Never prints values or tokens.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from .client import EnvVaultClient
from .errors import (
    ApiError,
    AuthenticationError,
    ConfigurationError,
    EnvVaultError,
    MissingRequiredError,
    NetworkError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
)
from .runner import run

# Same exit codes as the envvault CLI (docs/cli.md).
EXIT_USAGE = 2
EXIT_CONFIG = 3
EXIT_AUTH = 4
EXIT_FORBIDDEN = 5
EXIT_NOT_FOUND = 6
EXIT_UNAVAILABLE = 7
EXIT_MISSING = 8
EXIT_RATE_LIMITED = 9


def _exit_code(error: EnvVaultError) -> int:
    if isinstance(error, ConfigurationError):
        return EXIT_CONFIG
    if isinstance(error, AuthenticationError):
        return EXIT_AUTH
    if isinstance(error, PermissionDeniedError):
        return EXIT_FORBIDDEN
    if isinstance(error, NotFoundError):
        return EXIT_NOT_FOUND
    if isinstance(error, RateLimitError):
        return EXIT_RATE_LIMITED
    if isinstance(error, MissingRequiredError):
        return EXIT_MISSING
    if isinstance(error, (NetworkError, ApiError)):
        return EXIT_UNAVAILABLE
    return 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m envvault")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("whoami", help="Show the machine identity and its environments")
    run_parser = commands.add_parser("run", help="Run a command with an environment's values")
    run_parser.add_argument("--env", required=True, help="Environment name, slug or id")
    run_parser.add_argument("--no-override", action="store_true", help="Keep variables already set")
    run_parser.add_argument(
        "--no-inherited", action="store_true", help="Leave out inherited values"
    )
    run_parser.add_argument(
        "--allow-missing", action="store_true", help="Run with required values missing"
    )
    run_parser.add_argument("cmd", nargs=argparse.REMAINDER, help="Command after --")
    args = parser.parse_args(argv)

    try:
        if args.command == "whoami":
            with EnvVaultClient.from_environment() as client:
                me = client.identity()
                print(f"{me.name} (project {me.project_name})")
                for env in me.environments:
                    print(f"  {env.name}: {', '.join(env.permissions)}")
            return 0
        command = list(args.cmd)
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            print("Give a command after --", file=sys.stderr)
            return EXIT_USAGE
        return run(
            command,
            environment=args.env,
            override=not args.no_override,
            include_inherited=not args.no_inherited,
            allow_missing=args.allow_missing,
        )
    except EnvVaultError as error:
        print(f"Error: {error}", file=sys.stderr)
        return _exit_code(error)


if __name__ == "__main__":
    sys.exit(main())
