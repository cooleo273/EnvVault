from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import httpx
import pytest

from envvault import (
    AuthenticationError,
    ConfigurationError,
    EnvVaultClient,
    IncompatibleApiError,
    NetworkError,
    NotFoundError,
    RateLimitError,
)

from .fake_api import CREDENTIAL, PROJECT, STAGING, SYNTHETIC, FakeApi, error

API = "http://localhost:4000"


def client(api: FakeApi, **options: object) -> EnvVaultClient:
    return EnvVaultClient(API, credential=CREDENTIAL, transport=api.transport(), **options)  # type: ignore[arg-type]


def test_loads_runtime_values_with_one_exchange() -> None:
    api = FakeApi()
    with client(api) as c:
        config = c.get_runtime_config(environment="staging")
        assert len(config) == 2
        assert config["API_TOKEN"] == SYNTHETIC
        assert dict(config) == config.as_dict()
        c.get_runtime_config(environment_id=STAGING, project_id=PROJECT)
    assert api.exchanges == 1
    assert api.revoked == 1
    credential_uses = [r for r in api.requests if CREDENTIAL in r.headers.get("authorization", "")]
    assert [r.url.path for r in credential_uses] == ["/api/v1/machine/token"]


def test_never_shows_values_tokens_or_the_credential() -> None:
    api = FakeApi()
    with client(api) as c:
        config = c.get_runtime_config(environment="Staging")
        token = c.authenticate()
        shown = " ".join([repr(config), str(config), repr(token), repr(c), repr(config.entries)])
    assert SYNTHETIC not in shown
    assert "evv_mt_" not in shown
    assert CREDENTIAL not in shown
    assert "API_TOKEN" in repr(config)


def test_renews_tokens_close_to_expiry_and_after_rejection() -> None:
    api = FakeApi(expires_in=30)
    with client(api) as c:
        c.environments()
        c.environments()
    assert api.exchanges == 2

    rejected = FakeApi(reject_first_use=True)
    with client(rejected) as c:
        assert c.get_runtime_config(environment="staging")["API_URL"] == "https://api.example.test"
    assert rejected.exchanges == 2


def test_retries_reads_but_never_runtime_loads_after_failures() -> None:
    api = FakeApi()
    with client(api, retries=1) as c:
        c.authenticate()
        api.fail_statuses.append(503)
        assert [e.slug for e in c.environments()] == ["staging"]

    def down(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/runtime"):
            raise httpx.ConnectError("down")
        return FakeApi().handler(request)

    attempts: list[str] = []

    def counting(request: httpx.Request) -> httpx.Response:
        attempts.append(request.url.path)
        return down(request)

    c = EnvVaultClient(
        API, credential=CREDENTIAL, transport=httpx.MockTransport(counting), retries=3
    )
    with pytest.raises(NetworkError):
        c.get_runtime_config(environment="staging")
    assert sum(1 for p in attempts if p.endswith("/runtime")) == 1
    c.close()


def test_typed_errors_carry_request_ids_and_retry_after() -> None:
    def limited(request: httpx.Request) -> httpx.Response:
        return error(429, "TOO_MANY_REQUESTS", {"retry-after": "7"})

    c = EnvVaultClient(API, transport=httpx.MockTransport(limited))
    with pytest.raises(RateLimitError) as caught:
        c.meta()
    assert caught.value.retry_after == 7
    assert caught.value.request_id == "req-429"
    assert caught.value.code == "TOO_MANY_REQUESTS"
    c.close()

    calls = 0

    def once(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return error(429, "TOO_MANY_REQUESTS", {"retry-after": "0"})
        return httpx.Response(200, json={"version": "1", "protocolVersion": 1, "features": []})

    with EnvVaultClient(API, transport=httpx.MockTransport(once), rate_limit_retries=1) as c2:
        assert c2.meta().protocol_version == 1
    assert calls == 2


def test_wrong_credential_and_unknown_environment() -> None:
    bad = "evv_sk_" + "Z" * 16 + "_" + "c" * 43
    with EnvVaultClient(API, credential=bad, transport=FakeApi().transport()) as c:
        with pytest.raises(AuthenticationError) as caught:
            c.environments()
        assert caught.value.code == "INVALID_CREDENTIAL"
    with client(FakeApi()) as c, pytest.raises(NotFoundError):
        c.get_runtime_config(environment="production")
    with client(FakeApi()) as c:
        c.authenticate()
        with pytest.raises(NotFoundError):
            c.get_runtime_config(environment="staging", project_id="another-project")


def test_compatibility_check() -> None:
    def future(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"version": "9", "protocolVersion": 2, "features": []})

    with (
        EnvVaultClient(API, transport=httpx.MockTransport(future)) as c,
        pytest.raises(IncompatibleApiError),
    ):
        c.check_compatibility()


def test_configuration_rules(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError):
        EnvVaultClient("http://api.example.test")
    with pytest.raises(ConfigurationError, match="ENVVAULT_API_URL"):
        EnvVaultClient.from_environment({})
    pasted = "ghp_synthetic_not_ours"
    with pytest.raises(ConfigurationError) as caught:
        EnvVaultClient.from_environment(
            {"ENVVAULT_API_URL": API, "ENVVAULT_SERVICE_CREDENTIAL": pasted}
        )
    assert pasted not in str(caught.value)
    with pytest.raises(ConfigurationError):
        EnvVaultClient(API, credential=CREDENTIAL, access_token="evv_at_x")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions")
def test_credential_file_must_be_private(tmp_path: Path) -> None:
    path = tmp_path / "credential"
    path.write_text(CREDENTIAL + "\n")
    os.chmod(path, 0o644)
    env = {"ENVVAULT_API_URL": API, "ENVVAULT_SERVICE_CREDENTIAL_FILE": str(path)}
    with (
        EnvVaultClient.from_environment(env, transport=FakeApi().transport()) as c,
        pytest.raises(ConfigurationError, match="other users"),
    ):
        c.environments()
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    with EnvVaultClient.from_environment(env, transport=FakeApi().transport()) as c:
        assert len(c.environments()) == 1
