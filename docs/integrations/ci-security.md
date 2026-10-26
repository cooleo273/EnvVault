# CI/CD security

Threat model for using EnvVault from CI/CD (GitHub Actions in particular), the
controls in place, and what remains the workflow owner's responsibility.

Related: [github-oidc.md](github-oidc.md), [github-actions.md](github-actions.md),
[../security-hardening.md](../security-hardening.md#13-phase-5a-github-actions-oidc).

## 1. What is protected

Configuration values of environments a machine identity is granted, the
machine access tokens that load them, and the trust that lets a workflow
authenticate as an identity.

## 2. Threats and controls

| Threat                                          | Control                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forged or altered identity token                | Signature verified against the allowlisted issuer's JWKS; asymmetric algorithms only; issuer, times and claims checked; nothing read before verification           |
| Token from another service replayed to EnvVault | Exact single audience per binding                                                                                                                                  |
| Same identity token used twice                  | `jti` accepted once while valid (across instances with Redis; refused when the store is down)                                                                      |
| Arbitrary issuer or JWKS                        | Issuers come only from `OIDC_TRUSTED_ISSUERS`; JWKS only from that issuer's discovery document on its own origin                                                   |
| Pull request from a fork reads secrets          | `pull_request_target` never accepted; `pull_request` only when a binding names it, never for protected environments; GitHub gives fork pull requests no OIDC token |
| Unreviewed branch deploys to Production         | Protected environments need bindings pinned to events and branches or a GitHub environment; pair with GitHub environment reviewers and branch rules                |
| Workflow substitution                           | Workflow path is taken from the token's own repository; reusable workflows matched exactly by `job_workflow_ref`                                                   |
| Repository renamed, transferred or name reused  | Trust decided by numeric repository and owner ids                                                                                                                  |
| One project's binding used for another          | Bindings, identities and grants are tied to one project by composite foreign keys; access tokens are limited to the binding's environments                         |
| A binding grants more than its creator holds    | Creating, changing and enabling need `service_identity:manage`, a recent password confirmation and the creator's own permissions on every bound environment        |
| Revoked access keeps working                    | Disabling or deleting a binding, disabling the identity or removing a grant stops the next request, including issued tokens                                        |
| Values leak into logs, outputs or files         | No values in outputs, `GITHUB_ENV`, artifacts, caches or files; masks registered before the command starts; errors redacted                                        |
| Values reach runner control                     | Runner variables, credentials and inputs removed from the command's environment; dangerous names refused                                                           |
| Long lived credential theft                     | OIDC needs no stored credential; the service credential fallback is explicit and documented as long lived                                                          |
| Flooding                                        | Limits per address and per repository; refusals audited once per minute per binding and reason                                                                     |
| Identity provider outage                        | Fail closed (503)                                                                                                                                                  |

## 3. Responsibilities of the workflow owner

EnvVault cannot make untrusted code safe. Anything running in the job, and
especially the command the action starts, can read the values it receives
and send them anywhere.

- Run only reviewed code with access to secrets; never run pull request code
  from forks in a job that loads values.
- Use GitHub deployment environments with required reviewers for protected
  EnvVault environments, and deployment branch or tag rules.
- Protect the branches and tags your bindings allow (rulesets, required
  reviews, signed tags where possible).
- Pin every action to a full commit SHA, including this one.
- Give `permissions:` the minimum: `contents: read` and `id-token: write`.
- Prefer GitHub hosted runners. Self hosted runners keep state between jobs
  unless they are ephemeral; never use persistent self hosted runners for
  public repositories.
- Use one machine identity per purpose and the narrowest grants and scopes.

## 4. Known limitations

1. Environment variables are readable by every process the command starts,
   by code running as the same OS user and by administrators of the runner.
   They are a delivery mechanism, not an isolation boundary.
2. Masking matches exact strings only and does not cover values shorter than
   4 characters.
3. Access tokens are bearer tokens: one copied out of a running job works for
   up to 15 minutes unless the binding or identity is disabled.
4. Replay protection is per instance without Redis.
5. A removed signing key stays trusted for up to 10 minutes (JWKS cache), and a
   discovered key set for up to 24 hours while discovery fails.
6. GitHub provides no stable id for a reusable workflow's repository; bind
   reusable workflows by `job_workflow_ref` pinned to a commit SHA.
7. Token exchanges that match no binding are logged by the API, not recorded
   in a workspace's audit log.
8. Not validated against live GitHub in automated tests (a local issuer with
   real signed tokens is used); see the manual validation steps in
   [github-actions.md](github-actions.md#10-manual-validation-on-github).
9. Docker isolated runner tests were not run (no Docker daemon was available).
