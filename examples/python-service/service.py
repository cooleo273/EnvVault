"""
A small Python web service that loads its configuration from EnvVault once,
at startup, and keeps it in memory (standard library only besides the SDK).

    export ENVVAULT_API_URL=https://api.envvault.example.com
    export ENVVAULT_SERVICE_CREDENTIAL=...   # from your secret store
    export ENVVAULT_ENVIRONMENT=staging
    python service.py

``GET /health`` reports how many values are configured, never the values.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from envvault import EnvVaultClient


def load_settings(environment: str) -> Mapping[str, str]:
    """Loads the values once; the access token is ended right after."""
    with EnvVaultClient.from_environment() as client:
        return client.get_runtime_config(environment=environment).as_dict()


def make_handler(settings: Mapping[str, str]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                self.send_error(404)
                return
            body = json.dumps({"status": "ok", "configured": len(settings)}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            # Request lines can carry query strings; keep the default access log off.
            return

    return Handler


def serve(port: int) -> ThreadingHTTPServer:
    settings = load_settings(os.environ.get("ENVVAULT_ENVIRONMENT", "development"))
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(settings))


if __name__ == "__main__":
    server = serve(int(os.environ.get("PORT", "8000")))
    print(f"Listening on port {server.server_address[1]}", flush=True)
    server.serve_forever()
