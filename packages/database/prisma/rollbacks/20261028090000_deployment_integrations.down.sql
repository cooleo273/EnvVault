-- Reverses 20261028090000_deployment_integrations. Review before running, with
-- the API stopped. Mappings, managed variable records and Phase 5B job columns
-- are dropped; the variables EnvVault wrote to providers stay in the providers
-- and are no longer tracked. The PARTIAL value of SyncJobStatus stays (PostgreSQL
-- cannot drop enum values); rows using it are marked FAILED. Afterwards remove
-- the migration's row from _prisma_migrations.

BEGIN;

UPDATE "integration_sync_jobs" SET "status" = 'FAILED' WHERE "status" = 'PARTIAL';

ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_disconnected_chk";
ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_key_version_chk";
DROP TABLE "integration_managed_variables";
ALTER TABLE "integration_sync_jobs" DROP CONSTRAINT "integration_sync_jobs_mapping_fkey";
ALTER TABLE "integration_sync_jobs" DROP CONSTRAINT "integration_sync_jobs_requested_by_id_fkey";
DROP INDEX "integration_sync_jobs_active_key";
ALTER TABLE "integration_sync_jobs"
  DROP CONSTRAINT "integration_sync_jobs_summary_chk",
  DROP CONSTRAINT "integration_sync_jobs_plan_hash_chk",
  DROP COLUMN "mapping_id",
  DROP COLUMN "plan_hash",
  DROP COLUMN "requested_by_id",
  DROP COLUMN "summary";
DROP TABLE "integration_environment_mappings";
DROP INDEX "integration_connections_workspace_project_id_key";
ALTER TABLE "integration_connections"
  DROP COLUMN "credential_kms_key_version",
  DROP COLUMN "disconnected_at",
  DROP COLUMN "last_checked_at",
  DROP COLUMN "last_error_code";
DROP TYPE "IntegrationTarget";

COMMIT;
