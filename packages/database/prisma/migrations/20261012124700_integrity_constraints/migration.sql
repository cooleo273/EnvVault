-- Integrity rules that Prisma's schema language cannot express.
--
-- Prisma Migrate ignores CHECK constraints, partial/expression indexes and
-- triggers when diffing, so these objects do not cause schema drift. The
-- drift check in CI (`db:check-drift`) verifies that remains true.
--
-- All custom errors use SQLSTATE 23514 (check_violation) so callers can treat
-- them like any other constraint violation.

-- =============================================================================
-- 0. Deferred intra-tenant references
--    These ON DELETE NO ACTION foreign keys protect rows that are still in use
--    (a role assigned to members, a key encrypting secret versions, ...). NO
--    ACTION alone is evaluated per cascade path, so a workspace purge would
--    fail depending on cascade order. Deferring the check to COMMIT keeps the
--    protection (deleting an in-use role/key is still rejected) while allowing
--    a purge that removes both sides in one transaction.
-- =============================================================================

ALTER TABLE "workspace_memberships" ALTER CONSTRAINT "workspace_memberships_role_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "workspace_invitations" ALTER CONSTRAINT "workspace_invitations_role_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_memberships" ALTER CONSTRAINT "project_memberships_role_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "access_policies" ALTER CONSTRAINT "access_policies_role_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "secrets" ALTER CONSTRAINT "secrets_current_version_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "secrets" ALTER CONSTRAINT "secrets_created_by_service_identity_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "secrets" ALTER CONSTRAINT "secrets_updated_by_service_identity_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "secret_versions" ALTER CONSTRAINT "secret_versions_encryption_key_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "secret_versions" ALTER CONSTRAINT "secret_versions_created_by_service_identity_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "secret_rotation_policies" ALTER CONSTRAINT "secret_rotation_policies_integration_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "change_request_items" ALTER CONSTRAINT "change_request_items_encryption_key_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "integration_connections" ALTER CONSTRAINT "integration_connections_encryption_key_fkey" DEFERRABLE INITIALLY DEFERRED;

-- =============================================================================
-- 1. Value and format checks
-- =============================================================================

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_chk" CHECK ("email" = lower("email") AND "email" LIKE '_%@_%');

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_slug_format_chk" CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  ADD CONSTRAINT "workspaces_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

ALTER TABLE "roles"
  ADD CONSTRAINT "roles_key_format_chk" CHECK ("key" ~ '^[a-z][a-z0-9_-]{0,63}$');

ALTER TABLE "permissions"
  ADD CONSTRAINT "permissions_key_format_chk" CHECK ("key" ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$');

ALTER TABLE "workspace_invitations"
  ADD CONSTRAINT "workspace_invitations_email_normalized_chk" CHECK ("email" = lower("email") AND "email" LIKE '_%@_%'),
  ADD CONSTRAINT "workspace_invitations_token_hash_len_chk" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "workspace_invitations_expiry_chk" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "workspace_invitations_accepted_chk" CHECK ("status" <> 'ACCEPTED' OR "accepted_at" IS NOT NULL),
  ADD CONSTRAINT "workspace_invitations_revoked_chk" CHECK ("status" <> 'REVOKED' OR "revoked_at" IS NOT NULL);

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_slug_format_chk" CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  ADD CONSTRAINT "projects_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

ALTER TABLE "environments"
  ADD CONSTRAINT "environments_slug_format_chk" CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  ADD CONSTRAINT "environments_name_not_blank_chk" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "environments_required_approvals_chk" CHECK ("required_approvals" BETWEEN 0 AND 10),
  ADD CONSTRAINT "environments_approvals_require_protection_chk" CHECK ("required_approvals" = 0 OR "is_protected");

ALTER TABLE "environment_templates"
  ADD CONSTRAINT "environment_templates_definition_chk" CHECK (jsonb_typeof("environments") = 'array');

ALTER TABLE "encryption_keys"
  ADD CONSTRAINT "encryption_keys_version_chk" CHECK ("version" > 0),
  ADD CONSTRAINT "encryption_keys_ref_not_blank_chk" CHECK (length(btrim("kms_key_ref")) > 0 AND length(btrim("kms_provider")) > 0),
  ADD CONSTRAINT "encryption_keys_retired_chk" CHECK ("status" <> 'RETIRED' OR "retired_at" IS NOT NULL);

ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_key_format_chk" CHECK ("key" ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  ADD CONSTRAINT "secrets_latest_version_chk" CHECK ("latest_version_number" >= 0),
  ADD CONSTRAINT "secrets_current_version_requires_versions_chk" CHECK ("current_version_id" IS NULL OR "latest_version_number" > 0),
  ADD CONSTRAINT "secrets_created_by_one_principal_chk" CHECK (num_nonnulls("created_by_user_id", "created_by_service_identity_id") = 1),
  ADD CONSTRAINT "secrets_updated_by_one_principal_chk" CHECK (num_nonnulls("updated_by_user_id", "updated_by_service_identity_id") = 1);

-- Envelope shape mirrors @envvault/crypto: 96-bit IV, 128-bit tag, <= 64 KiB values.
ALTER TABLE "secret_versions"
  ADD CONSTRAINT "secret_versions_version_number_chk" CHECK ("version_number" > 0),
  ADD CONSTRAINT "secret_versions_envelope_version_chk" CHECK ("envelope_version" > 0),
  ADD CONSTRAINT "secret_versions_iv_len_chk" CHECK (octet_length("iv") = 12),
  ADD CONSTRAINT "secret_versions_auth_tag_len_chk" CHECK (octet_length("auth_tag") = 16),
  ADD CONSTRAINT "secret_versions_ciphertext_len_chk" CHECK (octet_length("ciphertext") <= 65536),
  ADD CONSTRAINT "secret_versions_data_key_len_chk" CHECK (octet_length("encrypted_data_key") BETWEEN 1 AND 4096),
  ADD CONSTRAINT "secret_versions_created_by_one_principal_chk" CHECK (num_nonnulls("created_by_user_id", "created_by_service_identity_id") = 1);

ALTER TABLE "secret_rotation_policies"
  ADD CONSTRAINT "secret_rotation_policies_interval_chk" CHECK ("interval_days" BETWEEN 1 AND 3650),
  ADD CONSTRAINT "secret_rotation_policies_integration_chk" CHECK ("strategy" <> 'INTEGRATION' OR "integration_connection_id" IS NOT NULL);

ALTER TABLE "service_identities"
  ADD CONSTRAINT "service_identities_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

-- API tokens: hash only, mandatory expiry. Federation: issuer + subject, no stored secret.
ALTER TABLE "service_credentials"
  ADD CONSTRAINT "service_credentials_api_token_chk" CHECK (
    "type" <> 'API_TOKEN' OR (
      "token_prefix" IS NOT NULL AND "secret_hash" IS NOT NULL AND "hash_algorithm" IS NOT NULL
      AND "expires_at" IS NOT NULL AND "oidc_issuer" IS NULL AND "oidc_subject" IS NULL
    )
  ),
  ADD CONSTRAINT "service_credentials_oidc_chk" CHECK (
    "type" <> 'OIDC_FEDERATION' OR (
      "oidc_issuer" IS NOT NULL AND "oidc_subject" IS NOT NULL
      AND "secret_hash" IS NULL AND "token_prefix" IS NULL
    )
  ),
  ADD CONSTRAINT "service_credentials_secret_hash_len_chk" CHECK ("secret_hash" IS NULL OR octet_length("secret_hash") >= 32),
  ADD CONSTRAINT "service_credentials_expiry_chk" CHECK ("expires_at" IS NULL OR "expires_at" > "created_at"),
  ADD CONSTRAINT "service_credentials_revocation_chk" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at"),
  ADD CONSTRAINT "service_credentials_revocation_reason_chk" CHECK ("revocation_reason" IS NULL OR "revoked_at" IS NOT NULL);

ALTER TABLE "access_policies"
  ADD CONSTRAINT "access_policies_one_subject_chk" CHECK (num_nonnulls("workspace_membership_id", "service_identity_id") = 1),
  ADD CONSTRAINT "access_policies_expiry_chk" CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");

ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_required_approvals_chk" CHECK ("required_approvals" BETWEEN 0 AND 10),
  ADD CONSTRAINT "change_requests_applied_chk" CHECK ("status" <> 'APPLIED' OR ("applied_at" IS NOT NULL AND "applied_by_id" IS NOT NULL));

ALTER TABLE "change_request_items"
  ADD CONSTRAINT "change_request_items_key_format_chk" CHECK ("secret_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  ADD CONSTRAINT "change_request_items_envelope_complete_chk" CHECK (
    num_nulls("ciphertext", "iv", "auth_tag", "encrypted_data_key", "algorithm", "envelope_version", "encryption_key_id") IN (0, 7)
  ),
  ADD CONSTRAINT "change_request_items_value_matches_operation_chk" CHECK (("operation" = 'DELETE') = ("ciphertext" IS NULL)),
  ADD CONSTRAINT "change_request_items_target_matches_operation_chk" CHECK (("operation" = 'CREATE') = ("secret_id" IS NULL)),
  ADD CONSTRAINT "change_request_items_iv_len_chk" CHECK ("iv" IS NULL OR octet_length("iv") = 12),
  ADD CONSTRAINT "change_request_items_auth_tag_len_chk" CHECK ("auth_tag" IS NULL OR octet_length("auth_tag") = 16);

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_actor_user_chk" CHECK (("actor_type" = 'USER') = ("actor_user_id" IS NOT NULL)),
  ADD CONSTRAINT "audit_events_actor_service_identity_chk" CHECK (("actor_type" = 'SERVICE_IDENTITY') = ("actor_service_identity_id" IS NOT NULL)),
  ADD CONSTRAINT "audit_events_action_format_chk" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "audit_events_metadata_chk" CHECK (jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 16384);

ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_config_chk" CHECK (jsonb_typeof("config") = 'object'),
  ADD CONSTRAINT "integration_connections_credential_complete_chk" CHECK (
    num_nulls(
      "credential_ciphertext", "credential_iv", "credential_auth_tag", "credential_encrypted_data_key",
      "credential_algorithm", "credential_envelope_version", "encryption_key_id"
    ) IN (0, 7)
  );

ALTER TABLE "integration_sync_jobs"
  ADD CONSTRAINT "integration_sync_jobs_attempt_chk" CHECK ("attempt" >= 0),
  ADD CONSTRAINT "integration_sync_jobs_timing_chk" CHECK ("finished_at" IS NULL OR ("started_at" IS NOT NULL AND "finished_at" >= "started_at"));

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_data_chk" CHECK (jsonb_typeof("data") = 'object');

-- =============================================================================
-- 2. Partial / expression unique indexes (uniqueness among live rows)
-- =============================================================================

CREATE UNIQUE INDEX "workspaces_slug_live_key" ON "workspaces" ("slug") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "projects_workspace_slug_live_key" ON "projects" ("workspace_id", "slug") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "environments_project_slug_live_key" ON "environments" ("project_id", "slug") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "environments_project_name_live_key" ON "environments" ("project_id", lower("name")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "secrets_environment_key_live_key" ON "secrets" ("environment_id", "key") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "service_identities_workspace_name_live_key" ON "service_identities" ("workspace_id", lower("name")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "workspace_invitations_pending_email_key" ON "workspace_invitations" ("workspace_id", "email") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "encryption_keys_one_active_key" ON "encryption_keys" ("workspace_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "environment_templates_one_default_key" ON "environment_templates" ("workspace_id") WHERE "is_default";

-- =============================================================================
-- 3. Immutable columns
--    Rows can never move between tenants (or projects), and the cryptographic
--    payload of a secret version can never be rewritten.
-- =============================================================================

CREATE FUNCTION "envvault_reject_immutable_column_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION 'column %.% is immutable', TG_TABLE_NAME, col
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "roles_immutable" BEFORE UPDATE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'scope');
CREATE TRIGGER "workspace_memberships_immutable" BEFORE UPDATE ON "workspace_memberships"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'user_id');
CREATE TRIGGER "workspace_invitations_immutable" BEFORE UPDATE ON "workspace_invitations"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'token_hash');
CREATE TRIGGER "projects_immutable" BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id');
CREATE TRIGGER "project_memberships_immutable" BEFORE UPDATE ON "project_memberships"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'project_id', 'workspace_membership_id');
CREATE TRIGGER "environments_immutable" BEFORE UPDATE ON "environments"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'project_id');
CREATE TRIGGER "environment_templates_immutable" BEFORE UPDATE ON "environment_templates"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id');
CREATE TRIGGER "encryption_keys_immutable" BEFORE UPDATE ON "encryption_keys"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'version', 'kms_provider', 'kms_key_ref');
CREATE TRIGGER "secrets_immutable" BEFORE UPDATE ON "secrets"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'project_id', 'environment_id', 'created_by_user_id', 'created_by_service_identity_id', 'created_at'
  );
-- Only the wrapped data key (and its key reference) may change, for re-wrapping.
CREATE TRIGGER "secret_versions_immutable" BEFORE UPDATE ON "secret_versions"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'secret_id', 'version_number', 'ciphertext', 'iv', 'auth_tag', 'algorithm',
    'envelope_version', 'created_by_user_id', 'created_by_service_identity_id', 'created_at'
  );
CREATE TRIGGER "secret_rotation_policies_immutable" BEFORE UPDATE ON "secret_rotation_policies"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'secret_id');
CREATE TRIGGER "service_identities_immutable" BEFORE UPDATE ON "service_identities"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'project_id');
CREATE TRIGGER "service_credentials_immutable" BEFORE UPDATE ON "service_credentials"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'service_identity_id', 'type', 'token_prefix', 'secret_hash', 'hash_algorithm'
  );
CREATE TRIGGER "access_policies_immutable" BEFORE UPDATE ON "access_policies"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'project_id', 'environment_id', 'workspace_membership_id', 'service_identity_id'
  );
CREATE TRIGGER "change_requests_immutable" BEFORE UPDATE ON "change_requests"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'project_id', 'environment_id', 'requested_by_id');
CREATE TRIGGER "change_request_items_immutable" BEFORE UPDATE ON "change_request_items"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'change_request_id', 'operation', 'secret_id', 'secret_key', 'ciphertext', 'iv', 'auth_tag', 'encrypted_data_key'
  );
CREATE TRIGGER "change_approvals_immutable" BEFORE UPDATE ON "change_approvals"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'change_request_id', 'reviewer_id');
CREATE TRIGGER "integration_connections_immutable" BEFORE UPDATE ON "integration_connections"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('workspace_id', 'project_id', 'provider');
CREATE TRIGGER "integration_sync_jobs_immutable" BEFORE UPDATE ON "integration_sync_jobs"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"(
    'workspace_id', 'integration_connection_id', 'project_id', 'environment_id'
  );
CREATE TRIGGER "notifications_immutable" BEFORE UPDATE ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('recipient_id', 'workspace_id');

-- =============================================================================
-- 4. Role scope: a role can only be assigned where its scope allows.
-- =============================================================================

CREATE FUNCTION "envvault_assert_role_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual "RoleScope";
BEGIN
  SELECT "scope" INTO actual FROM "roles" WHERE "id" = NEW."role_id";
  -- A missing role is reported by the foreign key constraint instead.
  IF actual IS NOT NULL AND actual::text <> TG_ARGV[0] THEN
    RAISE EXCEPTION '%.role_id must reference a % role (got %)', TG_TABLE_NAME, TG_ARGV[0], actual
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workspace_memberships_role_scope" BEFORE INSERT OR UPDATE OF "role_id" ON "workspace_memberships"
  FOR EACH ROW EXECUTE FUNCTION "envvault_assert_role_scope"('WORKSPACE');
CREATE TRIGGER "workspace_invitations_role_scope" BEFORE INSERT OR UPDATE OF "role_id" ON "workspace_invitations"
  FOR EACH ROW EXECUTE FUNCTION "envvault_assert_role_scope"('WORKSPACE');
CREATE TRIGGER "project_memberships_role_scope" BEFORE INSERT OR UPDATE OF "role_id" ON "project_memberships"
  FOR EACH ROW EXECUTE FUNCTION "envvault_assert_role_scope"('PROJECT');
CREATE TRIGGER "access_policies_role_scope" BEFORE INSERT OR UPDATE OF "role_id" ON "access_policies"
  FOR EACH ROW EXECUTE FUNCTION "envvault_assert_role_scope"('ENVIRONMENT');

-- =============================================================================
-- 5. Separation of duties: requesters cannot review their own change requests.
-- =============================================================================

CREATE FUNCTION "envvault_reject_self_approval"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "change_requests"
    WHERE "id" = NEW."change_request_id" AND "requested_by_id" = NEW."reviewer_id"
  ) THEN
    RAISE EXCEPTION 'a change request cannot be reviewed by its requester'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_approvals_no_self_approval" BEFORE INSERT ON "change_approvals"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_self_approval"();

-- =============================================================================
-- 6. Append-only audit trail. Retention purges must go through a dedicated
--    maintenance procedure (e.g. partition drop) run by a privileged role.
-- =============================================================================

CREATE FUNCTION "envvault_reject_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_audit_mutation"();
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "envvault_reject_audit_mutation"();
