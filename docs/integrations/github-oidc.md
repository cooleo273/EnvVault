# GitHub Actions OIDC federation

How a GitHub Actions job proves who it is to EnvVault without a stored
credential, and what EnvVault checks before it hands out a machine access
token.

Related: [github-actions.md](github-actions.md) (the action),
[ci-security.md](ci-security.md) (threat model),
[../machine-identities.md](../machine-identities.md),
[../api-authentication.md](../api-authentication.md).

## 1. Flow

```
GitHub job ──(1) request OIDC token for audience A──▶ GitHub (token.actions.githubusercontent.com)
GitHub job ──(2) POST /api/v1/machine/oidc/token, Authorization: Bearer <JWT>──▶ EnvVault API
EnvVault   ──(3) verify signature, issuer, audience, times, claims
           ──(4) find the one trust binding whose conditions the claims meet
           ──(5) check binding, credential and machine identity are usable
           ──(6) check requested scopes and environments, protected environment rules
           ──(7) issue an evv_mt_ access token (15 minutes at most), audit
GitHub job ──(8) load runtime values with the access token; grants checked per request
```

There is no refresh token. A job that needs another access token asks GitHub
for a new identity token.

## 2. Token verification

Implemented in `apps/api/src/machine/oidc-verifier.ts` with `jose`.

| Check     | Rule                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape     | Three base64url parts, at most 8192 characters                                                                                                                                               |
| Issuer    | `iss` must equal an entry of `OIDC_TRUSTED_ISSUERS` exactly (default `https://token.actions.githubusercontent.com`). It is only used to pick that entry; no URL is built from token content. |
| Keys      | Discovery document `<issuer>/.well-known/openid-configuration` (its `issuer` must match, its `jwks_uri` must be on the issuer's origin), then that JWKS                                      |
| Signature | RS256 or ES256 only; `none` and HMAC are refused; the key must be in the issuer's JWKS                                                                                                       |
| Times     | `exp`, `iat` and `nbf` required; 30 seconds of clock tolerance; `exp - iat` at most one hour; tokens issued in the future are refused                                                        |
| Claims    | `sub`, `aud`, `jti`, `repository_id`, `repository_owner_id`, `workflow_ref`, `job_workflow_ref`, `ref`, `event_name` required and well formed                                                |
| Audience  | Exactly one `aud` value, equal to the binding's audience                                                                                                                                     |

Network use is bounded: discovery and JWKS requests time out after 3
seconds, discovery documents larger than 64 KiB are refused, redirects are
not followed, JWKS are cached for 10 minutes and refetched for an unknown key
id at most every `OIDC_JWKS_COOLDOWN_SECONDS` (default 30). If keys cannot be
fetched the exchange answers `503 OIDC_PROVIDER_UNAVAILABLE`: nothing is
decided without them. A previously discovered key set stays in use for up to
24 hours while rediscovery fails.

Key rotation: GitHub publishes new keys before using them, and an unknown key
id triggers a JWKS refetch (subject to the cooldown), so rotation needs no
restart. A key removed from the JWKS stays trusted until the cached set
expires (at most 10 minutes).

## 3. Trust bindings

A trust binding ties GitHub workflow identities to one machine identity of
one project. It is stored as an `OIDC_FEDERATION` service credential (issuer,
audience, scopes, expiry, revocation) plus an `oidc_trust_policies` row with
the claim conditions. Its id is the credential id, so access tokens, revocation
and audit work exactly as for Phase 4B credentials.

| Condition                | Claim                                                          | Matching                             | Empty means                    |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------ | ------------------------------ |
| Repository id (required) | `repository_id`                                                | exact                                | n/a                            |
| Owner id (required)      | `repository_owner_id`                                          | exact                                | n/a                            |
| Repository name          | none                                                           | display only, never decides          | n/a                            |
| Workflow file            | path part of `workflow_ref`, inside the token's own repository | exact                                | any workflow                   |
| Reusable workflow        | `job_workflow_ref`                                             | exact (pin to a commit SHA)          | any                            |
| Branches and tags        | `ref`                                                          | exact, or prefix with a trailing `*` | any ref                        |
| GitHub environments      | `environment`                                                  | case insensitive                     | any (or none)                  |
| Events                   | `event_name`                                                   | exact                                | any event except pull requests |
| Subject                  | `sub`                                                          | exact                                | any                            |
| EnvVault environments    | none                                                           | the access token is limited to these | required, 1 to 50              |

Rules that hold whatever a binding says:

- `pull_request_target` is never accepted (it runs code a fork controls with
  the base repository's permissions). The database refuses it in a binding.
- `pull_request` is accepted only when the binding lists it, and never for a
  protected environment.
- Repository and owner ids decide. Names can be renamed, transferred or
  registered again by someone else, so a name never grants anything.
- A `workflow_ref` from another repository than the token's own never matches
  a workflow path, so a workflow cannot borrow another repository's name.
- Issuer, audience, repository id, owner id and scopes of a binding cannot be
  changed; create a new binding instead.

### Protected environments

A binding that reaches a protected EnvVault environment must:

1. list its events, none of them pull request events;
2. restrict branches or tags, or require a GitHub deployment environment;
3. not use `refs/pull/` refs, and pair any wildcard ref with a GitHub
   deployment environment.

This is checked when the binding is created, changed or enabled, and again at
every exchange (protection may have been switched on later:
`403 OIDC_PROTECTED_POLICY_REQUIRED`). The machine identity still needs a
direct grant on the protected environment, which only someone holding the
permission there can give.

Use GitHub's own controls as well: deployment environments with required
reviewers and deployment branch or tag rules, branch protection or rulesets,
and tag protection.

### Eligibility, not access

A binding only lets a workflow authenticate as the identity. On every request
the identity's grants decide what it can read: removing a grant, disabling the
identity, disabling or deleting the binding stops the next request, including
tokens already issued.

## 4. Subject claims and customisation

GitHub's default `sub` looks like `repo:octo-org/app:ref:refs/heads/main`,
`repo:octo-org/app:environment:production` or
`repo:octo-org/app:pull_request`. Organisations and repositories can change the
subject template (for example to include `repository_id` or `job_workflow_ref`)
through GitHub's OIDC customisation API.

EnvVault does not parse `sub`: every condition reads its own claim, so a
customised template changes nothing. The optional subject condition compares
the whole `sub` exactly, for teams that standardise on a template. Do not rely
on `sub` alone: it contains the repository name.

## 5. Exchange API

`POST /api/v1/machine/oidc/token`, public to the authentication guard, with
the GitHub token in `Authorization: Bearer`. Body (all optional):

| Field                      | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `projectId`, `workspaceId` | Limit the binding search (recommended)                 |
| `bindingId`                | Choose when several bindings accept the workflow       |
| `scopes`                   | Narrow the token to some of the binding's scopes       |
| `environmentIds`           | Narrow the token to some of the binding's environments |

Response: the same `MachineToken` as `POST /machine/token`, with the binding
as `credential`. Errors: `OIDC_TOKEN_INVALID`, `OIDC_TOKEN_EXPIRED`,
`OIDC_ISSUER_NOT_TRUSTED`, `OIDC_TOKEN_REPLAYED` (401);
`OIDC_NO_MATCHING_BINDING` (401, deliberately without details);
`OIDC_BINDING_AMBIGUOUS` (409); `SCOPE_NOT_GRANTED`,
`OIDC_PROTECTED_POLICY_REQUIRED` (403); `OIDC_PROVIDER_UNAVAILABLE`,
`RATE_LIMIT_UNAVAILABLE` (503); `TOO_MANY_REQUESTS` (429).

Bindings are managed under
`/api/v1/workspaces/{workspaceId}/projects/{projectId}/oidc-trust-bindings`
(list, create, get, change, disable, enable, delete, recent attempts). Reading
needs `service_identity:read`; changing needs `service_identity:manage`, a
recent password confirmation (except disabling), and the caller's own
permissions on each bound environment (`GRANT_EXCEEDS_AUTHORITY`). A binding
can only name environments the identity is granted.

## 6. Replay and rate limits

Each identity token is accepted once while it is valid: its `jti` is recorded
in the shared rate limit store until shortly after it expires, and a second
exchange answers `OIDC_TOKEN_REPLAYED`. Limits of this guarantee:

- with `RATE_LIMIT_STORE=redis` it holds across API instances;
- with the memory store it holds per instance only (several instances could
  each accept the same token once);
- when the shared store is unreachable, exchanges are refused (503), never
  accepted without the check.

No database table of GitHub tokens exists. Exchanges are also limited per
client address (`RATE_LIMIT_SENSITIVE_MAX`) and per issuer and repository
(`OIDC_TOKEN_RATE_LIMIT`, default 120 per minute; matrix builds exchange once
per job).

## 7. Audit

| Event                                                                         | When                                           | Metadata (never tokens or values)                                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oidc_trust_binding.created`, `.updated`, `.disabled`, `.enabled`, `.deleted` | Management                                     | binding id, name, issuer, audience, repository ids and name, conditions, environments, scopes                                                                         |
| `machine.authenticated`                                                       | Successful exchange                            | binding id, `method: github_oidc`, repository and id, workflow and job workflow refs, ref, event, GitHub environment, run id and attempt, SHA, scopes, token lifetime |
| `machine.authentication_failed`                                               | A binding for the repository refused the token | the same, plus `reason` (`audience`, `ref`, `workflow`, `pull_request`, `binding_disabled`...), once per minute per binding and reason                                |
| `machine.token_rejected`                                                      | A token of a disabled binding was used         | binding id, reason                                                                                                                                                    |
| `secret.runtime_loaded`, `machine.access_denied`                              | Values loaded or refused with the token        | as in Phase 4B, with the binding id as `credentialId`                                                                                                                 |

Tokens that fail verification, or match no binding at all, have no workspace
to record them in; the API logs the reason without the token. Events are part
of the Phase 3E audit chain. The dashboard shows the last 25 attempts per
binding.

## 8. Configuration

| Variable                     | Default                                       | Meaning                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_TRUSTED_ISSUERS`       | `https://token.actions.githubusercontent.com` | Comma separated exact issuers; empty turns OIDC exchange off. GitHub Enterprise Cloud issuers with a custom slug must be listed. https only; plain http is accepted only for a loopback issuer with `NODE_ENV=test`. |
| `OIDC_TOKEN_RATE_LIMIT`      | 120                                           | Exchanges per issuer and repository per minute                                                                                                                                                                       |
| `OIDC_JWKS_COOLDOWN_SECONDS` | 30                                            | Minimum time between JWKS refetches for unknown key ids                                                                                                                                                              |

## 9. Debugging a refused workflow

1. Open the binding's **Recent attempts** in the dashboard: refusals list the
   reason and the workflow's ref, event, environment and run id.
2. No attempt listed: the repository id or owner id does not match any binding
   (or the token failed verification). Compare with
   `gh api repos/OWNER/REPO --jq '.id, .owner.id'`.
3. `audience`: the action's `audience` input must equal the binding's audience
   (default: the `api-url`).
4. `ref`, `event`, `workflow`, `environment`: compare with the run's trigger;
   remember tags are `refs/tags/...` and environments come from the job's
   `environment:` key.
5. `OIDC_BINDING_AMBIGUOUS`: pass `project-id` or `binding-id` to the action.
6. Could not get an OIDC token: the job needs `permissions: id-token: write`.
   Workflows triggered from forks do not receive one.

## 10. Local testing

`apps/api/test/support/oidc-issuer.ts` is a test only issuer: RS256 keys,
discovery document, JWKS, signed tokens with GitHub's claims, tampering, key
rotation, outage simulation and the runner's token endpoint. The API trusts it
only because the tests set `OIDC_TRUSTED_ISSUERS` to its loopback address with
`NODE_ENV=test`; production configuration refuses http issuers. Tests:
`apps/api/test/oidc.int-spec.ts` and `apps/api/test/github-action.int-spec.ts`
(local PostgreSQL, synthetic values, no GitHub connection).
