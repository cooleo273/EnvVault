"""A fake EnvVault API on httpx.MockTransport (synthetic values only)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

CREDENTIAL = "evv_sk_" + "A" * 16 + "_" + "b" * 43
WORKSPACE = "0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c02"
PROJECT = "0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c03"
STAGING = "0b6f1f54-8a52-4a43-9a4a-1c7a7d4f0c05"
SYNTHETIC = "synthetic-python-value-77"

ENVIRONMENT = {
    "id": STAGING,
    "name": "Staging",
    "slug": "staging",
    "kind": "STAGING",
    "isProtected": False,
    "status": "ACTIVE",
    "permissions": ["environment:read", "secret:list", "secret:runtime"],
}


def error(status: int, code: str, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(
        status,
        json={"error": {"statusCode": status, "code": code, "message": code.lower()}},
        headers={"x-request-id": f"req-{status}", **(headers or {})},
    )


@dataclass
class FakeApi:
    expires_in: int = 900
    reject_first_use: bool = False
    fail_statuses: list[int] = field(default_factory=list)
    missing_required: list[str] = field(default_factory=list)
    exchanges: int = 0
    requests: list[httpx.Request] = field(default_factory=list)
    revoked: int = 0

    def token(self) -> dict[str, Any]:
        self.exchanges += 1
        expires = datetime.now(timezone.utc) + timedelta(seconds=self.expires_in)
        return {
            "accessToken": "evv_mt_" + str(self.exchanges) * 43,
            "tokenType": "Bearer",
            "expiresIn": self.expires_in,
            "expiresAt": expires.isoformat().replace("+00:00", "Z"),
            "scopes": ["environment:read", "secret:list", "secret:runtime"],
            "environmentIds": [],
            "identity": {"id": "i", "name": "ci", "workspaceId": WORKSPACE, "projectId": PROJECT},
            "credential": {"id": "c", "name": "ci", "expiresAt": "2030-01-01T00:00:00.000Z"},
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.removeprefix("/api/v1")
        if self.fail_statuses:
            return error(self.fail_statuses.pop(0), "SERVICE_UNAVAILABLE")
        if path == "/meta":
            return httpx.Response(
                200, json={"version": "0.0.0", "protocolVersion": 1, "features": []}
            )
        if path == "/machine/token":
            if request.headers.get("authorization") != f"Bearer {CREDENTIAL}":
                return error(401, "INVALID_CREDENTIAL")
            return httpx.Response(200, json=self.token())
        if path == "/machine/token/revoke":
            self.revoked += 1
            return httpx.Response(204)
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer evv_mt_"):
            return error(401, "UNAUTHENTICATED")
        if self.reject_first_use:
            self.reject_first_use = False
            return error(401, "TOKEN_REVOKED")
        if path == "/machine/environments":
            return httpx.Response(200, json={"items": [ENVIRONMENT]})
        if path == f"/machine/environments/{STAGING}/runtime":
            body = json.loads(request.content or b"{}")
            assert body == {"includeInherited": True}
            return httpx.Response(
                200,
                json={
                    "environmentId": STAGING,
                    "values": [
                        {"key": "API_URL", "value": "https://api.example.test", "source": "local"},
                        {"key": "API_TOKEN", "value": SYNTHETIC, "source": "local"},
                    ],
                    "missingRequired": self.missing_required,
                    "withheldInherited": 0,
                    "issuedAt": "2026-01-01T00:00:00.000Z",
                },
            )
        if path == f"/machine/environments/{STAGING}/variables":
            return httpx.Response(
                200,
                json={
                    "environmentId": STAGING,
                    "items": [
                        {"key": "API_TOKEN", "type": "SECRET", "isRequired": True, "hasValue": True}
                    ],
                },
            )
        return error(404, "NOT_FOUND")

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def async_transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)
