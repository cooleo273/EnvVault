# Changelog

## 0.2.0 (unreleased)

- GitHub Actions OIDC: `EnvVaultMachineClient` accepts `oidcToken` (and `oidc` binding hints)
  instead of `credential`; `exchangeOidcToken` on `EnvVaultClient`.
- Trust binding management methods (`listOidcTrustBindings` and the rest).
- Deployment integrations: Vercel connections, mappings, `previewSync`, `runSync`, `syncJobs`.

## 0.1.0 (unreleased)

- `EnvVaultMachineClient` and `@envvault/sdk/node` (`machineClientFromEnvironment`).
- Cancellation with `withSignal` and the `signal` option; `EnvVaultAbortError`.
- Rate limits: `retryAfterSeconds`, `isRateLimited`, opt in `rateLimitRetries` for safe requests.
- Request ids from the `X-Request-Id` header on errors.
- Pagination: `paginate`, `paginateCursor`, `paginateBefore`, `collect` and `iterate*` methods.
- Earlier work (Phases 1 to 4B): typed methods for every documented route.
