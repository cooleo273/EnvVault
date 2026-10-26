-- Phase 3D: environment intelligence (inheritance, validation rules, snapshots).
--
-- Review notes
-- - Additive only: two enums, one enum value, two columns with safe
--   defaults (nullable base_environment_id, inheritable = false), three new
--   tables, constraints and triggers. No existing row changes meaning.
-- - secrets gains UNIQUE (environment_id, id) so snapshot entries can prove,
--   by foreign key, that each secret belongs to the snapshot's environment.
-- - Inheritance is one level: a trigger rejects self references, chains and
--   cycles. The base must be in the same project (composite foreign key).
-- - Snapshots and their entries are immutable (triggers), hold no values and
--   no ciphertext, and reference exact secret_versions rows of the same secret.
-- - Prisma does not wrap a migration in a transaction, so this script does.
--   ADD VALUE inside a transaction is allowed (PostgreSQL 12+); the new value
--   is only compared as text below, never cast, so it is not used before commit.

BEGIN;

-- CreateEnum
CREATE TYPE "ValueFormat" AS ENUM ('ANY', 'URL', 'JSON', 'NUMBER');

-- CreateEnum
CREATE TYPE "EnvironmentSnapshotStatus" AS ENUM ('COMPLETE');

-- AlterEnum
ALTER TYPE "SecretVersionOrigin" ADD VALUE 'RESTORE';

-- AlterTable
ALTER TABLE "environments" ADD COLUMN     "base_environment_id" UUID;

-- AlterTable
ALTER TABLE "secrets" ADD COLUMN     "inheritable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "configuration_validation_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "key" VARCHAR(256) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "allow_empty" BOOLEAN NOT NULL DEFAULT true,
    "format" "ValueFormat" NOT NULL DEFAULT 'ANY',
    "min_number" DECIMAL(38,10),
    "max_number" DECIMAL(38,10),
    "min_length" INTEGER,
    "max_length" INTEGER,
    "pattern" VARCHAR(200),
    "allowed_values" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" VARCHAR(500),
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "configuration_validation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "description" VARCHAR(500),
    "status" "EnvironmentSnapshotStatus" NOT NULL DEFAULT 'COMPLETE',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "entry_count" INTEGER NOT NULL,
    "base_environment_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environment_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_snapshot_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "secret_id" UUID NOT NULL,
    "secret_version_id" UUID,
    "version_number" INTEGER,
    "key" VARCHAR(256) NOT NULL,
    "type" "SecretType" NOT NULL,
    "category" VARCHAR(64),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_required" BOOLEAN NOT NULL,
    "inheritable" BOOLEAN NOT NULL,
    "description" VARCHAR(1000),

    CONSTRAINT "environment_snapshot_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "configuration_validation_rules_workspace_id_project_id_idx" ON "configuration_validation_rules"("workspace_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "configuration_validation_rules_environment_id_key_key" ON "configuration_validation_rules"("environment_id", "key");

-- CreateIndex
CREATE INDEX "environment_snapshots_environment_id_created_at_idx" ON "environment_snapshots"("environment_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "environment_snapshots_workspace_id_id_key" ON "environment_snapshots"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "environment_snapshots_id_environment_id_key" ON "environment_snapshots"("id", "environment_id");

-- CreateIndex
CREATE INDEX "environment_snapshot_entries_secret_id_idx" ON "environment_snapshot_entries"("secret_id");

-- CreateIndex
CREATE INDEX "environment_snapshot_entries_secret_version_id_idx" ON "environment_snapshot_entries"("secret_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "environment_snapshot_entries_snapshot_id_secret_id_key" ON "environment_snapshot_entries"("snapshot_id", "secret_id");

-- CreateIndex
CREATE UNIQUE INDEX "environment_snapshot_entries_snapshot_id_key_key" ON "environment_snapshot_entries"("snapshot_id", "key");

-- CreateIndex
CREATE INDEX "environments_base_environment_id_idx" ON "environments"("base_environment_id");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_environment_id_id_key" ON "secrets"("environment_id", "id");

-- AddForeignKey
ALTER TABLE "configuration_validation_rules" ADD CONSTRAINT "configuration_validation_rules_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_validation_rules" ADD CONSTRAINT "configuration_validation_rules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_validation_rules" ADD CONSTRAINT "configuration_validation_rules_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_snapshots" ADD CONSTRAINT "environment_snapshots_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_snapshots" ADD CONSTRAINT "environment_snapshots_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_snapshot_entries" ADD CONSTRAINT "environment_snapshot_entries_snapshot_fkey" FOREIGN KEY ("snapshot_id", "environment_id") REFERENCES "environment_snapshots"("id", "environment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_snapshot_entries" ADD CONSTRAINT "environment_snapshot_entries_secret_fkey" FOREIGN KEY ("environment_id", "secret_id") REFERENCES "secrets"("environment_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_snapshot_entries" ADD CONSTRAINT "environment_snapshot_entries_version_fkey" FOREIGN KEY ("secret_id", "secret_version_id") REFERENCES "secret_versions"("secret_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_base_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "base_environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- =============================================================================
-- Constraints Prisma cannot express
-- =============================================================================

-- Rollbacks and snapshot restores both name the version they copied.
ALTER TABLE "secret_versions" DROP CONSTRAINT "secret_versions_rollback_source_chk";
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_rollback_source_chk" CHECK (
  ("origin"::text IN ('ROLLBACK', 'RESTORE')) = ("restored_from_version_id" IS NOT NULL)
);

-- Credentials are never inheritable, whatever else they are marked as.
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_inheritable_not_secret_chk" CHECK (
  NOT ("inheritable" AND "type" = 'SECRET')
);

ALTER TABLE "environments" ADD CONSTRAINT "environments_base_not_self_chk" CHECK (
  "base_environment_id" IS NULL OR "base_environment_id" <> "id"
);

ALTER TABLE "configuration_validation_rules"
  ADD CONSTRAINT "configuration_validation_rules_key_chk" CHECK (
    "key" = '*' OR "key" ~ '^[A-Za-z_][A-Za-z0-9_]*$'
  ),
  ADD CONSTRAINT "configuration_validation_rules_naming_chk" CHECK (
    "key" <> '*' OR ("pattern" IS NOT NULL AND NOT "required")
  ),
  ADD CONSTRAINT "configuration_validation_rules_length_chk" CHECK (
    ("min_length" IS NULL OR "min_length" >= 0)
    AND ("max_length" IS NULL OR "max_length" >= 0)
    AND ("min_length" IS NULL OR "max_length" IS NULL OR "min_length" <= "max_length")
  ),
  ADD CONSTRAINT "configuration_validation_rules_number_chk" CHECK (
    "min_number" IS NULL OR "max_number" IS NULL OR "min_number" <= "max_number"
  ),
  ADD CONSTRAINT "configuration_validation_rules_allowed_values_chk" CHECK (
    "allowed_values" IS NOT NULL AND cardinality("allowed_values") <= 50
  ),
  ADD CONSTRAINT "configuration_validation_rules_description_chk" CHECK (
    "description" IS NULL OR (char_length("description") >= 1 AND "description" = btrim("description"))
  );

ALTER TABLE "environment_snapshots"
  ADD CONSTRAINT "environment_snapshots_entry_count_chk" CHECK ("entry_count" >= 0),
  ADD CONSTRAINT "environment_snapshots_description_chk" CHECK (
    "description" IS NULL OR (char_length("description") >= 1 AND "description" = btrim("description"))
  );

ALTER TABLE "environment_snapshot_entries"
  ADD CONSTRAINT "environment_snapshot_entries_version_chk" CHECK (
    ("secret_version_id" IS NULL) = ("version_number" IS NULL)
  ),
  ADD CONSTRAINT "environment_snapshot_entries_key_chk" CHECK ("key" ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  ADD CONSTRAINT "environment_snapshot_entries_tags_chk" CHECK (
    "tags" IS NOT NULL AND cardinality("tags") <= 20
  );

-- =============================================================================
-- Inheritance: one level, no cycles
-- =============================================================================

CREATE FUNCTION "envvault_check_environment_inheritance"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."base_environment_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "environments"
    WHERE "id" = NEW."base_environment_id" AND "base_environment_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a base environment cannot itself inherit from another environment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "environments" WHERE "base_environment_id" = NEW."id") THEN
    RAISE EXCEPTION 'an environment that other environments inherit from cannot inherit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "environments_inheritance" BEFORE INSERT OR UPDATE OF "base_environment_id"
  ON "environments" FOR EACH ROW EXECUTE FUNCTION "envvault_check_environment_inheritance"();

-- =============================================================================
-- Immutable snapshots
-- =============================================================================

CREATE TRIGGER "environment_snapshots_immutable" BEFORE UPDATE ON "environment_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'project_id', 'environment_id', 'description', 'schema_version',
    'entry_count', 'base_environment_id', 'created_by_user_id', 'created_at'
  );
CREATE TRIGGER "environment_snapshot_entries_immutable" BEFORE UPDATE ON "environment_snapshot_entries"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'snapshot_id', 'environment_id', 'secret_id', 'secret_version_id',
    'version_number', 'key', 'type', 'category', 'tags', 'is_required', 'inheritable', 'description'
  );
CREATE TRIGGER "configuration_validation_rules_immutable" BEFORE UPDATE ON "configuration_validation_rules"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'project_id', 'environment_id', 'created_by_user_id', 'created_at'
  );

COMMIT;
