# EnvVault GitHub Action

Runs a command in a GitHub Actions job with an EnvVault environment's values
in that command's environment. Authenticates with the job's GitHub OIDC token
through an EnvVault trust binding, so no EnvVault credential is stored in
GitHub.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@<full-commit-sha>
  - uses: <owner>/<repo>/packages/github-action@<full-commit-sha>
    with:
      api-url: https://api.envvault.example.com
      project-id: <project-id>
      environment: staging
      command: npm run build
```

- Values are masked in the log before the command starts and passed only to
  the command: never to outputs, `GITHUB_ENV`, files, caches or artifacts.
- The command starts without a shell unless `shell` is set; its exit status is
  the step's.
- Runner control variables and credentials are removed from the command's
  environment; dangerous variable names are refused.
- `auth-mode: service-credential` is an explicit fallback for runners without
  OIDC; it uses a long lived credential.

Not published to the GitHub Marketplace. Pin it to a full commit SHA.

Full guide: `docs/integrations/github-actions.md`. Trust model:
`docs/integrations/github-oidc.md`. Examples: `examples/github-actions/`.

## Development

```bash
pnpm --filter @envvault/github-action test
pnpm --filter @envvault/github-action build   # writes dist/index.mjs; commit it
```

The bundle is checked in because GitHub runs it directly; CI fails if it
differs from a fresh build.
