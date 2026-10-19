# Deployment

No deployment manifests exist yet: production deployment targets (container images,
Kubernetes/Helm, or a managed platform) are defined in a later phase.

Requirements any production deployment must meet:

- **PostgreSQL** (managed, TLS required, automated backups), referenced through
  `DATABASE_URL` from the platform's secret manager.
- **Managed KMS** for envelope encryption (AWS KMS, Google Cloud KMS, Azure Key Vault or
  HashiCorp Vault Transit), preferably accessed through workload identity rather than
  static credentials. Root keys never leave the KMS.
- **Redis** (managed, TLS, auth) before running more than one API replica (shared rate
  limiting).
- API configured with `NODE_ENV=production`, `API_HOST=0.0.0.0` inside containers,
  `https` origins in `CORS_ORIGINS`, and `TRUST_PROXY=true` only behind a trusted load
  balancer.
- TLS termination in front of both the web app and the API.
- Probes: liveness `GET /api/v1/health`, readiness `GET /api/v1/health/ready`.
- Migrations applied with `pnpm --filter @envvault/database db:migrate:deploy` as a
  release step, never on application start.
