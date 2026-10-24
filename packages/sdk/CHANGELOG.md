# Changelog

## 0.1.0 (unreleased)

- `EnvVaultMachineClient` and `@envvault/sdk/node` (`machineClientFromEnvironment`).
- Cancellation with `withSignal` and the `signal` option; `EnvVaultAbortError`.
- Rate limits: `retryAfterSeconds`, `isRateLimited`, opt in `rateLimitRetries` for safe requests.
- Request ids from the `X-Request-Id` header on errors.
- Pagination: `paginate`, `paginateCursor`, `paginateBefore`, `collect` and `iterate*` methods.
- Earlier work (Phases 1 to 4B): typed methods for every documented route.
