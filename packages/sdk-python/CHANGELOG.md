# Changelog

All notable changes to the `envvault` Python package.

## 0.1.0 (unreleased)

- First version: `EnvVaultClient` and `AsyncEnvVaultClient` with machine
  identity authentication (service credential exchange, token renewal,
  revocation on close), runtime configuration, environments and variable
  metadata, workspace and project navigation with access tokens, typed errors,
  timeouts and retries limited to safe requests.
- `python -m envvault run` and `envvault.run()` to start a command with an
  environment's values.
