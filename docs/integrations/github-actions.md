# GitHub Actions

The EnvVault action (`packages/github-action`) runs a command in a GitHub
Actions job with an EnvVault environment's values in that command's
environment. It authenticates with the job's GitHub OIDC token by default, so
no EnvVault credential is stored in GitHub.

Related: [github-oidc.md](github-oidc.md) (trust bindings and verification),
[ci-security.md](ci-security.md), examples in `examples/github-actions/`.

## 1. Setup

1. **Machine identity.** In the dashboard, create one per workflow purpose
   (for example "deploy staging") and grant it the environments it needs with
   the Runtime loader role. Protected environments need a direct grant.
2. **Repository ids.** `gh api repos/OWNER/REPO --jq '.id, .owner.id'`.
3. **Trust binding.** Project → Integrations → GitHub Actions → New trust
   binding: the identity, repository ids, workflow file, branches or tags,
   events, GitHub environment, and the EnvVault environments. See
   [github-oidc.md](github-oidc.md#3-trust-bindings).
4. **Workflow.** Copy **Workflow example** from the binding, or start from
   `examples/github-actions/`.

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@<full-commit-sha>
      - uses: <owner>/<repo>/packages/github-action@<full-commit-sha>
        with:
          api-url: https://api.envvault.example.com
          project-id: <project-id>
          environment: staging
          command: ./scripts/deploy.sh
```

The action is not published to the GitHub Marketplace. Reference it from the
repository it lives in, by path, pinned to a full commit SHA (section 8).

## 2. Inputs and outputs

| Input                        | Default       | Meaning                                                                                                         |
| ---------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `api-url`                    | required      | EnvVault API origin; https only (http only for localhost)                                                       |
| `environment`                | required      | Environment name, slug or id                                                                                    |
| `command`                    | required      | Command to run                                                                                                  |
| `shell`                      | `none`        | `none` splits the command into arguments without a shell; `bash`, `sh`, `pwsh`, `cmd` run it through that shell |
| `auth-mode`                  | `oidc`        | `oidc` or `service-credential`                                                                                  |
| `service-credential`         | none          | Only with `auth-mode: service-credential`, from a secret                                                        |
| `audience`                   | the `api-url` | Must equal the binding's audience                                                                               |
| `project-id`, `workspace-id` | none          | Limit the binding search (recommended)                                                                          |
| `binding-id`                 | none          | Choose a binding when several accept the workflow                                                               |
| `keys`                       | all           | Pass only these variables (comma or newline separated); missing ones fail the step                              |
| `allow-reserved-keys`        | none          | Reserved names EnvVault may set (section 4)                                                                     |
| `override`                   | `true`        | EnvVault values replace variables the step already has                                                          |
| `include-inherited`          | `true`        | Include values inherited from the base environment                                                              |
| `allow-missing`              | `false`       | Run even when required variables have no value                                                                  |
| `working-directory`          | workspace     | Where the command runs                                                                                          |
| `command-timeout-minutes`    | `0`           | Stop the command after this long (0: no limit)                                                                  |

Outputs: `variables-loaded` (a count) and `exit-code`. Values are never
outputs, never written to `GITHUB_ENV`, `GITHUB_OUTPUT` or `GITHUB_STATE`, and
never exported to later steps.

## 3. What the action does

1. Validates inputs. A `service-credential` with `auth-mode: oidc` is an error:
   there is no fallback from a failed OIDC exchange.
2. Checks the API's protocol version.
3. Requests a GitHub OIDC token for the audience (masked), exchanges it once
   (never retried: tokens are single use), and loads the runtime values.
4. Registers a log mask for every value (section 5), then ends the EnvVault
   access token.
5. Builds the command's environment (section 4) and refuses dangerous names
   before anything runs.
6. Starts the command without a shell (unless `shell` is set), with inherited
   output, forwarding `SIGINT` and `SIGTERM`.
7. Passes the exit status through: the command's own; 128 plus the signal
   number when a signal ended it; 127 when it could not start; 124 after
   `command-timeout-minutes`. Errors before the command exit with 1.

Nothing is written to disk. Values are passed only in the child's environment,
never as arguments. The action drops its own references after starting the
command; JavaScript cannot wipe memory, so copies may remain until the runner
process ends.

## 4. Environment policy

Precedence: the step's environment, minus removed variables, then EnvVault
values on top (with `override: false`, the step's own value wins and the
action warns).

Always removed from the command's environment: `INPUT_*` and `STATE_*`
(including the `service-credential` input), `ACTIONS_ID_TOKEN_REQUEST_URL`,
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_RUNTIME_TOKEN`,
`ENVVAULT_SERVICE_CREDENTIAL` and `ENVVAULT_SERVICE_CREDENTIAL_FILE`. The
command therefore cannot mint further OIDC tokens. Run steps that need GitHub
OIDC for other providers separately.

Names EnvVault values may not have (the step fails before running anything,
naming the variable):

| Group          | Names                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Can be allowed                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Invalid        | anything not matching `[A-Za-z_][A-Za-z0-9_]*`                                                                                                                                                                                                                                                                                                                                                                                                               | no                                          |
| Runner control | `GITHUB_*`, `RUNNER_*`, `ACTIONS_*`, `INPUT_*`, `STATE_*`                                                                                                                                                                                                                                                                                                                                                                                                    | no                                          |
| Reserved       | `PATH`, `HOME`, `SHELL`, `IFS`, `ENV`, `BASH_ENV`, `PS4`, `PROMPT_COMMAND`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`, `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CI`, `ENVVAULT_*`, `BASH_FUNC_*` | yes, by listing it in `allow-reserved-keys` |

## 5. Masking

Before the command starts, the action registers with GitHub (`core.setSecret`):
each value, each line of a multiline value (with `\r` handled), and the value
as it appears inside JSON. Empty values and values shorter than 4 characters
are not masked (they would hide ordinary log text); do not store secrets that
short. The OIDC token and a service credential are masked too.

Masking is defence in depth, not protection: GitHub replaces exact matches
only, so a value printed encoded, split, reversed or with changed spacing is
not hidden. The action never prints values, and its own error messages are
redacted against them, but the command can print anything it can read.

## 6. Service credential fallback

```yaml
with:
  auth-mode: service-credential
  service-credential: ${{ secrets.ENVVAULT_SERVICE_CREDENTIAL }}
```

Use it only where GitHub OIDC is not available. A service credential is a
long lived bearer secret stored in GitHub: anyone who can run a workflow with
access to the secret can use it until it expires or is revoked, from anywhere.
Give it the narrowest scopes and a short expiry, keep it in an environment
secret behind required reviewers, and rotate it
([../service-credentials.md](../service-credentials.md)). Never use a person's
login or CLI token in CI.

## 7. Platforms

Linux and macOS runners are tested. On Windows runners use `shell: pwsh` or
`shell: cmd` to run `.cmd` and `.bat` tools (Node does not start them
without a shell); `SIGTERM` ends the command without letting it clean up.

## 8. Versions and pinning

- Reference the action by path in the repository that holds it, pinned to a
  full 40 character commit SHA, for example
  `<owner>/<repo>/packages/github-action@<full-commit-sha>`. Tags and branches
  can be moved; a SHA cannot.
- Pin every other action the same way and let Dependabot or Renovate propose
  updates.
- The action runs from its committed bundle (`dist/index.mjs`, Node 24). CI
  rebuilds it and fails if the committed bundle differs from the source.
- Release process (not automated): bump `version` and `ACTION_VERSION`,
  update `CHANGELOG.md`, `pnpm --filter @envvault/github-action build`, commit
  the bundle, review the diff of `dist/`, tag the commit. Publishing it to its
  own repository or the Marketplace is a separate decision.

## 9. Troubleshooting

| Message                           | Cause                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Could not get a GitHub OIDC token | `permissions: id-token: write` missing, or a fork pull request                                      |
| `OIDC_NO_MATCHING_BINDING`        | See the binding's Recent attempts ([github-oidc.md](github-oidc.md#9-debugging-a-refused-workflow)) |
| `OIDC_BINDING_AMBIGUOUS`          | Set `project-id` or `binding-id`                                                                    |
| `NOT_FOUND` for the environment   | Not one of the binding's environments, or the identity lacks a grant                                |
| `X is reserved`                   | Rename the variable, or list it in `allow-reserved-keys`                                            |
| Required variables have no value  | Set them in EnvVault, or `allow-missing: true`                                                      |
| exit 127                          | The command was not found (on Windows, set `shell`)                                                 |

## 10. Manual validation on GitHub

Automated tests use a local issuer with real signed tokens and never contact
GitHub. Before relying on the integration, validate once against GitHub with
a test repository and synthetic values:

1. Deploy the API with `OIDC_TRUSTED_ISSUERS` at its default and a public
   https address.
2. Create an identity with a grant on a test environment holding a synthetic
   value, and a binding for the test repository's ids, `refs/heads/main` and
   `push`.
3. Push the node tests example to `main`: the job succeeds, the log shows
   `***` where the value would appear, and the binding's Recent attempts lists
   the run id.
4. Push the same workflow on another branch: refused with reason `ref`.
5. Open a pull request (and one from a fork): refused, or no OIDC token for the
   fork.
6. Disable the binding during a long running job: the next API call of that
   job fails.
7. Check the audit log for `machine.authenticated` with the run id and no
   token.
