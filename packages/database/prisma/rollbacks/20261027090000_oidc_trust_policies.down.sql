-- Reverses 20261027090000_oidc_trust_policies. Review before running, with the
-- API stopped. OIDC credentials are revoked rather than deleted: access tokens
-- and audit events reference them. Afterwards remove the migration's row from
-- _prisma_migrations so Prisma can apply it again later.

BEGIN;

UPDATE "machine_access_tokens" t SET "revoked_at" = now()
  FROM "service_credentials" c
  WHERE t."credential_id" = c."id" AND c."type" = 'OIDC_FEDERATION' AND t."revoked_at" IS NULL;

UPDATE "service_credentials"
  SET "revoked_at" = now(), "revocation_reason" = 'oidc_trust_policies rollback'
  WHERE "type" = 'OIDC_FEDERATION' AND "revoked_at" IS NULL;

DROP TABLE "oidc_trust_policies";

DROP TRIGGER "service_credentials_immutable" ON "service_credentials";
CREATE TRIGGER "service_credentials_immutable" BEFORE UPDATE ON "service_credentials"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'service_identity_id', 'type', 'token_prefix', 'secret_hash', 'hash_algorithm',
    'digest_key_id', 'scopes', 'rotated_from_id', 'created_at'
  );

-- The original check requires a subject, which OIDC rows created by 5A may lack.
ALTER TABLE "service_credentials" DROP CONSTRAINT "service_credentials_oidc_chk";
UPDATE "service_credentials" SET "oidc_subject" = 'rollback:none'
  WHERE "type" = 'OIDC_FEDERATION' AND "oidc_subject" IS NULL;
ALTER TABLE "service_credentials"
  ADD CONSTRAINT "service_credentials_oidc_chk" CHECK (
    "type" <> 'OIDC_FEDERATION' OR (
      "oidc_issuer" IS NOT NULL AND "oidc_subject" IS NOT NULL
      AND "secret_hash" IS NULL AND "token_prefix" IS NULL
    )
  );

COMMIT;
