# API versioning and deprecation

How the EnvVault API changes without breaking the clients that use it.

## 1. Versions

| Version          | Where                                                                                                             | Changes when                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| URL version      | `/api/v1`                                                                                                         | A breaking change that cannot be made alongside the old behaviour. A new major version runs next to the old one during the sunset period. |
| Protocol version | `protocolVersion` in `GET /api/v1/meta` and `x-envvault-protocol-version` in the OpenAPI document (currently `1`) | The contract the SDKs and the CLI depend on changes incompatibly (authentication flow, error envelope, pagination shapes).                |
| Server version   | `version` in `GET /api/v1/meta` and `info.version` in the OpenAPI document                                        | Every release. Informational only.                                                                                                        |
| Features         | `features` in `GET /api/v1/meta`                                                                                  | Optional capabilities are added (for example `runtime-configuration`). Clients test for a feature instead of comparing server versions.   |

`checkCompatibility()` (TypeScript) and `check_compatibility()` (Python)
refuse a server whose protocol version differs from the one the SDK was
built for, before any credential is sent. The CLI does the same.

## 2. Compatible changes (no new version)

These can happen in any release, so clients must tolerate them:

- New routes, new optional query parameters and new optional body fields.
- New fields in responses. Both SDKs ignore fields they do not know.
- New error codes on existing statuses. Branch on known codes and treat
  unknown ones by status.
- New values in enums that are documented as open (statuses, audit actions,
  features).
- Higher limits, and lower rate limits announced in the changelog.
- New response headers.

## 3. Breaking changes

These need a new protocol version or a new URL version, and a deprecation
period first:

- Removing or renaming a route, field, parameter or error code.
- Making an optional input required, or narrowing accepted values.
- Changing a field's type or meaning, or a status code for an existing case.
- Changing authentication, pagination or the error envelope.

Security fixes are the exception: when keeping old behaviour would expose
data, the API changes immediately and the changelog says why.

## 4. Deprecation policy

1. The route or field is marked deprecated in code with
   `@Deprecated({ since, sunset, replacement })` from
   `apps/api/src/common/deprecation.ts`.
2. Its OpenAPI operation gets `deprecated: true` and a description naming
   the date and the replacement. The reference page at `/developers/api`
   shows it.
3. Every response from it carries:
   - `Deprecation: @<unix seconds>` (RFC 9745)
   - `Sunset: <HTTP date>` once a date is set (RFC 8594)
   - `Link` with two targets: the route's entry in the web app's API
     reference (`<APP_BASE_URL>/developers/api#<operationId>`,
     `rel="deprecation"`), which shows the dates and the replacement, and the
     OpenAPI document (`/api/v1/openapi.json`, `rel="service-desc"`). The web
     origin is `APP_BASE_URL`, or the first `CORS_ORIGINS` entry.
4. The changelog and release notes list it.
5. It keeps working for **at least six months** after `since`, and until the
   SDKs and CLI released in that period no longer use it.
6. After the sunset date it answers `404` (removed route) or ignores the
   field, never something unexpected.

No route is deprecated today.

## 5. Client guidance

- Pin an SDK version and upgrade it deliberately; read its changelog.
- Call `checkCompatibility` at startup in long running services.
- Watch for `Deprecation` headers in your logs or monitoring (log the header
  and route, never the request body or tokens).
- Do not depend on error messages, field order, or undocumented fields.

## 6. SDK versions

Both SDKs use semantic versioning independent of the server:

- Major: a change to the SDK's own public interface, or support for a new
  protocol version that drops the old one.
- Minor: new methods, options or models.
- Patch: fixes.

Each SDK states the protocol version it speaks (`API_PROTOCOL_VERSION` in
`@envvault/shared`, `envvault.PROTOCOL_VERSION` in Python).
