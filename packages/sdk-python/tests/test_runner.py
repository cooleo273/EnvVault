from __future__ import annotations

import hashlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from envvault import EnvVaultClient, MissingRequiredError, child_environment, run
from envvault.__main__ import main

from .fake_api import CREDENTIAL, SYNTHETIC, FakeApi

API = "http://localhost:4000"
DIGEST = hashlib.sha256(SYNTHETIC.encode()).hexdigest()
CHECK = (
    "import hashlib, os, sys\n"
    "digest = hashlib.sha256(os.environ.get('API_TOKEN', '').encode()).hexdigest()\n"
    "ok = digest == sys.argv[1] and 'ENVVAULT_SERVICE_CREDENTIAL' not in os.environ\n"
    "sys.exit(0 if ok else 3)\n"
)


def fake_client(api: FakeApi) -> EnvVaultClient:
    return EnvVaultClient(API, credential=CREDENTIAL, transport=api.transport())


def test_child_environment_strips_the_credential() -> None:
    base = {"PATH": "/bin", "ENVVAULT_SERVICE_CREDENTIAL": CREDENTIAL, "PORT": "1"}
    env, kept = child_environment(base, {"PORT": "2", "API_TOKEN": SYNTHETIC})
    assert env == {"PATH": "/bin", "PORT": "2", "API_TOKEN": SYNTHETIC}
    assert kept == 0
    env, kept = child_environment(base, {"PORT": "2"}, override=False)
    assert env["PORT"] == "1"
    assert kept == 1


def test_runs_the_child_with_values_only_in_its_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVVAULT_SERVICE_CREDENTIAL", CREDENTIAL)
    api = FakeApi()
    code = run(
        [sys.executable, "-c", CHECK, DIGEST], environment="staging", client=fake_client(api)
    )
    assert code == 0
    assert SYNTHETIC not in " ".join(str(r.url) for r in api.requests)


def test_forwards_exit_codes_and_reports_missing_commands() -> None:
    assert (
        run(
            [sys.executable, "-c", "raise SystemExit(7)"],
            environment="staging",
            client=fake_client(FakeApi()),
        )
        == 7
    )
    assert (
        run(["envvault-no-such-command"], environment="staging", client=fake_client(FakeApi()))
        == 127
    )


def test_refuses_to_run_without_required_values() -> None:
    api = FakeApi(missing_required=["DATABASE_URL"])
    with pytest.raises(MissingRequiredError) as caught:
        run([sys.executable, "-c", "0"], environment="staging", client=fake_client(api))
    assert caught.value.keys == ("DATABASE_URL",)
    assert (
        run(
            [sys.executable, "-c", "0"],
            environment="staging",
            client=fake_client(FakeApi(missing_required=["X"])),
            allow_missing=True,
        )
        == 0
    )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_forwards_termination_signals(tmp_path: Path) -> None:
    ready = tmp_path / "ready"
    script = (
        "import pathlib, signal, sys, time\n"
        "pathlib.Path(sys.argv[1]).write_text('1')\n"
        "time.sleep(30)\n"
    )
    runner = (
        "import sys\n"
        "from envvault import EnvVaultClient, run\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "from fake_api import CREDENTIAL, FakeApi\n"
        "client = EnvVaultClient(\n"
        "    'http://localhost:4000', credential=CREDENTIAL, transport=FakeApi().transport()\n"
        ")\n"
        "command = [sys.executable, '-c', sys.argv[2], sys.argv[3]]\n"
        "sys.exit(run(command, environment='staging', client=client))\n"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", runner, str(Path(__file__).parent), script, str(ready)],
        stdin=subprocess.DEVNULL,
    )
    deadline = time.time() + 20
    while not ready.exists():
        assert time.time() < deadline
        time.sleep(0.05)
    process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=20) == 128 + signal.SIGTERM


def test_command_line_exit_codes(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("ENVVAULT_API_URL", raising=False)
    monkeypatch.delenv("ENVVAULT_SERVICE_CREDENTIAL", raising=False)
    assert main(["run", "--env", "staging", "--", sys.executable, "-c", "0"]) == 3
    assert "ENVVAULT_API_URL" in capsys.readouterr().err
    assert main(["run", "--env", "staging"]) == 2
    monkeypatch.setenv("ENVVAULT_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("ENVVAULT_SERVICE_CREDENTIAL", CREDENTIAL)
    assert main(["whoami"]) == 7
    output = capsys.readouterr()
    assert CREDENTIAL not in output.out + output.err
    assert os.environ["ENVVAULT_SERVICE_CREDENTIAL"] == CREDENTIAL
