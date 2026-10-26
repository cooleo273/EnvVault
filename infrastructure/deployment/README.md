# Deployment

Reference deployment for a small installation (one host, Docker Compose, Caddy for TLS,
Redis, Neon). The guide is [docs/deployment.md](../../docs/deployment.md); operator
procedures are in [docs/operational-runbook.md](../../docs/operational-runbook.md).

| File                     | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `docker/api.Dockerfile`  | API image (`runtime` target) and migration runner (`migrate` target)        |
| `docker/web.Dockerfile`  | Next.js standalone web image                                                |
| `compose.production.yml` | Caddy, web, API, Redis and the one off migration service                    |
| `Caddyfile`              | TLS (Let's Encrypt, TLS 1.2 and 1.3), HSTS, reverse proxy to the web server |
| `env/*.env.example`      | Configuration templates; copies (`*.env`) are gitignored                    |

These files have not been built or run yet. Verify them on a staging host first. Production
still needs the decisions listed in
[docs/security-hardening.md](../../docs/security-hardening.md#10-remaining-risks-and-production-blockers).
