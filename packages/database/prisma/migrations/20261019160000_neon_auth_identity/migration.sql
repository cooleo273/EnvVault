-- Neon Auth identity integration.
--
-- Neon Auth (managed Better Auth) owns authentication: users, passwords,
-- sessions and verification tokens live in the Neon-managed `neon_auth`
-- schema. This migration only changes EnvVault's own tables in `public`:
-- it links application profiles to Neon Auth identities and adds token
-- revocation and step-up state. It never reads or modifies `neon_auth`.

-- CreateEnum
CREATE TYPE "AuthRevocationReason" AS ENUM ('LOGOUT', 'LOGOUT_ALL_DEVICES', 'PASSWORD_CHANGED', 'ACCOUNT_DISABLED');

-- CreateEnum
CREATE TYPE "StepUpMethod" AS ENUM ('PASSWORD');

-- DropIndex
DROP INDEX "users_email_key";

-- AlterTable: add the identity link, backfilling pre-existing profiles with a
-- placeholder that can never match a Neon Auth user id (those contain no ':').
-- Backfilled profiles cannot sign in until re-linked by an operator.
ALTER TABLE "users" ADD COLUMN "auth_user_id" VARCHAR(255);
UPDATE "users" SET "auth_user_id" = 'legacy:' || "id"::text WHERE "auth_user_id" IS NULL;
ALTER TABLE "users" ALTER COLUMN "auth_user_id" SET NOT NULL;

-- CreateTable
CREATE TABLE "auth_token_revocations" (
    "user_id" UUID NOT NULL,
    "not_before" TIMESTAMPTZ(3) NOT NULL,
    "reason" "AuthRevocationReason" NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_token_revocations_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "auth_step_up_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" "StepUpMethod" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_step_up_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_step_up_grants_user_id_expires_at_idx" ON "auth_step_up_grants"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_user_id_key" ON "users"("auth_user_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- AddForeignKey
ALTER TABLE "auth_token_revocations" ADD CONSTRAINT "auth_token_revocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_step_up_grants" ADD CONSTRAINT "auth_step_up_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity rules (not expressible in Prisma; ignored by drift detection).
ALTER TABLE "users"
  ADD CONSTRAINT "users_auth_user_id_format_chk" CHECK ("auth_user_id" ~ '^[A-Za-z0-9:._-]{1,255}$');

ALTER TABLE "auth_step_up_grants"
  ADD CONSTRAINT "auth_step_up_grants_lifetime_chk"
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '1 hour');

-- The identity link is permanent: re-pointing a profile (and its memberships)
-- at a different Neon Auth identity would be an account takeover.
CREATE TRIGGER "users_immutable" BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('auth_user_id', 'created_at');
