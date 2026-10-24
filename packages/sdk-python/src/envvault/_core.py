"""Logic shared by the synchronous and asynchronous clients."""

from __future__ import annotations

import os
import re
import stat
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from ._version import __version__
from .errors import ConfigurationError, Issue, api_error
from .models import MachineToken

API_BASE_PATH = "/api/v1"
CREDENTIAL_ENV = "ENVVAULT_SERVICE_CREDENTIAL"
CREDENTIAL_FILE_ENV = "ENVVAULT_SERVICE_CREDENTIAL_FILE"
API_URL_ENV = "ENVVAULT_API_URL"
CREDENTIAL_PATTERN = re.compile(r"^evv_sk_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$")
REQUEST_ID_HEADER = "x-request-id"
TOKEN_REJECTED = frozenset({"TOKEN_EXPIRED", "TOKEN_REVOKED", "TOKEN_INVALID"})
RETRYABLE_STATUS = frozenset({502, 503, 504})
LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})

CredentialSource = Callable[[], str]


@dataclass(frozen=True)
class Settings:
    api_url: str
    timeout: float
    retries: int
    rate_limit_retries: int
    max_retry_after: float
    user_agent: str
    renew_before: float


def normalize_api_url(value: str) -> str:
    """The API origin. Plain http is accepted only on this machine."""
    parts = urlsplit(value.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigurationError("The API URL must be an http or https URL")
    if parts.scheme == "http" and parts.hostname not in LOOPBACK:
        raise ConfigurationError("The API URL must use https (http only for localhost)")
    return f"{parts.scheme}://{parts.netloc}"


def checked_credential(value: str, origin: str) -> str:
    token = value.strip()
    # Never repeat what was read: it may be some other secret pasted by mistake.
    if not CREDENTIAL_PATTERN.match(token):
        raise ConfigurationError(f"{origin} does not hold an EnvVault service credential")
    return token


def read_credential_file(path: str) -> str:
    """Reads a credential from a file only its owner can read (POSIX permissions)."""
    try:
        info = os.stat(path)
    except OSError as error:
        raise ConfigurationError("The credential file cannot be read") from error
    if not stat.S_ISREG(info.st_mode):
        raise ConfigurationError("The credential file cannot be read")
    if sys.platform != "win32" and info.st_mode & 0o077:
        raise ConfigurationError("The credential file can be read by other users (chmod 600)")
    with open(path, encoding="utf-8") as handle:
        return checked_credential(handle.read(), "The credential file")


def credential_from_environment(env: Mapping[str, str]) -> CredentialSource:
    inline = env.get(CREDENTIAL_ENV)
    if inline:
        token = checked_credential(inline, CREDENTIAL_ENV)
        return lambda: token
    path = env.get(CREDENTIAL_FILE_ENV)
    if path:
        return lambda: read_credential_file(path)
    raise ConfigurationError(f"Set {CREDENTIAL_ENV} or {CREDENTIAL_FILE_ENV}")


def credential_source(credential: str | CredentialSource) -> CredentialSource:
    if callable(credential):
        return credential
    token = checked_credential(credential, "The credential")
    return lambda: token


def user_agent(extra: str | None) -> str:
    base = f"envvault-python/{__version__} python/{sys.version_info.major}.{sys.version_info.minor}"
    return f"{extra} {base}" if extra else base


def path(*segments: str) -> str:
    return "/" + "/".join(quote(segment, safe="") for segment in segments)


def token_usable(token: MachineToken | None, renew_before: float) -> bool:
    if token is None:
        return False
    expires = parse_time(token.expires_at)
    return expires - renew_before > time.time()


def parse_time(value: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if not value:
        return None
    try:
        seconds = float(value)
        return seconds if seconds >= 0 else None
    except ValueError:
        pass
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return None


def backoff(attempt: int) -> float:
    import random

    # Jitter only spreads retries out; it protects nothing, so a plain generator is fine.
    return float(min(2.0, 0.2 * 2 ** (attempt - 1)) * (0.5 + random.random() / 2))  # noqa: S311


def error_from(response: httpx.Response) -> Exception:
    """An ApiError subclass from the error envelope; never includes the request."""
    body: Any
    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        error = {}
    issues = []
    for item in error.get("issues") or []:
        if isinstance(item, dict) and isinstance(item.get("path"), str):
            issues.append(Issue(item["path"], str(item.get("message", ""))))
    code = error.get("code")
    message = error.get("message")
    request_id = error.get("requestId") or response.headers.get(REQUEST_ID_HEADER)
    return api_error(
        response.status_code,
        code if isinstance(code, str) else "UNKNOWN_ERROR",
        message
        if isinstance(message, str)
        else f"Request failed with status {response.status_code}",
        request_id=request_id if isinstance(request_id, str) else None,
        issues=issues,
        retry_after=retry_after(response),
    )


def network_error_reason(error: httpx.HTTPError) -> str:
    return "timeout" if isinstance(error, httpx.TimeoutException) else "unreachable"
