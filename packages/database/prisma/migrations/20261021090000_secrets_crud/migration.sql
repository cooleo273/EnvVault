-- Phase 3B: secret metadata for the variables dashboard.
--
-- Review notes
-- - SecretType is replaced by the variable types the API accepts. Existing rows
--   are converted, never dropped: GENERIC becomes STRING, JSON stays JSON,
--   CERTIFICATE and PRIVATE_KEY become MULTILINE, every other legacy value
--   becomes SECRET. Phase 2 only ever wrote metadata rows (the development
--   seed), so no encrypted value changes meaning.
-- - Every other change adds nullable columns or columns with defaults. Nothing
--   is removed and no secret_versions row is touched.
-- - Prisma does not wrap a migration in a transaction, so this script does:
--   a failure anywhere leaves the previous schema intact (see
--   test/integration/migration-safety.test.ts).

BEGIN;

-- =============================================================================
-- 1. Variable types
-- =============================================================================

ALTER TYPE "SecretType" RENAME TO "SecretType_legacy";
CREATE TYPE "SecretType" AS ENUM ('STRING', 'SECRET', 'BOOLEAN', 'NUMBER', 'JSON', 'MULTILINE');

-- STRICT: a NULL type (optional on change_request_items) stays NULL.
CREATE FUNCTION "envvault_map_legacy_secret_type"("SecretType_legacy") RETURNS "SecretType"
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (CASE $1::text
    WHEN 'GENERIC' THEN 'STRING'
    WHEN 'JSON' THEN 'JSON'
    WHEN 'CERTIFICATE' THEN 'MULTILINE'
    WHEN 'PRIVATE_KEY' THEN 'MULTILINE'
    ELSE 'SECRET'
  END)::"SecretType"
$$;

ALTER TABLE "secrets" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "secrets"
  ALTER COLUMN "type" TYPE "SecretType" USING "envvault_map_legacy_secret_type"("type");
ALTER TABLE "secrets" ALTER COLUMN "type" SET DEFAULT 'SECRET';

ALTER TABLE "change_request_items"
  ALTER COLUMN "secret_type" TYPE "SecretType" USING "envvault_map_legacy_secret_type"("secret_type");

DROP FUNCTION "envvault_map_legacy_secret_type"("SecretType_legacy");
DROP TYPE "SecretType_legacy";

-- =============================================================================
-- 2. Organisation, lifecycle and concurrency columns
-- =============================================================================

ALTER TABLE "secrets"
  ADD COLUMN "category" VARCHAR(64),
  ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "is_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "deleted_by_user_id" UUID;

ALTER TABLE "secrets" ADD CONSTRAINT "secrets_deleted_by_user_id_fkey"
  FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Prisma models scalar lists as nullable columns; the CHECK keeps them present.
ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_tags_present_chk" CHECK ("tags" IS NOT NULL),
  ADD CONSTRAINT "secrets_tags_count_chk" CHECK (cardinality("tags") <= 20),
  ADD CONSTRAINT "secrets_category_chk" CHECK (
    "category" IS NULL OR (char_length("category") BETWEEN 1 AND 64 AND "category" = btrim("category"))
  ),
  ADD CONSTRAINT "secrets_revision_chk" CHECK ("revision" >= 1),
  ADD CONSTRAINT "secrets_deleted_by_requires_deleted_chk" CHECK (
    "deleted_by_user_id" IS NULL OR "deleted_at" IS NOT NULL
  );

-- The live list is served by "secrets_environment_key_live_key"; this one
-- serves the deleted list of an environment, newest first.
CREATE INDEX "secrets_environment_deleted_idx" ON "secrets" ("environment_id", "deleted_at" DESC)
  WHERE "deleted_at" IS NOT NULL;

COMMIT;
