from __future__ import annotations

import asyncio

import pytest

from envvault import AsyncEnvVaultClient, NotFoundError

from .fake_api import CREDENTIAL, SYNTHETIC, FakeApi

API = "http://localhost:4000"


@pytest.mark.anyio
async def test_async_client_shares_one_exchange() -> None:
    api = FakeApi()
    async with AsyncEnvVaultClient(
        API, credential=CREDENTIAL, transport=api.async_transport()
    ) as c:
        results = await asyncio.gather(*(c.environments() for _ in range(5)))
        assert all(r[0].slug == "staging" for r in results)
        config = await c.get_runtime_config(environment="staging")
        assert config["API_TOKEN"] == SYNTHETIC
        assert SYNTHETIC not in repr(config)
        with pytest.raises(NotFoundError):
            await c.get_runtime_config(environment="production")
    assert api.exchanges == 1
    assert api.revoked == 1


@pytest.mark.anyio
async def test_async_client_exchanges_again_after_rejection() -> None:
    api = FakeApi(reject_first_use=True)
    async with AsyncEnvVaultClient(
        API, credential=CREDENTIAL, transport=api.async_transport()
    ) as c:
        variables = await c.list_variables("staging")
    assert [v.key for v in variables] == ["API_TOKEN"]
    assert api.exchanges == 2
