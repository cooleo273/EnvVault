# EnvVault examples

Each example loads configuration through a machine identity and keeps values
in memory. All use placeholders: set `ENVVAULT_API_URL` and
`ENVVAULT_SERVICE_CREDENTIAL` from your secret store, never in code.

| Example          | Shows                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| `node-backend`   | Node.js server loading values at startup (`@envvault/sdk/node`)                        |
| `nextjs-server`  | Next.js server only module and route handler; nothing reaches browser bundles          |
| `python-script`  | One off Python script (`envvault` package)                                             |
| `python-service` | Python web service loading values at startup                                           |
| `node-worker`    | Long running Node.js worker: fail closed, refresh with jitter, stop on revocation      |
| `python-worker`  | The same worker in Python                                                              |
| `container`      | Dockerfile without values or credentials, and a Compose file using Compose secrets     |
| `github-actions` | GitHub Actions workflows using the EnvVault action                                     |
| `ci-generic`     | CI step with `envvault auth service` and `envvault run`, and a GitHub Actions workflow |

`apps/api/test/examples.int-spec.ts` runs the Node, Python and CI examples
against a local API with synthetic values; the Next.js example is type
checked. See docs/developer-guide.md.
