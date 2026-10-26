"""
The SDK against a running EnvVault API. apps/api/test/python-sdk.int-spec.ts
starts the API on a local database, prepares synthetic data and credentials,
and runs this module with ENVVAULT_IT_* set. Without them the tests skip
(unless ENVVAULT_IT_REQUIRED=1, which makes a missing setup fail).
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys

import pytest

from envvault import (
    AsyncEnvVaultClient,
    AuthenticationError,
    EnvVaultClient,
    NotFoundError,
    PermissionDeniedError,
)

pytestmark = pytest.mark.integration

REQUIRED = (
    "API_URL",
    "CREDENTIAL",
    "REVOKED",
    "EXPIRED",
    "NARROW",
    "PROJECT",
    "DIGEST",
    "PROTECTED",
)
SETTINGS = {name: os.environ.get(f"ENVVAULT_IT_{name}", "") for name in REQUIRED}

if not all(SETTINGS.values()):
    if os.environ.get("ENVVAULT_IT_REQUIRED") == "1":
        missing = [name for name, value in SETTINGS.items() if not value]
        raise RuntimeError("Missing integration settings: " + ", ".join(missing))
    pytest.skip("No EnvVault API configured for integration tests", allow_module_level=True)

API = SETTINGS["API_URL"]


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def test_loads_authorized_values() -> None:
    with EnvVaultClient(API, credential=SETTINGS["CREDENTIAL"]) as client:
        assert client.check_compatibility().protocol_version == 1
        assert [env.slug for env in client.environments()] == ["development"]
        config = client.get_runtime_config(
            project_id=SETTINGS["PROJECT"], environment="development"
        )
        assert len(config) == 1
        assert digest(config["API_TOKEN"]) == SETTINGS["DIGEST"]
        assert SETTINGS["DIGEST"] not in repr(config)
        assert [v.key for v in client.list_variables("development")] == ["API_TOKEN"]


def test_protected_environment_needs_a_direct_grant() -> None:
    with (
        EnvVaultClient(API, credential=SETTINGS["CREDENTIAL"]) as client,
        pytest.raises(NotFoundError),
    ):
        client.get_runtime_config(environment_id=SETTINGS["PROTECTED"])


def test_revoked_expired_and_narrowed_credentials() -> None:
    for name, code in (("REVOKED", "CREDENTIAL_REVOKED"), ("EXPIRED", "CREDENTIAL_EXPIRED")):
        with EnvVaultClient(API, credential=SETTINGS[name]) as client:
            with pytest.raises(AuthenticationError) as caught:
                client.identity()
            assert caught.value.code == code
            assert caught.value.request_id
    with (
        EnvVaultClient(API, credential=SETTINGS["NARROW"]) as client,
        pytest.raises(PermissionDeniedError),
    ):
        client.get_runtime_config(environment="development")


@pytest.mark.anyio
async def test_async_client() -> None:
    async with AsyncEnvVaultClient(API, credential=SETTINGS["CREDENTIAL"]) as client:
        config = await client.get_runtime_config(environment="development")
        assert digest(config["API_TOKEN"]) == SETTINGS["DIGEST"]


def test_runs_a_child_process_with_the_values() -> None:
    check = (
        "import hashlib, os, sys\n"
        "value = os.environ.get('API_TOKEN', '')\n"
        "ok = hashlib.sha256(value.encode()).hexdigest() == sys.argv[1]\n"
        "ok = ok and 'ENVVAULT_SERVICE_CREDENTIAL' not in os.environ\n"
        "sys.exit(0 if ok else 3)\n"
    )
    env = {
        **os.environ,
        "ENVVAULT_API_URL": API,
        "ENVVAULT_SERVICE_CREDENTIAL": SETTINGS["CREDENTIAL"],
    }
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "envvault",
            "run",
            "--env",
            "development",
            "--",
            sys.executable,
            "-c",
            check,
            SETTINGS["DIGEST"],
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert SETTINGS["CREDENTIAL"] not in result.stdout + result.stderr
