-- Phase 5A: GitHub Actions OIDC trust bindings.
--
-- Review notes
-- - A trust binding is an OIDC_FEDERATION row in service_credentials (the
--   type reserved since Phase 1) plus one oidc_trust_policies row holding the
--   claim conditions. Access tokens keep referencing service_credentials, so
--   revocation, expiry and per request checks are the Phase 4B ones.
-- - service_credentials_oidc_chk is replaced: OIDC rows now need an issuer,
--   an audience, an expiry and at least one scope, and never hold a secret.
--   The subject becomes optional (conditions live in oidc_trust_policies).
--   No code ever created OIDC rows; the script stops if any exist so they can
--   be reviewed first.
-- - Issuer, audience and subject of a credential, and the repository and
--   owner ids of a policy, are immutable: pointing a binding at another
--   repository means creating a new binding.
-- - Nothing outside the public schema is touched.
-- - Rollback: prisma/rollbacks/20261027090000_oidc_trust_policies.down.sql
--   (drops the table; OIDC credentials are revoked, not deleted, because
--   access tokens and audit history reference them).
-- - Prisma does not wrap a migration in a transaction, so this script does.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "service_credentials" WHERE "type" = 'OIDC_FEDERATION') THEN
    RAISE EXCEPTION 'OIDC_FEDERATION credentials already exist; review them before this migration';
  END IF;
END
$$;

-- CreateTable
CREATE TABLE "oidc_trust_policies" (
    "credential_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "service_identity_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL DEFAULT 'GITHUB',
    "repository_id" VARCHAR(20) NOT NULL,
    "repository_owner_id" VARCHAR(20) NOT NULL,
    "repository_name" VARCHAR(200) NOT NULL,
    "workflow_path" VARCHAR(512),
    "job_workflow_ref" VARCHAR(1024),
    "refs" VARCHAR(512)[] DEFAULT ARRAY[]::VARCHAR(512)[],
    "github_environments" VARCHAR(255)[] DEFAULT ARRAY[]::VARCHAR(255)[],
    "event_names" VARCHAR(64)[] DEFAULT ARRAY[]::VARCHAR(64)[],
    "subject" VARCHAR(512),
    "environment_ids" UUID[],
    "disabled_at" TIMESTAMPTZ(3),
    "disabled_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "oidc_trust_policies_pkey" PRIMARY KEY ("credential_id")
);

-- CreateIndex
CREATE INDEX "oidc_trust_policies_repository_id_idx" ON "oidc_trust_policies"("repository_id");

-- CreateIndex
CREATE INDEX "oidc_trust_policies_workspace_id_project_id_idx" ON "oidc_trust_policies"("workspace_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_trust_policies_credential_key" ON "oidc_trust_policies"("workspace_id", "service_identity_id", "credential_id");

-- AddForeignKey
ALTER TABLE "oidc_trust_policies" ADD CONSTRAINT "oidc_trust_policies_credential_fkey" FOREIGN KEY ("workspace_id", "service_identity_id", "credential_id") REFERENCES "service_credentials"("workspace_id", "service_identity_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_trust_policies" ADD CONSTRAINT "oidc_trust_policies_identity_fkey" FOREIGN KEY ("workspace_id", "project_id", "service_identity_id") REFERENCES "service_identities"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_trust_policies" ADD CONSTRAINT "oidc_trust_policies_disabled_by_id_fkey" FOREIGN KEY ("disabled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_trust_policies" ADD CONSTRAINT "oidc_trust_policies_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity rules Prisma cannot express.
ALTER TABLE "service_credentials" DROP CONSTRAINT "service_credentials_oidc_chk";
ALTER TABLE "service_credentials"
  ADD CONSTRAINT "service_credentials_oidc_chk" CHECK (
    "type" <> 'OIDC_FEDERATION' OR (
      "oidc_issuer" IS NOT NULL AND "oidc_audience" IS NOT NULL
      AND "secret_hash" IS NULL AND "token_prefix" IS NULL AND "digest_key_id" IS NULL
      AND "expires_at" IS NOT NULL AND cardinality("scopes") >= 1
    )
  );

DROP TRIGGER "service_credentials_immutable" ON "service_credentials";
CREATE TRIGGER "service_credentials_immutable" BEFORE UPDATE ON "service_credentials"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'service_identity_id', 'type', 'token_prefix', 'secret_hash', 'hash_algorithm',
    'digest_key_id', 'scopes', 'rotated_from_id', 'created_at', 'oidc_issuer', 'oidc_audience',
    'oidc_subject'
  );

ALTER TABLE "oidc_trust_policies"
  ADD CONSTRAINT "oidc_trust_policies_lists_chk" CHECK (
    "refs" IS NOT NULL AND cardinality("refs") <= 20
    AND "github_environments" IS NOT NULL AND cardinality("github_environments") <= 20
    AND "event_names" IS NOT NULL AND cardinality("event_names") <= 20
    AND "environment_ids" IS NOT NULL AND cardinality("environment_ids") BETWEEN 1 AND 50
  ),
  ADD CONSTRAINT "oidc_trust_policies_repository_chk" CHECK (
    "repository_id" ~ '^[1-9][0-9]{0,19}$' AND "repository_owner_id" ~ '^[1-9][0-9]{0,19}$'
  ),
  -- pull_request_target runs with the base repository's permissions on code a fork controls.
  ADD CONSTRAINT "oidc_trust_policies_events_chk" CHECK (NOT ('pull_request_target' = ANY ("event_names"))),
  ADD CONSTRAINT "oidc_trust_policies_workflow_chk" CHECK (
    "workflow_path" IS NULL OR "workflow_path" ~ '^\.github/workflows/[A-Za-z0-9._/-]+\.ya?ml$'
  ),
  ADD CONSTRAINT "oidc_trust_policies_disabled_chk" CHECK ("disabled_by_id" IS NULL OR "disabled_at" IS NOT NULL);

CREATE TRIGGER "oidc_trust_policies_immutable" BEFORE UPDATE ON "oidc_trust_policies"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'credential_id', 'workspace_id', 'project_id', 'service_identity_id', 'provider',
    'repository_id', 'repository_owner_id', 'created_at'
  );

COMMIT;
