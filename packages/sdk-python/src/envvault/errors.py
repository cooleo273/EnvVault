"""Typed errors. Messages are safe to show; none contain tokens or values."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass


class EnvVaultError(Exception):
    """Base class for every error raised by this SDK."""


class ConfigurationError(EnvVaultError):
    """Missing or invalid client configuration (API URL, credential)."""


class NetworkError(EnvVaultError):
    """The API could not be reached or did not answer in time."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(
            "The EnvVault API did not answer in time"
            if reason == "timeout"
            else "The EnvVault API could not be reached"
        )


class IncompatibleApiError(EnvVaultError):
    """The server speaks a protocol version this SDK does not know."""

    def __init__(self, server_version: int, client_version: int) -> None:
        self.server_version = server_version
        self.client_version = client_version
        super().__init__(
            f"The EnvVault API speaks protocol {server_version}; this SDK supports {client_version}"
        )


class ResponseValidationError(EnvVaultError):
    """The API answered with an unexpected shape."""


@dataclass(frozen=True)
class Issue:
    """One field level validation problem (never the submitted value)."""

    path: str
    message: str


class ApiError(EnvVaultError):
    """A non 2xx answer from the API. Branch on ``code``, not on the message."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        request_id: str | None = None,
        issues: Sequence[Issue] = (),
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.request_id = request_id
        self.issues = tuple(issues)
        #: Seconds to wait before retrying (rate limits), from ``Retry-After``.
        self.retry_after = retry_after

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status_code={self.status_code}, code={self.code!r})"


class AuthenticationError(ApiError):
    """401: credential or token invalid, expired or revoked."""


class PermissionDeniedError(ApiError):
    """403: authenticated, but not allowed (scope, grant, protected environment)."""


class NotFoundError(ApiError):
    """404: missing, or outside the caller's access (indistinguishable on purpose)."""


class RateLimitError(ApiError):
    """429: wait ``retry_after`` seconds."""


class ValidationError(ApiError):
    """400 or 422: the request was rejected; see ``issues``."""


class MissingRequiredError(EnvVaultError):
    """Required variables have no value in the environment."""

    def __init__(self, keys: Sequence[str]) -> None:
        self.keys = tuple(keys)
        super().__init__("Required variables have no value: " + ", ".join(self.keys))


_BY_STATUS: Mapping[int, type[ApiError]] = {
    400: ValidationError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    422: ValidationError,
    429: RateLimitError,
}


def api_error(
    status_code: int,
    code: str,
    message: str,
    *,
    request_id: str | None = None,
    issues: Sequence[Issue] = (),
    retry_after: float | None = None,
) -> ApiError:
    cls = _BY_STATUS.get(status_code, ApiError)
    return cls(
        status_code,
        code,
        message,
        request_id=request_id,
        issues=issues,
        retry_after=retry_after,
    )
