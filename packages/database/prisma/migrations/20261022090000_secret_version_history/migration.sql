-- Phase 3C: provenance of secret versions, for history and rollback.
--
-- Review notes
-- - Additive only: one enum, three columns (two nullable, one with a default),
--   two CHECK constraints and a foreign key. No row is removed and no
--   encrypted column changes.
-- - Existing versions are backfilled: version 1 of a variable came from its
--   creation, every later version from an update.
-- - The immutability trigger is recreated with the new columns, so history
--   stays append only. Only the wrapped data key and its key reference remain
--   mutable, for rewrapping.
-- - Prisma does not wrap a migration in a transaction, so this script does.

BEGIN;

CREATE TYPE "SecretVersionOrigin" AS ENUM ('CREATE', 'UPDATE', 'IMPORT', 'ROLLBACK');

ALTER TABLE "secret_versions"
  ADD COLUMN "origin" "SecretVersionOrigin" NOT NULL DEFAULT 'UPDATE',
  ADD COLUMN "change_reason" VARCHAR(500),
  ADD COLUMN "restored_from_version_id" UUID;

UPDATE "secret_versions" SET "origin" = 'CREATE' WHERE "version_number" = 1;

-- A rollback points at an earlier version of the same secret.
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_restored_from_fkey"
  FOREIGN KEY ("secret_id", "restored_from_version_id")
  REFERENCES "secret_versions"("secret_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "secret_versions"
  ADD CONSTRAINT "secret_versions_rollback_source_chk" CHECK (
    ("origin" = 'ROLLBACK') = ("restored_from_version_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "secret_versions_change_reason_chk" CHECK (
    "change_reason" IS NULL OR (char_length("change_reason") >= 1 AND "change_reason" = btrim("change_reason"))
  );

DROP TRIGGER "secret_versions_immutable" ON "secret_versions";
CREATE TRIGGER "secret_versions_immutable" BEFORE UPDATE ON "secret_versions"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'secret_id', 'version_number', 'ciphertext', 'iv', 'auth_tag', 'algorithm',
    'envelope_version', 'created_by_user_id', 'created_by_service_identity_id', 'created_at',
    'origin', 'change_reason', 'restored_from_version_id'
  );

COMMIT;
