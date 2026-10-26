-- Phase 4A: browser approved CLI sign in and CLI sessions.
--
-- Review notes
-- - Additive: two new tables, their indexes, constraints and foreign keys.
--   No existing table or row changes.
-- - Only SHA-256 hashes of device codes and tokens are stored. They are 256
--   bit random values, so a hash cannot be reversed by guessing; a database
--   reader cannot use them.
-- - Prisma does not wrap a migration in a transaction, so this script does.

BEGIN;

CREATE TABLE "cli_device_grants" (
    "id" UUID NOT NULL,
    "device_code_hash" BYTEA NOT NULL,
    "user_code" VARCHAR(9) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "client_version" VARCHAR(32) NOT NULL,
    "hostname" VARCHAR(255) NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "requested_ip" INET,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "last_polled_at" TIMESTAMPTZ(3),

    CONSTRAINT "cli_device_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cli_device_grants_device_code_hash_key" ON "cli_device_grants"("device_code_hash");
-- A code identifies one open request at a time.
CREATE UNIQUE INDEX "cli_device_grants_pending_user_code_key" ON "cli_device_grants"("user_code") WHERE "status" = 'pending';
CREATE INDEX "cli_device_grants_expires_at_idx" ON "cli_device_grants"("expires_at");

ALTER TABLE "cli_device_grants" ADD CONSTRAINT "cli_device_grants_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cli_device_grants"
  ADD CONSTRAINT "cli_device_grants_status_chk" CHECK ("status" IN ('pending', 'approved', 'denied', 'consumed')),
  ADD CONSTRAINT "cli_device_grants_hash_chk" CHECK (octet_length("device_code_hash") = 32),
  ADD CONSTRAINT "cli_device_grants_user_code_chk" CHECK ("user_code" ~ '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$'),
  ADD CONSTRAINT "cli_device_grants_decision_chk" CHECK (
    ("status" = 'pending') = ("decided_at" IS NULL)
    AND ("status" IN ('approved', 'consumed')) = ("user_id" IS NOT NULL)
  );

CREATE TABLE "cli_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_grant_id" UUID,
    "client_version" VARCHAR(32) NOT NULL,
    "hostname" VARCHAR(255) NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "access_token_hash" BYTEA NOT NULL,
    "access_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "refresh_token_hash" BYTEA NOT NULL,
    "previous_refresh_token_hash" BYTEA,
    "refresh_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(32),

    CONSTRAINT "cli_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cli_sessions_access_token_hash_key" ON "cli_sessions"("access_token_hash");
CREATE UNIQUE INDEX "cli_sessions_refresh_token_hash_key" ON "cli_sessions"("refresh_token_hash");
CREATE INDEX "cli_sessions_previous_refresh_token_hash_idx" ON "cli_sessions"("previous_refresh_token_hash");
CREATE INDEX "cli_sessions_user_id_idx" ON "cli_sessions"("user_id", "created_at");

ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_device_grant_fkey"
  FOREIGN KEY ("device_grant_id") REFERENCES "cli_device_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cli_sessions"
  ADD CONSTRAINT "cli_sessions_hash_chk" CHECK (
    octet_length("access_token_hash") = 32 AND octet_length("refresh_token_hash") = 32
    AND ("previous_refresh_token_hash" IS NULL OR octet_length("previous_refresh_token_hash") = 32)
  ),
  ADD CONSTRAINT "cli_sessions_revoked_chk" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL)),
  ADD CONSTRAINT "cli_sessions_reason_chk" CHECK ("revoked_reason" IS NULL OR "revoked_reason" ~ '^[a-z_]{1,32}$'),
  ADD CONSTRAINT "cli_sessions_expiry_chk" CHECK ("access_expires_at" <= "expires_at" AND "refresh_expires_at" <= "expires_at");

COMMIT;
