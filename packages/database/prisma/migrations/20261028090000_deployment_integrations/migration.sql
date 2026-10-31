-- Phase 5B: Vercel deployment integration (environment mappings, managed
-- provider variables, sync job plans and summaries).
--
-- Review notes
-- - Reuses integration_connections (provider credential envelope columns,
--   reserved since Phase 1) and integration_sync_jobs. Adds health and
--   disconnect columns to connections and plan, summary, mapping and
--   requester columns to sync jobs. Existing rows are untouched; the new
--   columns are nullable or default to '{}'.
-- - New tables: integration_environment_mappings (EnvVault environment to
--   provider target) and integration_managed_variables (the provider variables
--   EnvVault created or adopted; nothing else is ever changed or removed).
-- - A mapping's connection and environment must belong to the same project
--   (composite foreign key); target fields must agree; one mapping per target,
--   branch and custom environment; at most one queued or running sync per
--   mapping.
-- - SyncJobStatus gains PARTIAL. PostgreSQL cannot remove enum values, so the
--   rollback script leaves it in place (unused).
-- - No values or credentials are stored by this migration; summaries hold key
--   names, actions and error codes only.
-- - Nothing outside the public schema is touched.
-- - Rollback: prisma/rollbacks/20261028090000_deployment_integrations.down.sql.

-- A new enum value cannot be used in the transaction that adds it (nothing below
-- uses PARTIAL). IF NOT EXISTS keeps this repeatable after the rollback script.
ALTER TYPE "SyncJobStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

BEGIN;

CREATE TYPE "IntegrationTarget" AS ENUM ('DEVELOPMENT', 'PREVIEW', 'PRODUCTION', 'CUSTOM');

-- AlterTable
ALTER TABLE "integration_connections" ADD COLUMN     "credential_kms_key_version" INTEGER,
ADD COLUMN     "disconnected_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_checked_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_error_code" VARCHAR(64);
-- AlterTable
ALTER TABLE "integration_sync_jobs" ADD COLUMN     "mapping_id" UUID,
ADD COLUMN     "plan_hash" VARCHAR(64),
ADD COLUMN     "requested_by_id" UUID,
ADD COLUMN     "summary" JSONB NOT NULL DEFAULT '{}';
-- CreateTable
CREATE TABLE "integration_environment_mappings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "integration_connection_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "target" "IntegrationTarget" NOT NULL,
    "git_branch" VARCHAR(250),
    "custom_environment_id" VARCHAR(100),
    "custom_environment_slug" VARCHAR(100),
    "created_by_id" UUID,
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "integration_environment_mappings_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "integration_managed_variables" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "mapping_id" UUID NOT NULL,
    "key" VARCHAR(256) NOT NULL,
    "provider_variable_id" VARCHAR(100) NOT NULL,
    "provider_updated_at" BIGINT NOT NULL,
    "secret_version_id" UUID,
    "last_sync_job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "integration_managed_variables_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "integration_environment_mappings_integration_connection_id_idx" ON "integration_environment_mappings"("integration_connection_id");
-- CreateIndex
CREATE INDEX "integration_environment_mappings_environment_id_idx" ON "integration_environment_mappings"("environment_id");
-- CreateIndex
CREATE UNIQUE INDEX "integration_environment_mappings_workspace_id_id_key" ON "integration_environment_mappings"("workspace_id", "id");
-- CreateIndex
CREATE UNIQUE INDEX "integration_managed_variables_mapping_id_key_key" ON "integration_managed_variables"("mapping_id", "key");
-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_workspace_project_id_key" ON "integration_connections"("workspace_id", "project_id", "id");
-- AddForeignKey
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_mapping_fkey" FOREIGN KEY ("mapping_id") REFERENCES "integration_environment_mappings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "integration_environment_mappings" ADD CONSTRAINT "integration_mappings_connection_fkey" FOREIGN KEY ("workspace_id", "project_id", "integration_connection_id") REFERENCES "integration_connections"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "integration_environment_mappings" ADD CONSTRAINT "integration_mappings_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "integration_environment_mappings" ADD CONSTRAINT "integration_environment_mappings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "integration_managed_variables" ADD CONSTRAINT "integration_managed_variables_mapping_fkey" FOREIGN KEY ("workspace_id", "mapping_id") REFERENCES "integration_environment_mappings"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity rules Prisma cannot express.
ALTER TABLE "integration_environment_mappings"
  ADD CONSTRAINT "integration_mappings_target_chk" CHECK (
    ("target" = 'PREVIEW' OR "git_branch" IS NULL)
    AND (("target" = 'CUSTOM') = ("custom_environment_id" IS NOT NULL))
    AND ("custom_environment_slug" IS NULL OR "custom_environment_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "integration_mappings_branch_chk" CHECK (
    "git_branch" IS NULL OR ("git_branch" ~ '^[A-Za-z0-9._/@+-]{1,250}$' AND "git_branch" !~ '\.\.')
  );
CREATE UNIQUE INDEX "integration_mappings_target_key" ON "integration_environment_mappings" (
  "integration_connection_id", "target", COALESCE("git_branch", ''), COALESCE("custom_environment_id", '')
);
CREATE UNIQUE INDEX "integration_sync_jobs_active_key" ON "integration_sync_jobs" ("mapping_id")
  WHERE "status" IN ('QUEUED', 'RUNNING') AND "mapping_id" IS NOT NULL;
ALTER TABLE "integration_sync_jobs"
  ADD CONSTRAINT "integration_sync_jobs_summary_chk" CHECK (
    jsonb_typeof("summary") = 'object' AND pg_column_size("summary") <= 65536
  ),
  ADD CONSTRAINT "integration_sync_jobs_plan_hash_chk" CHECK ("plan_hash" IS NULL OR "plan_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "integration_managed_variables"
  ADD CONSTRAINT "integration_managed_variables_key_chk" CHECK ("key" ~ '^[A-Za-z_][A-Za-z0-9_]{0,255}$'),
  ADD CONSTRAINT "integration_managed_variables_updated_chk" CHECK ("provider_updated_at" >= 0);
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_key_version_chk" CHECK (
    ("credential_kms_key_version" IS NULL) = ("credential_ciphertext" IS NULL)
    AND ("credential_kms_key_version" IS NULL OR "credential_kms_key_version" >= 1)
  ),
  ADD CONSTRAINT "integration_connections_disconnected_chk" CHECK (
    "disconnected_at" IS NULL OR ("credential_ciphertext" IS NULL AND "status" = 'DISABLED')
  );

CREATE TRIGGER "integration_mappings_immutable" BEFORE UPDATE ON "integration_environment_mappings"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'project_id', 'integration_connection_id', 'environment_id', 'target',
    'git_branch', 'custom_environment_id', 'created_at'
  );
CREATE TRIGGER "integration_managed_variables_immutable" BEFORE UPDATE ON "integration_managed_variables"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'mapping_id', 'key', 'created_at');

COMMIT;
