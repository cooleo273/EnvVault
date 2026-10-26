"""Asynchronous EnvVault client (same API as EnvVaultClient, awaitable)."""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
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


class AsyncEnvVaultClient:
    """Asynchronous counterpart of EnvVaultClient. Use ``async with``."""

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
        transport: httpx.AsyncBaseTransport | None = None,
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
        self._lock = asyncio.Lock()
        self._http = httpx.AsyncClient(
            base_url=self._settings.api_url + _core.API_BASE_PATH,
            timeout=timeout,
            transport=transport,
            headers={"accept": "application/json", "user-agent": self._settings.user_agent},
            follow_redirects=False,
        )

    @classmethod
    def from_environment(
        cls, env: Mapping[str, str] | None = None, **options: Any
    ) -> AsyncEnvVaultClient:
        source = os.environ if env is None else env
        api_url = options.pop("api_url", None) or source.get(_core.API_URL_ENV)
        if not api_url:
            raise ConfigurationError(f"Set {_core.API_URL_ENV}")
        return cls(api_url, credential=_core.credential_from_environment(source), **options)

    async def __aenter__(self) -> AsyncEnvVaultClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Ends the current machine access token (best effort) and closes connections."""
        token, self._token = self._token, None
        try:
            if token is not None:
                with contextlib.suppress(httpx.HTTPError):
                    await self._http.post(
                        "/machine/token/revoke",
                        headers={"authorization": f"Bearer {token.access_token}"},
                    )
        finally:
            await self._http.aclose()

    def __repr__(self) -> str:
        mode = "machine" if self._credential else "token" if self._access_token else "anonymous"
        return f"AsyncEnvVaultClient(api_url={self._settings.api_url!r}, mode={mode!r})"

    async def authenticate(self) -> MachineToken:
        async with self._lock:
            return await self._exchange()

    async def _current_token(self) -> MachineToken:
        async with self._lock:
            token = self._token
            if token is not None and _core.token_usable(token, self._settings.renew_before):
                return token
            return await self._exchange()

    async def _exchange(self) -> MachineToken:
        if self._credential is None:
            raise ConfigurationError("This client has no service credential")
        body: dict[str, Any] = {}
        if self._scopes:
            body["scopes"] = self._scopes
        if self._environment_ids:
            body["environmentIds"] = self._environment_ids
        data = await self._send(
            "POST", "/machine/token", json=body, bearer=self._credential(), repeatable=False
        )
        self._token = MachineToken.from_dict(data)
        return self._token

    async def _bearer(self) -> str | None:
        if self._credential is not None:
            return (await self._current_token()).access_token
        if self._access_token is not None:
            return self._access_token() if callable(self._access_token) else self._access_token
        return None

    async def _send(
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
        token = bearer if bearer is not None else (await self._bearer() if authenticated else None)
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        attempt = 0
        while True:
            attempt += 1
            try:
                response = await self._http.request(method, path, json=json, headers=headers)
            except httpx.HTTPError as error:
                if attempt < attempts:
                    await asyncio.sleep(_core.backoff(attempt))
                    continue
                raise NetworkError(_core.network_error_reason(error)) from None
            if attempt < attempts and response.status_code in _core.RETRYABLE_STATUS:
                await asyncio.sleep(_core.backoff(attempt))
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
                await asyncio.sleep(wait)
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

    async def _call(
        self, method: str, path: str, *, json: Any = None, repeatable: bool | None = None
    ) -> Any:
        try:
            return await self._send(method, path, json=json, repeatable=repeatable)
        except AuthenticationError as error:
            if self._credential is None or error.code not in _core.TOKEN_REJECTED:
                raise
            self._token = None
            return await self._send(method, path, json=json, repeatable=repeatable)

    async def health(self) -> Mapping[str, Any]:
        data = await self._send("GET", "/health", authenticated=False)
        if not isinstance(data, dict):
            raise ResponseValidationError("Unexpected health response")
        return data

    async def meta(self) -> Meta:
        return Meta.from_dict(await self._send("GET", "/meta", authenticated=False))

    async def check_compatibility(self) -> Meta:
        meta = await self.meta()
        if meta.protocol_version != PROTOCOL_VERSION:
            raise IncompatibleApiError(meta.protocol_version, PROTOCOL_VERSION)
        return meta

    async def identity(self) -> MachineIdentity:
        return MachineIdentity.from_dict(await self._call("GET", "/machine/identity"))

    async def environments(self) -> list[Environment]:
        data = await self._call("GET", "/machine/environments")
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise ResponseValidationError("Unexpected environments response")
        return [Environment.from_dict(item) for item in data["items"]]

    async def resolve_environment(self, ref: str) -> Environment:
        for env in await self.environments():
            if _matches(env, ref):
                return env
        raise NotFoundError(
            404, "NOT_FOUND", f'No environment "{ref}" is available to this identity'
        )

    async def list_variables(self, environment: str) -> list[Variable]:
        env = await self.resolve_environment(environment)
        data = await self._call("GET", _core.path("machine", "environments", env.id, "variables"))
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise ResponseValidationError("Unexpected variables response")
        return [Variable.from_dict(item) for item in data["items"]]

    async def get_runtime_config(
        self,
        *,
        environment: str | None = None,
        environment_id: str | None = None,
        project_id: str | None = None,
        workspace_id: str | None = None,
        include_inherited: bool = True,
    ) -> RuntimeConfig:
        body = {"includeInherited": include_inherited}
        if self._credential is not None:
            ref = environment_id or environment
            if not ref:
                raise ConfigurationError("Pass environment or environment_id")
            env = await self.resolve_environment(ref)
            if (
                project_id is not None
                and self._token is not None
                and project_id != self._token.project_id
            ):
                raise NotFoundError(404, "NOT_FOUND", "This identity belongs to another project")
            data = await self._call(
                "POST", _core.path("machine", "environments", env.id, "runtime"), json=body
            )
        else:
            if not (workspace_id and project_id and environment_id):
                raise ConfigurationError("Pass workspace_id, project_id and environment_id")
            data = await self._call(
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

    async def list_workspaces(self) -> list[Workspace]:
        data = await self._call("GET", "/workspaces")
        if not isinstance(data, list):
            raise ResponseValidationError("Unexpected workspaces response")
        return [Workspace.from_dict(item) for item in data]

    async def _pages(
        self, base: str, page_size: int, max_pages: int
    ) -> AsyncIterator[Mapping[str, Any]]:
        for page in range(1, max_pages + 1):
            result = Page.from_dict(
                await self._call("GET", f"{base}?page={page}&pageSize={page_size}")
            )
            for item in result.items:
                yield item
            if not result.items or result.page * result.page_size >= result.total:
                return

    async def iter_projects(
        self, workspace_id: str, *, page_size: int = 100, max_pages: int = 1000
    ) -> AsyncIterator[Project]:
        base = _core.path("workspaces", workspace_id, "projects")
        async for item in self._pages(base, page_size, max_pages):
            yield Project.from_dict(item)

    async def iter_environments(
        self, workspace_id: str, project_id: str, *, page_size: int = 100, max_pages: int = 1000
    ) -> AsyncIterator[Environment]:
        base = _core.path("workspaces", workspace_id, "projects", project_id, "environments")
        async for item in self._pages(base, page_size, max_pages):
            yield Environment.from_dict(item)
