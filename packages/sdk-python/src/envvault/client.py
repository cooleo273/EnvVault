"""Synchronous EnvVault client."""

from __future__ import annotations

import contextlib
import os
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from types import TracebackType
from typing import Any

import httpx

from . import _core
from ._version import PROTOCOL_VERSION
from .errors import (
    AuthenticationError,
    ConfigurationError,
    IncompatibleApiError,
    NetworkError,
    NotFoundError,
    ResponseValidationError,
)
from .models import (
    Environment,
    MachineIdentity,
    MachineToken,
    Meta,
    Page,
    Project,
    RuntimeConfig,
    Variable,
    Workspace,
)


def _matches(env: Environment, ref: str) -> bool:
    lower = ref.lower()
    return env.id == lower or env.slug == lower or env.name.lower() == lower


class EnvVaultClient:
    """
    Client for the EnvVault API.

    With ``credential`` (a machine identity's service credential) it
    exchanges the credential for short lived access tokens on demand and
    calls the ``/machine`` routes. With ``access_token`` it sends that token
    as is (for example a CLI token) to the routes that accept it.

    Use it as a context manager, or call ``close()``, so the last access
    token is ended on the server and connections are released.
    """

    def __init__(
        self,
        api_url: str,
        *,
        credential: str | Callable[[], str] | None = None,
        access_token: str | Callable[[], str] | None = None,
        scopes: Sequence[str] | None = None,
        environment_ids: Sequence[str] | None = None,
        timeout: float = 10.0,
        retries: int = 2,
        rate_limit_retries: int = 0,
        max_retry_after: float = 30.0,
        user_agent: str | None = None,
        renew_before: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if credential is not None and access_token is not None:
            raise ConfigurationError("Pass either a credential or an access token, not both")
        self._settings = _core.Settings(
            api_url=_core.normalize_api_url(api_url),
            timeout=timeout,
            retries=max(0, retries),
            rate_limit_retries=max(0, rate_limit_retries),
            max_retry_after=max_retry_after,
            user_agent=_core.user_agent(user_agent),
            renew_before=renew_before,
        )
        self._credential = None if credential is None else _core.credential_source(credential)
        self._access_token = access_token
        self._scopes = list(scopes) if scopes else None
        self._environment_ids = list(environment_ids) if environment_ids else None
        self._token: MachineToken | None = None
        self._lock = threading.Lock()
        self._http = httpx.Client(
            base_url=self._settings.api_url + _core.API_BASE_PATH,
            timeout=timeout,
            transport=transport,
            headers={"accept": "application/json", "user-agent": self._settings.user_agent},
            follow_redirects=False,
        )

    @classmethod
    def from_environment(
        cls, env: Mapping[str, str] | None = None, **options: Any
    ) -> EnvVaultClient:
        """
        Configured as in CI: ``ENVVAULT_API_URL`` and ``ENVVAULT_SERVICE_CREDENTIAL``
        (or ``ENVVAULT_SERVICE_CREDENTIAL_FILE``, readable by its owner only).
        """
        source = os.environ if env is None else env
        api_url = options.pop("api_url", None) or source.get(_core.API_URL_ENV)
        if not api_url:
            raise ConfigurationError(f"Set {_core.API_URL_ENV}")
        return cls(api_url, credential=_core.credential_from_environment(source), **options)

    # ------------------------------------------------------------------ lifecycle

    def __enter__(self) -> EnvVaultClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        """Ends the current machine access token (best effort) and closes connections."""
        token, self._token = self._token, None
        try:
            if token is not None:
                with contextlib.suppress(httpx.HTTPError):
                    self._http.post(
                        "/machine/token/revoke",
                        headers={"authorization": f"Bearer {token.access_token}"},
                    )
        finally:
            self._http.close()

    def __repr__(self) -> str:
        mode = "machine" if self._credential else "token" if self._access_token else "anonymous"
        return f"EnvVaultClient(api_url={self._settings.api_url!r}, mode={mode!r})"

    # -------------------------------------------------------------- authentication

    def authenticate(self) -> MachineToken:
        """Exchanges the service credential now (normally done on demand)."""
        with self._lock:
            return self._exchange()

    def _current_token(self) -> MachineToken:
        # Checked again under the lock: concurrent callers share one exchange.
        with self._lock:
            token = self._token
            if token is not None and _core.token_usable(token, self._settings.renew_before):
                return token
            return self._exchange()

    def _exchange(self) -> MachineToken:
        if self._credential is None:
            raise ConfigurationError("This client has no service credential")
        body: dict[str, Any] = {}
        if self._scopes:
            body["scopes"] = self._scopes
        if self._environment_ids:
            body["environmentIds"] = self._environment_ids
        data = self._send(
            "POST",
            "/machine/token",
            json=body,
            bearer=self._credential(),
            repeatable=False,
        )
        self._token = MachineToken.from_dict(data)
        return self._token

    def _bearer(self) -> str | None:
        if self._credential is not None:
            return self._current_token().access_token
        if self._access_token is not None:
            value = self._access_token() if callable(self._access_token) else self._access_token
            return value
        return None

    # -------------------------------------------------------------------- requests

    def _send(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        bearer: str | None = None,
        repeatable: bool | None = None,
        authenticated: bool = True,
    ) -> Any:
        safe = method == "GET" if repeatable is None else repeatable
        attempts = 1 + (self._settings.retries if safe else 0)
        rate_limited = 0
        headers: dict[str, str] = {}
        token = bearer if bearer is not None else (self._bearer() if authenticated else None)
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        attempt = 0
        while True:
            attempt += 1
            try:
                response = self._http.request(method, path, json=json, headers=headers)
            except httpx.HTTPError as error:
                if attempt < attempts:
                    time.sleep(_core.backoff(attempt))
                    continue
                raise NetworkError(_core.network_error_reason(error)) from None
            if attempt < attempts and response.status_code in _core.RETRYABLE_STATUS:
                time.sleep(_core.backoff(attempt))
                continue
            wait = _core.retry_after(response)
            if (
                response.status_code == 429
                and safe
                and rate_limited < self._settings.rate_limit_retries
                and wait is not None
                and wait <= self._settings.max_retry_after
            ):
                rate_limited += 1
                time.sleep(wait)
                continue
            break
        if response.status_code == 204:
            return None
        if response.is_error:
            raise _core.error_from(response)
        try:
            return response.json()
        except ValueError:
            raise ResponseValidationError(f"Unexpected response from {path}") from None

    def _call(
        self, method: str, path: str, *, json: Any = None, repeatable: bool | None = None
    ) -> Any:
        """
        A request with the current token. If the server rejects a machine token
        (expired early, revoked by an admin) it exchanges once more and repeats:
        safe for any method, since a rejected token means nothing was done.
        """
        try:
            return self._send(method, path, json=json, repeatable=repeatable)
        except AuthenticationError as error:
            if self._credential is None or error.code not in _core.TOKEN_REJECTED:
                raise
            self._token = None
            return self._send(method, path, json=json, repeatable=repeatable)

    # ---------------------------------------------------------------- public API

    def health(self) -> Mapping[str, Any]:
        data = self._send("GET", "/health", authenticated=False)
        if not isinstance(data, dict):
            raise ResponseValidationError("Unexpected health response")
        return data

    def meta(self) -> Meta:
        return Meta.from_dict(self._send("GET", "/meta", authenticated=False))

    def check_compatibility(self) -> Meta:
        """Raises IncompatibleApiError when the server speaks another protocol."""
        meta = self.meta()
        if meta.protocol_version != PROTOCOL_VERSION:
            raise IncompatibleApiError(meta.protocol_version, PROTOCOL_VERSION)
        return meta

    # Machine identities ---------------------------------------------------------

    def identity(self) -> MachineIdentity:
        """The machine identity, its credential, token scopes and environments."""
        return MachineIdentity.from_dict(self._call("GET", "/machine/identity"))

    def environments(self) -> list[Environment]:
        """Environments this machine identity may read, with its permissions on each."""
        data = self._call("GET", "/machine/environments")
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise ResponseValidationError("Unexpected environments response")
        return [Environment.from_dict(item) for item in data["items"]]

    def resolve_environment(self, ref: str) -> Environment:
        """An environment by id, slug or name, among those the identity may read."""
        for env in self.environments():
            if _matches(env, ref):
                return env
        raise NotFoundError(
            404, "NOT_FOUND", f'No environment "{ref}" is available to this identity'
        )

    def list_variables(self, environment: str) -> list[Variable]:
        """Variable names and metadata (needs ``secret:list``). Never values."""
        env = self.resolve_environment(environment)
        data = self._call("GET", _core.path("machine", "environments", env.id, "variables"))
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise ResponseValidationError("Unexpected variables response")
        return [Variable.from_dict(item) for item in data["items"]]

    def get_runtime_config(
        self,
        *,
        environment: str | None = None,
        environment_id: str | None = None,
        project_id: str | None = None,
        workspace_id: str | None = None,
        include_inherited: bool = True,
    ) -> RuntimeConfig:
        """
        Decrypted values of an environment (needs ``secret:runtime``). Audited and
        never cached. With a machine credential, ``environment`` may be a name,
        slug or id, and ``project_id`` (if given) must be the identity's project.
        With an access token, pass ``workspace_id``, ``project_id`` and
        ``environment_id``.
        """
        body = {"includeInherited": include_inherited}
        if self._credential is not None:
            ref = environment_id or environment
            if not ref:
                raise ConfigurationError("Pass environment or environment_id")
            env = self.resolve_environment(ref)
            if (
                project_id is not None
                and self._token is not None
                and project_id != self._token.project_id
            ):
                raise NotFoundError(404, "NOT_FOUND", "This identity belongs to another project")
            data = self._call(
                "POST", _core.path("machine", "environments", env.id, "runtime"), json=body
            )
        else:
            if not (workspace_id and project_id and environment_id):
                raise ConfigurationError("Pass workspace_id, project_id and environment_id")
            data = self._call(
                "POST",
                _core.path(
                    "workspaces",
                    workspace_id,
                    "projects",
                    project_id,
                    "environments",
                    environment_id,
                    "runtime",
                ),
                json=body,
            )
        return RuntimeConfig.from_dict(data)

    # People and CLI tokens --------------------------------------------------------

    def list_workspaces(self) -> list[Workspace]:
        data = self._call("GET", "/workspaces")
        if not isinstance(data, list):
            raise ResponseValidationError("Unexpected workspaces response")
        return [Workspace.from_dict(item) for item in data]

    def _pages(self, base: str, page_size: int, max_pages: int) -> Iterator[Mapping[str, Any]]:
        for page in range(1, max_pages + 1):
            result = Page.from_dict(self._call("GET", f"{base}?page={page}&pageSize={page_size}"))
            yield from result.items
            if not result.items or result.page * result.page_size >= result.total:
                return

    def iter_projects(
        self, workspace_id: str, *, page_size: int = 100, max_pages: int = 1000
    ) -> Iterator[Project]:
        base = _core.path("workspaces", workspace_id, "projects")
        for item in self._pages(base, page_size, max_pages):
            yield Project.from_dict(item)

    def iter_environments(
        self, workspace_id: str, project_id: str, *, page_size: int = 100, max_pages: int = 1000
    ) -> Iterator[Environment]:
        base = _core.path("workspaces", workspace_id, "projects", project_id, "environments")
        for item in self._pages(base, page_size, max_pages):
            yield Environment.from_dict(item)
