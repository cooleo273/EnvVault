"""
Run a command with an environment's values in its environment.

Values travel from the API into the child's environment block only: nothing
is written to disk, printed, logged or placed on the command line, and the
command is started without a shell. The child, its own children, the same
operating system user and administrators can still read that environment
(``/proc/<pid>/environ``, ``ps eww``); environment variables are not an
isolation boundary. Python cannot erase strings from memory either.
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
from collections.abc import Mapping, Sequence
from types import FrameType

from ._core import CREDENTIAL_ENV, CREDENTIAL_FILE_ENV
from .client import EnvVaultClient
from .errors import ConfigurationError, MissingRequiredError

#: Exit status when the command cannot be found (as in shells).
COMMAND_NOT_FOUND = 127

_FORWARDED = tuple(
    getattr(signal, name)
    for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT")
    if hasattr(signal, name)
)


def child_environment(
    base: Mapping[str, str], values: Mapping[str, str], *, override: bool = True
) -> tuple[dict[str, str], int]:
    """
    The parent environment without the service credential, plus ``values``.
    With ``override`` off, variables already set win. Returns the environment
    and how many values were kept from the parent.
    """
    env = {k: v for k, v in base.items() if k not in (CREDENTIAL_ENV, CREDENTIAL_FILE_ENV)}
    kept = 0
    for key, value in values.items():
        if not override and key in env:
            kept += 1
            continue
        env[key] = value
    return env, kept


def run(
    command: Sequence[str],
    *,
    environment: str,
    client: EnvVaultClient | None = None,
    override: bool = True,
    include_inherited: bool = True,
    allow_missing: bool = False,
) -> int:
    """
    Loads the environment's values and runs ``command`` with them. Returns the
    command's exit status (128 plus the signal number when a signal ended it).
    The access token is ended before the command starts.
    """
    if not command:
        raise ConfigurationError("Give a command to run")
    owned = client is None
    active = client if client is not None else EnvVaultClient.from_environment()
    try:
        config = active.get_runtime_config(
            environment=environment, include_inherited=include_inherited
        )
    finally:
        if owned:
            active.close()
    if config.missing_required and not allow_missing:
        raise MissingRequiredError(config.missing_required)
    env, _ = child_environment(os.environ, config.as_dict(), override=override)
    del config
    return _spawn(list(command), env)


def _spawn(command: list[str], env: dict[str, str]) -> int:
    try:
        child = subprocess.Popen(command, env=env, shell=False)
    except FileNotFoundError:
        return COMMAND_NOT_FOUND
    finally:
        env.clear()

    terminal = sys.stdin.isatty()

    def forward(signum: int, _frame: FrameType | None) -> None:
        # From a terminal, Ctrl+C already reaches the child (same process group).
        if terminal and signum in (getattr(signal, "SIGINT", -1), getattr(signal, "SIGQUIT", -1)):
            return
        if child.poll() is None:
            # Windows can only deliver some signals to a child; the rest are dropped.
            with contextlib.suppress(ValueError, OSError):
                child.send_signal(signum)

    previous = {}
    for signum in _FORWARDED:
        with contextlib.suppress(ValueError, OSError):
            previous[signum] = signal.signal(signum, forward)
    try:
        code = child.wait()
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    return 128 - code if code < 0 else code
