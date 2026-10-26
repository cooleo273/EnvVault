-- Phase 3E: audit seals, retention, maintenance jobs and idempotency.
--
-- Review notes
-- - Additive: five new tables, indexes, CHECK constraints and triggers. No
--   existing column changes and no row is rewritten.
-- - The audit trigger function is replaced so a retention purge can delete
--   old audit events and their seals inside one transaction that sets the
--   `envvault.retention_purge` setting. Updates and TRUNCATE stay rejected.
--   Anyone who can run SQL as the table owner can still set it or drop the
--   triggers; the seals (MACs under a key outside the database) are what
--   detect such changes.
-- - Prisma does not wrap a migration in a transaction, so this script does.

BEGIN;

-- ---------------------------------------------------------------- audit seals

CREATE TABLE "audit_seals" (
    "chain_id" VARCHAR(36) NOT NULL,
    "seq" BIGINT NOT NULL,
    "event_id" UUID NOT NULL,
    "key_id" VARCHAR(32) NOT NULL,
    "mac" BYTEA NOT NULL,
    "sealed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_seals_pkey" PRIMARY KEY ("chain_id", "seq")
);

CREATE UNIQUE INDEX "audit_seals_event_id_key" ON "audit_seals"("event_id");

ALTER TABLE "audit_seals" ADD CONSTRAINT "audit_seals_event_fkey"
  FOREIGN KEY ("event_id") REFERENCES "audit_events"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "audit_seals"
  ADD CONSTRAINT "audit_seals_seq_chk" CHECK ("seq" >= 1),
  ADD CONSTRAINT "audit_seals_mac_chk" CHECK (octet_length("mac") = 32),
  ADD CONSTRAINT "audit_seals_chain_chk" CHECK ("chain_id" ~ '^(platform|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  ADD CONSTRAINT "audit_seals_key_chk" CHECK ("key_id" ~ '^ik-[0-9a-f]{16}$');

-- The last seal removed by a retention purge, so verification of what
-- remains can start from a known MAC instead of the beginning of the chain.
CREATE TABLE "audit_seal_checkpoints" (
    "chain_id" VARCHAR(36) NOT NULL,
    "seq" BIGINT NOT NULL,
    "key_id" VARCHAR(32) NOT NULL,
    "mac" BYTEA NOT NULL,
    "reason" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_seal_checkpoints_pkey" PRIMARY KEY ("chain_id", "seq")
);

ALTER TABLE "audit_seal_checkpoints"
  ADD CONSTRAINT "audit_seal_checkpoints_mac_chk" CHECK (octet_length("mac") = 32),
  ADD CONSTRAINT "audit_seal_checkpoints_reason_chk" CHECK ("reason" ~ '^[a-z_]{1,50}$');

-- Finding unsealed events scans a recent window in time order.
CREATE INDEX "audit_events_occurred_at_id_idx" ON "audit_events"("occurred_at", "id");

CREATE OR REPLACE FUNCTION "envvault_reject_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('envvault.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "audit_seals_append_only" BEFORE UPDATE OR DELETE ON "audit_seals"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_audit_mutation"();
CREATE TRIGGER "audit_seals_no_truncate" BEFORE TRUNCATE ON "audit_seals"
  FOR EACH STATEMENT EXECUTE FUNCTION "envvault_reject_audit_mutation"();
CREATE TRIGGER "audit_seal_checkpoints_append_only" BEFORE UPDATE OR DELETE ON "audit_seal_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_audit_mutation"();

-- ----------------------------------------------------------------- retention

CREATE TABLE "retention_policies" (
    "workspace_id" UUID NOT NULL,
    "deleted_secret_days" INTEGER,
    "version_keep_count" INTEGER,
    "version_min_age_days" INTEGER,
    "snapshot_days" INTEGER,
    "audit_days" INTEGER,
    "include_protected" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_updated_by_user_id_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "retention_policies"
  ADD CONSTRAINT "retention_policies_deleted_secret_days_chk" CHECK ("deleted_secret_days" IS NULL OR "deleted_secret_days" BETWEEN 1 AND 3650),
  ADD CONSTRAINT "retention_policies_version_keep_count_chk" CHECK ("version_keep_count" IS NULL OR "version_keep_count" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "retention_policies_version_min_age_days_chk" CHECK ("version_min_age_days" IS NULL OR "version_min_age_days" BETWEEN 0 AND 3650),
  ADD CONSTRAINT "retention_policies_version_pair_chk" CHECK ("version_min_age_days" IS NULL OR "version_keep_count" IS NOT NULL),
  ADD CONSTRAINT "retention_policies_snapshot_days_chk" CHECK ("snapshot_days" IS NULL OR "snapshot_days" BETWEEN 1 AND 3650),
  ADD CONSTRAINT "retention_policies_audit_days_chk" CHECK ("audit_days" IS NULL OR "audit_days" BETWEEN 90 AND 3650);

CREATE INDEX "secrets_deleted_at_idx" ON "secrets"("workspace_id", "deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "environment_snapshots_created_at_idx" ON "environment_snapshots"("workspace_id", "created_at");

-- ---------------------------------------------------------- maintenance jobs

CREATE TABLE "maintenance_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "requested_by_user_id" UUID,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "maintenance_jobs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "maintenance_jobs" ADD CONSTRAINT "maintenance_jobs_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "maintenance_jobs" ADD CONSTRAINT "maintenance_jobs_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "maintenance_jobs"
  ADD CONSTRAINT "maintenance_jobs_kind_chk" CHECK ("kind" IN ('retention')),
  ADD CONSTRAINT "maintenance_jobs_status_chk" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  ADD CONSTRAINT "maintenance_jobs_parameters_chk" CHECK (jsonb_typeof("parameters") = 'object' AND pg_column_size("parameters") <= 16384),
  ADD CONSTRAINT "maintenance_jobs_progress_chk" CHECK (jsonb_typeof("progress") = 'object' AND pg_column_size("progress") <= 16384),
  ADD CONSTRAINT "maintenance_jobs_error_code_chk" CHECK ("error_code" IS NULL OR "error_code" ~ '^[A-Z_]{1,64}$');

CREATE INDEX "maintenance_jobs_status_created_at_idx" ON "maintenance_jobs"("status", "created_at");
-- At most one queued or running job of a kind per workspace.
CREATE UNIQUE INDEX "maintenance_jobs_active_key" ON "maintenance_jobs"("workspace_id", "kind")
  WHERE "status" IN ('queued', 'running');

-- --------------------------------------------------------------- idempotency

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "method" VARCHAR(8) NOT NULL,
    "route" VARCHAR(300) NOT NULL,
    "fingerprint" BYTEA NOT NULL,
    "key_id" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_user_key_key" ON "idempotency_records"("user_id", "idempotency_key");
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_key_chk" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'),
  ADD CONSTRAINT "idempotency_records_method_chk" CHECK ("method" IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  ADD CONSTRAINT "idempotency_records_fingerprint_chk" CHECK (octet_length("fingerprint") = 32),
  ADD CONSTRAINT "idempotency_records_status_chk" CHECK ("status" IN ('pending', 'completed')),
  ADD CONSTRAINT "idempotency_records_response_chk" CHECK (
    ("status" = 'completed') = ("response_status" IS NOT NULL)
    AND ("response_body" IS NULL OR pg_column_size("response_body") <= 262144)
  );

-- ----------------------------------------------------- key rotation queries

CREATE INDEX "secret_versions_key_version_idx" ON "secret_versions"("encryption_key_id", "kms_key_version");

COMMIT;
