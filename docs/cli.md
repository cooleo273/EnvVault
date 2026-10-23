# EnvVault CLI

`envvault` loads a project's configuration into your development process
without copying secrets into files, chat or shell history. It is a thin
client of the EnvVault API: every permission check, decryption, rate limit
and audit event happens on the server, exactly as for the web app.

Sign in is covered in [cli-authentication.md](cli-authentication.md).

## 1. Install and build

The CLI lives in `apps/cli` (package `@envvault/cli`) and needs Node.js 22 or
later.

```bash
pnpm --filter @envvault/cli build
node apps/cli/dist/bin.js --help
# or link it as a global command while developing:
pnpm --filter @envvault/cli exec npm link
```

It is not published to a package registry yet.

## 2. Quick start

```bash
envvault login                       # approve in the browser
cd my-app
envvault init                        # pick workspace, project, default environment
envvault run -- npm run dev          # start the app with the values in its environment
```

`envvault init` writes `.envvault.json` and nothing else. It never creates a
`.env` file.

## 3. Commands

| Command                                                                   | What it does                                                       | Needs                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `login [--no-browser]`                                                    | Browser approved sign in                                           | an EnvVault account               |
| `logout`                                                                  | Ends the CLI session on the server, then forgets it locally        |                                   |
| `whoami`                                                                  | Shows the signed in account                                        |                                   |
| `auth status`                                                             | Session, credential store, expiry                                  |                                   |
| `init [--workspace] [--project] [--env] [--force]`                        | Links the directory                                                | project access                    |
| `workspace list`, `workspace use <ref>`                                   | Lists workspaces; remembers one for use outside linked directories | membership                        |
| `project list [--workspace] [--all]`, `project use <ref>`, `project info` | Lists, links or shows projects                                     | project access                    |
| `env list`, `env use <ref>`, `env info [ref]`                             | Lists environments, sets the default, shows what you may do        | `environment:read`                |
| `run [options] -- <command> [args]`                                       | Runs a command with the values in its environment                  | `secret:runtime`                  |
| `pull [--env] [--output] [--force] [--no-gitignore]`                      | Writes a plaintext `.env` file                                     | `secret:export` and `secret:read` |
| `doctor`                                                                  | Checks configuration, API, sign in, access and required variables  |                                   |
| `health`                                                                  | Checks that the API answers                                        |                                   |

`<ref>` is a name, slug or id. Every command accepts `--json` (machine
readable output on stdout; progress and warnings go to stderr) and
`--api-url <url>`, before or after the subcommand.

### `envvault run`

```bash
envvault run -- npm run dev
envvault run --env staging -- node server.js
envvault run --no-override -- pnpm test     # variables already set in your shell win
envvault run --allow-missing -- npm start   # start even if required variables are empty
```

- The command after `--` starts directly, without a shell. Use
  `envvault run -- sh -c '...'` only if you need shell features.
- Values travel from the API to the child's environment block. They are never
  written to disk, printed, logged or put on a command line. The CLI prints
  only how many variables it loaded.
- Inherited values are included when you may load the base environment;
  otherwise they are left out and the CLI says how many.
- Required variables without a value stop the command (exit code 8) unless
  you pass `--allow-missing`.
- `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGQUIT` are passed on to the child; the
  CLI exits with the child's exit code, or 128 plus the signal number.

What `run` cannot protect against:

- The child can read its environment, and so can its own children.
- Anyone allowed to inspect the process can read it too: the same operating
  system user (`/proc/<pid>/environ` on Linux, `ps eww` on macOS, process
  tools on Windows) and administrators.
- Node.js cannot wipe strings from memory. The CLI drops its references as soon
  as the child has its copy; the garbage collector reclaims them later.
- Values sent to the API leave EnvVault's control once loaded: crash reports,
  debug logs and framework error pages in your app can still print them.

### `envvault pull`

```bash
envvault pull                                   # writes .env.local from the default environment
envvault pull --env development --output .env
```

Use it only for tools that insist on a file. It:

- needs `secret:export` and `secret:read` on the environment. `secret:runtime`
  is not enough, and `secret:export` alone does not let you use `run`;
- asks before replacing an existing file (`--force` skips the question; in a
  script without `--force` it refuses);
- writes atomically with mode `0600` (on Windows the file inherits the folder's
  permissions);
- refuses paths outside the linked project, inside `public`, `static`, `www`,
  `dist`, `build`, `out`, `.next` or `node_modules`, and directories every
  user can write to;
- adds the file to `.gitignore` when Git would otherwise pick it up
  (`--no-gitignore` turns this off);
- goes through the API's export limits and audit (`secret.exported`).

### `envvault doctor`

Checks, in order: CLI and Node.js version, `.envvault.json`, API reachability
and protocol version, sign in, project access, default environment,
`secret:runtime`, required variables and readiness. Each line is `ok`, `warn`,
`fail` or `skip` with a hint. It never prints a value or a token. Exit code 1
when any check fails.

## 4. Project configuration (`.envvault.json`)

```json
{
  "version": 1,
  "workspaceId": "…",
  "projectId": "…",
  "environmentId": "…"
}
```

Ids and, when not the default, `apiUrl`. No values, tokens or credentials, so
it is safe to commit; unknown fields are rejected. The CLI looks for it in the
current directory and its parents.

## 5. Settings and precedence

The API address comes from, in order: `--api-url`, `ENVVAULT_API_URL`, the
project's `apiUrl`, the user configuration, then `http://localhost:4000`.
Plain `http` is accepted only for `localhost`, `127.0.0.1` and `::1`.

| Variable                    | Purpose                               |
| --------------------------- | ------------------------------------- |
| `ENVVAULT_API_URL`          | API origin                            |
| `ENVVAULT_CREDENTIAL_STORE` | `keychain` (default) or `file`        |
| `ENVVAULT_CONFIG_DIR`       | Overrides the configuration directory |
| `NO_COLOR`                  | Turns colors off                      |

Configuration directory: `%APPDATA%\envvault` on Windows,
`~/Library/Application Support/envvault` on macOS,
`$XDG_CONFIG_HOME/envvault` (or `~/.config/envvault`) on Linux. It holds
`config.json` (remembered workspace and API address) and, only with the file
store, `credentials.json`.

## 6. Exit codes

| Code | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 0    | Success                                                                                                |
| 1    | Failure (including a failed `doctor` check)                                                            |
| 2    | Usage: unknown command or option, missing argument, refused file path, existing file without `--force` |
| 3    | Configuration: invalid `.envvault.json`, unlinked directory, credential store unavailable              |
| 4    | Not signed in, session expired or ended                                                                |
| 5    | Forbidden, including protected environments that need a password confirmation                          |
| 6    | Not found, or no access (the two are not told apart)                                                   |
| 7    | API unreachable, failing or incompatible                                                               |
| 8    | Required variables have no value (`run`)                                                               |
| 9    | Rate limited                                                                                           |

`envvault run` exits with the child's code; 127 when the command does not
exist.

## 7. Protected environments

Protected environments need a direct grant with `secret:runtime` (project
roles do not reach them) and a recent password confirmation. The CLI never
asks for a password: it prints a link to `/cli/confirm` in the web app. After
confirming, run the command again within the confirmation window (10 minutes
by default, `AUTH_STEP_UP_TTL_SECONDS`).

## 8. Platforms

|                         | macOS    | Linux                                                             | Windows                                                                             |
| ----------------------- | -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Credential store        | Keychain | Secret Service (GNOME Keyring, KWallet); `file` on headless hosts | Credential Manager                                                                  |
| `run` without a shell   | yes      | yes                                                               | yes (`.cmd` and `.bat` shims are resolved by `cross-spawn`)                         |
| Signal forwarding       | yes      | yes                                                               | Ctrl+C reaches the child through the console; other signals are emulated by Node.js |
| `pull` file mode `0600` | yes      | yes                                                               | inherits the folder's ACL                                                           |
| Browser opening         | `open`   | `xdg-open`                                                        | `rundll32 url.dll`                                                                  |

Automated tests run on macOS and Linux; Windows behaviour is covered by path
and configuration unit tests, not by a Windows CI job yet.

## 9. Troubleshooting

| Symptom                                                       | Fix                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `The operating system credential store is not available.`     | On a host without one, `export ENVVAULT_CREDENTIAL_STORE=file`        |
| `The credential file can be read by other users.`             | `chmod 600` the file shown, or `envvault logout`                      |
| `This environment is protected: confirm your password first.` | Open the printed `/cli/confirm` link, then retry                      |
| `Missing secret:runtime here` in `doctor`                     | Ask a project admin for a role or environment grant that includes it  |
| `The API speaks protocol …`                                   | Update the CLI or point it at a matching API                          |
| Exit code 9                                                   | Wait a minute; runtime loads are limited per user and per environment |

## 10. Tests

- `pnpm --filter @envvault/cli test`: unit tests (configuration validation,
  Windows, macOS and Linux paths, credential file permissions, error
  redaction, output path rules, child environment, exit codes and signals with
  a fake spawner).
- `apps/api/test/cli-process.int-spec.ts`: the built CLI as a separate process
  against the real API on a loopback port and a disposable local PostgreSQL
  database. It signs in through the device flow, refreshes tokens, links a
  directory, runs child processes that compare a digest of the injected value
  (the value itself never appears in output), forwards signals and exit
  codes, checks `pull` permissions, file mode and `.gitignore`, runs
  `doctor`, and verifies revocation and logout. Build the CLI first.
