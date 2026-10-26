-- Phase 4B: machine identities, service credentials and machine access tokens.
--
-- Review notes
-- - Extends the Phase 1 placeholder tables (service_identities,
--   service_credentials, access_policies) instead of adding parallel ones.
-- - service_identities.project_id becomes NOT NULL: every identity belongs to
--   one project. The script stops (and changes nothing) if an identity
--   without a project exists; decide what to do with it before applying.
-- - access_policies now reference identities through (workspace, project,
--   identity), so an identity can only be granted environments of its own
--   project. Existing grants already satisfy this (verified before the
--   constraint is added; it fails otherwise).
-- - Credentials store an HMAC-SHA256 digest under the integrity key
--   (digest_key_id names the key); access tokens store a SHA-256 hash of a
--   256 bit random value. No raw token is stored anywhere.
-- - New check constraints confine scopes to the machine permissions. A
--   credential's scopes, digest and rotation link are immutable.
-- - Existing identities and grants are kept unchanged (identities already
--   disabled get a disabled time). API_TOKEN credentials from before this
--   phase have no keyed digest and no code ever issued them, so they cannot
--   be verified: they are revoked (kept, not deleted) and the new checks
--   accept them only in that state. OIDC rows are untouched.
-- - Nothing outside the public schema is touched (no neon_auth objects).
-- - Rollback: Prisma has no down migrations. A reviewed reverse script is in
--   prisma/rollbacks/20261026090000_machine_identities.down.sql. It drops the
--   new table and columns, so machine access tokens, scopes and digests are
--   lost, and legacy credentials revoked here stay revoked.
-- - Prisma does not wrap a migration in a transaction, so this script does.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "service_identities" WHERE "project_id" IS NULL) THEN
    RAISE EXCEPTION 'service_identities without a project exist; assign or remove them before this migration';
  END IF;
END
$$;

-- DropForeignKey
ALTER TABLE "access_policies" DROP CONSTRAINT "access_policies_service_identity_fkey";

-- AlterTable
ALTER TABLE "service_credentials" ADD COLUMN     "digest_key_id" VARCHAR(64),
ADD COLUMN     "rotated_from_id" UUID,
ADD COLUMN     "scopes" VARCHAR(64)[] DEFAULT ARRAY[]::VARCHAR(64)[];

-- AlterTable
ALTER TABLE "service_identities" ADD COLUMN     "credential_max_lifetime_days" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "disabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "disabled_by_id" UUID,
ADD COLUMN     "disabled_reason" VARCHAR(500),
ADD COLUMN     "expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_authenticated_at" TIMESTAMPTZ(3),
ADD COLUMN     "retired_by_id" UUID,
ALTER COLUMN "project_id" SET NOT NULL;

-- CreateTable
CREATE TABLE "machine_access_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "service_identity_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "scopes" VARCHAR(64)[],
    "environment_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "requested_ip" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "machine_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "machine_access_tokens_token_hash_key" ON "machine_access_tokens"("token_hash");
CREATE INDEX "machine_access_tokens_credential_id_idx" ON "machine_access_tokens"("credential_id");
CREATE INDEX "machine_access_tokens_expires_at_idx" ON "machine_access_tokens"("expires_at");
CREATE UNIQUE INDEX "service_credentials_rotated_from_id_key" ON "service_credentials"("rotated_from_id");
CREATE UNIQUE INDEX "service_credentials_workspace_identity_id_key" ON "service_credentials"("workspace_id", "service_identity_id", "id");
CREATE UNIQUE INDEX "service_identities_workspace_project_id_key" ON "service_identities"("workspace_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "service_identities" ADD CONSTRAINT "service_identities_disabled_by_id_fkey" FOREIGN KEY ("disabled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_identities" ADD CONSTRAINT "service_identities_retired_by_id_fkey" FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_rotated_from_id_fkey" FOREIGN KEY ("rotated_from_id") REFERENCES "service_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "machine_access_tokens" ADD CONSTRAINT "machine_access_tokens_credential_fkey" FOREIGN KEY ("workspace_id", "service_identity_id", "credential_id") REFERENCES "service_credentials"("workspace_id", "service_identity_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_service_identity_fkey" FOREIGN KEY ("workspace_id", "project_id", "service_identity_id") REFERENCES "service_identities"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Legacy credentials cannot be verified by the new scheme; end them, keep the rows.
UPDATE "service_credentials"
   SET "revoked_at" = GREATEST(now(), "created_at"),
       "revocation_reason" = 'Superseded by the Phase 4B credential format'
 WHERE "type" = 'API_TOKEN' AND "digest_key_id" IS NULL AND "revoked_at" IS NULL;

-- Checks (not modelled by Prisma).
-- Identities disabled before this migration get a disabled time, so the check holds.
UPDATE "service_identities" SET "disabled_at" = "updated_at" WHERE "status" = 'DISABLED' AND "disabled_at" IS NULL;
ALTER TABLE "service_identities"
  ADD CONSTRAINT "service_identities_lifetime_chk" CHECK ("credential_max_lifetime_days" BETWEEN 1 AND 365),
  ADD CONSTRAINT "service_identities_disabled_chk" CHECK (
    ("status" = 'DISABLED') = ("disabled_at" IS NOT NULL)
    AND ("disabled_reason" IS NULL OR "disabled_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "service_identities_retired_chk" CHECK ("retired_by_id" IS NULL OR "deleted_at" IS NOT NULL);

ALTER TABLE "service_credentials"
  ADD CONSTRAINT "service_credentials_scopes_chk" CHECK (
    "scopes" IS NOT NULL
    AND "scopes" <@ ARRAY['environment:read', 'secret:list', 'secret:runtime']::VARCHAR(64)[]
    AND ("type" <> 'API_TOKEN' OR "digest_key_id" IS NULL OR cardinality("scopes") >= 1)
  ),
  -- Every usable API token has a keyed digest; legacy rows without one must be revoked.
  ADD CONSTRAINT "service_credentials_digest_chk" CHECK (
    "type" <> 'API_TOKEN'
    OR ("digest_key_id" IS NOT NULL AND "hash_algorithm" = 'hmac-sha256')
    OR ("digest_key_id" IS NULL AND "revoked_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "service_credentials_not_self_rotated_chk" CHECK ("rotated_from_id" IS NULL OR "rotated_from_id" <> "id");

ALTER TABLE "machine_access_tokens"
  ADD CONSTRAINT "machine_access_tokens_hash_chk" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "machine_access_tokens_scopes_chk" CHECK (
    "scopes" IS NOT NULL AND cardinality("scopes") >= 1
    AND "scopes" <@ ARRAY['environment:read', 'secret:list', 'secret:runtime']::VARCHAR(64)[]
  ),
  ADD CONSTRAINT "machine_access_tokens_environments_chk" CHECK (
    "environment_ids" IS NOT NULL AND cardinality("environment_ids") <= 50
  ),
  ADD CONSTRAINT "machine_access_tokens_expiry_chk" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "machine_access_tokens_revocation_chk" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at");

-- Immutability: what a credential proves and allows never changes after creation.
DROP TRIGGER "service_credentials_immutable" ON "service_credentials";
CREATE TRIGGER "service_credentials_immutable" BEFORE UPDATE ON "service_credentials"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'service_identity_id', 'type', 'token_prefix', 'secret_hash', 'hash_algorithm',
    'digest_key_id', 'scopes', 'rotated_from_id', 'created_at'
  );
CREATE TRIGGER "machine_access_tokens_immutable" BEFORE UPDATE ON "machine_access_tokens"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'service_identity_id', 'credential_id', 'token_hash', 'scopes',
    'environment_ids', 'created_at', 'expires_at'
  );

COMMIT;
