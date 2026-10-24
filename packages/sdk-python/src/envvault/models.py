"""Response models. Values are plaintext: their reprs never show them."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any

from .errors import ResponseValidationError


def _str(data: Mapping[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise ResponseValidationError(f"Expected text in {key!r}")
    return value


def _opt_str(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ResponseValidationError(f"Expected text in {key!r}")
    return value


def _int(data: Mapping[str, Any], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ResponseValidationError(f"Expected a number in {key!r}")
    return value


def _bool(data: Mapping[str, Any], key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise ResponseValidationError(f"Expected true or false in {key!r}")
    return value


def _list(data: Mapping[str, Any], key: str) -> list[Any]:
    value = data.get(key)
    if not isinstance(value, list):
        raise ResponseValidationError(f"Expected a list in {key!r}")
    return value


def _obj(value: Any, what: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ResponseValidationError(f"Expected an object for {what}")
    return value


def _strings(data: Mapping[str, Any], key: str) -> tuple[str, ...]:
    items = _list(data, key)
    if not all(isinstance(item, str) for item in items):
        raise ResponseValidationError(f"Expected text items in {key!r}")
    return tuple(items)


@dataclass(frozen=True)
class Meta:
    version: str
    protocol_version: int
    features: tuple[str, ...]

    @classmethod
    def from_dict(cls, data: Any) -> Meta:
        d = _obj(data, "meta")
        return cls(_str(d, "version"), _int(d, "protocolVersion"), _strings(d, "features"))


@dataclass(frozen=True)
class Workspace:
    id: str
    name: str
    slug: str

    @classmethod
    def from_dict(cls, data: Any) -> Workspace:
        d = _obj(data, "workspace")
        return cls(_str(d, "id"), _str(d, "name"), _str(d, "slug"))


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    slug: str
    status: str

    @classmethod
    def from_dict(cls, data: Any) -> Project:
        d = _obj(data, "project")
        return cls(_str(d, "id"), _str(d, "name"), _str(d, "slug"), _str(d, "status"))


@dataclass(frozen=True)
class Environment:
    """An environment. ``permissions`` is filled for machine identities only."""

    id: str
    name: str
    slug: str
    kind: str
    is_protected: bool
    status: str
    permissions: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, data: Any) -> Environment:
        d = _obj(data, "environment")
        return cls(
            _str(d, "id"),
            _str(d, "name"),
            _str(d, "slug"),
            _str(d, "kind"),
            _bool(d, "isProtected"),
            _str(d, "status"),
            _strings(d, "permissions") if "permissions" in d else (),
        )

    def can(self, permission: str) -> bool:
        return permission in self.permissions


@dataclass(frozen=True)
class MachineToken:
    """A short lived machine access token. Its repr never shows the token."""

    access_token: str = field(repr=False)
    expires_at: str
    expires_in: int
    scopes: tuple[str, ...]
    environment_ids: tuple[str, ...]
    identity_id: str
    identity_name: str
    workspace_id: str
    project_id: str

    @classmethod
    def from_dict(cls, data: Any) -> MachineToken:
        d = _obj(data, "token")
        identity = _obj(d.get("identity"), "identity")
        token = _str(d, "accessToken")
        if not token.startswith("evv_mt_"):
            raise ResponseValidationError("Unexpected access token format")
        return cls(
            token,
            _str(d, "expiresAt"),
            _int(d, "expiresIn"),
            _strings(d, "scopes"),
            _strings(d, "environmentIds"),
            _str(identity, "id"),
            _str(identity, "name"),
            _str(identity, "workspaceId"),
            _str(identity, "projectId"),
        )


@dataclass(frozen=True)
class MachineIdentity:
    id: str
    name: str
    workspace_id: str
    project_id: str
    project_name: str
    credential_name: str
    credential_expires_at: str
    scopes: tuple[str, ...]
    environments: tuple[Environment, ...]

    @classmethod
    def from_dict(cls, data: Any) -> MachineIdentity:
        d = _obj(data, "identity response")
        identity = _obj(d.get("identity"), "identity")
        credential = _obj(d.get("credential"), "credential")
        token = _obj(d.get("token"), "token")
        return cls(
            _str(identity, "id"),
            _str(identity, "name"),
            _str(identity, "workspaceId"),
            _str(identity, "projectId"),
            _str(identity, "projectName"),
            _str(credential, "name"),
            _str(credential, "expiresAt"),
            _strings(token, "scopes"),
            tuple(Environment.from_dict(e) for e in _list(d, "environments")),
        )


@dataclass(frozen=True)
class Variable:
    """Variable metadata. Never a value."""

    key: str
    type: str
    is_required: bool
    has_value: bool

    @classmethod
    def from_dict(cls, data: Any) -> Variable:
        d = _obj(data, "variable")
        return cls(_str(d, "key"), _str(d, "type"), _bool(d, "isRequired"), _bool(d, "hasValue"))


@dataclass(frozen=True)
class RuntimeValue:
    key: str
    value: str = field(repr=False)
    source: str


@dataclass(frozen=True)
class RuntimeConfig(Mapping[str, str]):
    """
    Decrypted values of an environment, as a read only mapping of key to
    value. Treat it like a password: keep it in memory, pass it to what needs
    it, never print or log it (its repr lists keys only).
    """

    environment_id: str
    entries: tuple[RuntimeValue, ...] = field(repr=False)
    missing_required: tuple[str, ...]
    withheld_inherited: int
    issued_at: str

    @classmethod
    def from_dict(cls, data: Any) -> RuntimeConfig:
        d = _obj(data, "runtime configuration")
        values = []
        for item in _list(d, "values"):
            v = _obj(item, "value")
            values.append(RuntimeValue(_str(v, "key"), _str(v, "value"), _str(v, "source")))
        return cls(
            _str(d, "environmentId"),
            tuple(values),
            _strings(d, "missingRequired"),
            _int(d, "withheldInherited"),
            _str(d, "issuedAt"),
        )

    def __getitem__(self, key: str) -> str:
        for item in reversed(self.entries):
            if item.key == key:
                return item.value
        raise KeyError(key)

    def __iter__(self) -> Iterator[str]:
        seen: dict[str, None] = {}
        for item in self.entries:
            seen.setdefault(item.key)
        return iter(seen)

    def __len__(self) -> int:
        return len({item.key for item in self.entries})

    def __repr__(self) -> str:
        keys = ", ".join(sorted(self))
        return f"RuntimeConfig(environment_id={self.environment_id!r}, keys=[{keys}])"

    __str__ = __repr__

    def as_dict(self) -> dict[str, str]:
        """A plain ``dict`` copy (later values win), for ``subprocess`` or a framework."""
        return {item.key: item.value for item in self.entries}


@dataclass(frozen=True)
class Page:
    """One page of a ``?page=&pageSize=`` list."""

    items: tuple[Mapping[str, Any], ...]
    page: int
    page_size: int
    total: int

    @classmethod
    def from_dict(cls, data: Any) -> Page:
        d = _obj(data, "page")
        return cls(
            tuple(_obj(i, "item") for i in _list(d, "items")),
            _int(d, "page"),
            _int(d, "pageSize"),
            _int(d, "total"),
        )
