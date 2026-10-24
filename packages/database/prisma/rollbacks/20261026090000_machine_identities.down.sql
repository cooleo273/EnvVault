-- Reverses migration 20261026090000_machine_identities (Phase 4B).
--
-- Run only after reviewing it against the target database, inside a
-- maintenance window, with the API stopped:
--   psql "<connection URL without ?schema=>" -v ON_ERROR_STOP=1 -f 20261026090000_machine_identities.down.sql
--
-- Loses: every machine access token, credential scopes, digest key ids and
-- rotation links, and identity expiry, lifetime, disabled and retired
-- metadata. Credentials issued in Phase 4B remain as rows but can no longer
-- be verified by anything. Legacy credentials the migration revoked stay
-- revoked. Grants and identities are kept.

BEGIN;

DROP TRIGGER "machine_access_tokens_immutable" ON "machine_access_tokens";
DROP TABLE "machine_access_tokens";

DROP TRIGGER "service_credentials_immutable" ON "service_credentials";
ALTER TABLE "service_credentials"
  DROP CONSTRAINT "service_credentials_scopes_chk",
  DROP CONSTRAINT "service_credentials_digest_chk",
  DROP CONSTRAINT "service_credentials_not_self_rotated_chk",
  DROP CONSTRAINT "service_credentials_rotated_from_id_fkey";
DROP INDEX "service_credentials_rotated_from_id_key";
DROP INDEX "service_credentials_workspace_identity_id_key";
ALTER TABLE "service_credentials"
  DROP COLUMN "digest_key_id",
  DROP COLUMN "rotated_from_id",
  DROP COLUMN "scopes";
CREATE TRIGGER "service_credentials_immutable" BEFORE UPDATE ON "service_credentials"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'service_identity_id', 'type', 'token_prefix', 'secret_hash', 'hash_algorithm'
  );

ALTER TABLE "access_policies" DROP CONSTRAINT "access_policies_service_identity_fkey";
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_service_identity_fkey"
  FOREIGN KEY ("workspace_id", "service_identity_id") REFERENCES "service_identities"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_identities"
  DROP CONSTRAINT "service_identities_lifetime_chk",
  DROP CONSTRAINT "service_identities_disabled_chk",
  DROP CONSTRAINT "service_identities_retired_chk",
  DROP CONSTRAINT "service_identities_disabled_by_id_fkey",
  DROP CONSTRAINT "service_identities_retired_by_id_fkey";
DROP INDEX "service_identities_workspace_project_id_key";
ALTER TABLE "service_identities"
  DROP COLUMN "credential_max_lifetime_days",
  DROP COLUMN "disabled_at",
  DROP COLUMN "disabled_by_id",
  DROP COLUMN "disabled_reason",
  DROP COLUMN "expires_at",
  DROP COLUMN "last_authenticated_at",
  DROP COLUMN "retired_by_id",
  ALTER COLUMN "project_id" DROP NOT NULL;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261026090000_machine_identities';

COMMIT;
