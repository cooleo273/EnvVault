-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('WORKSPACE', 'PROJECT', 'ENVIRONMENT');

-- CreateEnum
CREATE TYPE "PolicyEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "EnvironmentKind" AS ENUM ('DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION', 'OTHER');

-- CreateEnum
CREATE TYPE "SecretType" AS ENUM ('GENERIC', 'API_KEY', 'PASSWORD', 'CONNECTION_STRING', 'CERTIFICATE', 'PRIVATE_KEY', 'JSON');

-- CreateEnum
CREATE TYPE "EncryptionAlgorithm" AS ENUM ('AES_256_GCM');

-- CreateEnum
CREATE TYPE "EncryptionKeyStatus" AS ENUM ('ACTIVE', 'DECRYPT_ONLY', 'RETIRED');

-- CreateEnum
CREATE TYPE "ServiceIdentityStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('API_TOKEN', 'OIDC_FEDERATION');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'APPLIED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SecretChangeOperation" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SERVICE_IDENTITY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('GITHUB', 'GITLAB', 'VERCEL', 'NETLIFY', 'AWS_SECRETS_MANAGER', 'KUBERNETES');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'SECRET_CHANGED');

-- CreateEnum
CREATE TYPE "RotationStrategy" AS ENUM ('MANUAL_REMINDER', 'INTEGRATION');

-- CreateTable
CREATE TABLE "service_identities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "status" "ServiceIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "service_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_credentials" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "service_identity_id" UUID NOT NULL,
    "type" "CredentialType" NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "token_prefix" VARCHAR(32),
    "secret_hash" BYTEA,
    "hash_algorithm" VARCHAR(32),
    "oidc_issuer" VARCHAR(2048),
    "oidc_subject" VARCHAR(512),
    "oidc_audience" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "revocation_reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "workspace_membership_id" UUID,
    "service_identity_id" UUID,
    "role_id" UUID NOT NULL,
    "effect" "PolicyEffect" NOT NULL DEFAULT 'ALLOW',
    "expires_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "access_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(5000),
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "required_approvals" INTEGER NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "applied_by_id" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_request_items" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "operation" "SecretChangeOperation" NOT NULL,
    "secret_id" UUID,
    "secret_key" VARCHAR(256) NOT NULL,
    "secret_type" "SecretType",
    "description" VARCHAR(1000),
    "ciphertext" BYTEA,
    "iv" BYTEA,
    "auth_tag" BYTEA,
    "encrypted_data_key" BYTEA,
    "algorithm" "EncryptionAlgorithm",
    "envelope_version" INTEGER,
    "encryption_key_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_approvals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "comment" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_user_id" UUID,
    "actor_service_identity_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "resource_type" VARCHAR(50) NOT NULL,
    "resource_id" UUID,
    "project_id" UUID,
    "environment_id" UUID,
    "request_id" VARCHAR(128),
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "display_name" VARCHAR(120),
    "avatar_url" VARCHAR(2048),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "resource" VARCHAR(50) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "scope" "RoleScope" NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "workspace_memberships" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_invitations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "invited_by_id" UUID,
    "accepted_by_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "provider" "IntegrationProvider" NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB NOT NULL DEFAULT '{}',
    "external_account_id" VARCHAR(255),
    "credential_ciphertext" BYTEA,
    "credential_iv" BYTEA,
    "credential_auth_tag" BYTEA,
    "credential_encrypted_data_key" BYTEA,
    "credential_algorithm" "EncryptionAlgorithm",
    "credential_envelope_version" INTEGER,
    "encryption_key_id" UUID,
    "created_by_id" UUID,
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "integration_connection_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "SyncTrigger" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "workspace_id" UUID,
    "type" VARCHAR(100) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(2000),
    "data" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "description" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_memberships" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workspace_membership_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "kind" "EnvironmentKind" NOT NULL DEFAULT 'OTHER',
    "description" VARCHAR(1000),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "required_approvals" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "environments" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "environment_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encryption_keys" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kms_provider" VARCHAR(32) NOT NULL,
    "kms_key_ref" VARCHAR(2048) NOT NULL,
    "status" "EncryptionKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "encryption_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secrets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "key" VARCHAR(256) NOT NULL,
    "description" VARCHAR(1000),
    "type" "SecretType" NOT NULL DEFAULT 'GENERIC',
    "current_version_id" UUID,
    "latest_version_number" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID,
    "created_by_service_identity_id" UUID,
    "updated_by_user_id" UUID,
    "updated_by_service_identity_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "secret_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "encrypted_data_key" BYTEA NOT NULL,
    "algorithm" "EncryptionAlgorithm" NOT NULL DEFAULT 'AES_256_GCM',
    "envelope_version" INTEGER NOT NULL DEFAULT 1,
    "encryption_key_id" UUID NOT NULL,
    "kms_key_version" VARCHAR(255),
    "rewrapped_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "created_by_service_identity_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secret_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_rotation_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "secret_id" UUID NOT NULL,
    "strategy" "RotationStrategy" NOT NULL DEFAULT 'MANUAL_REMINDER',
    "interval_days" INTEGER NOT NULL,
    "integration_connection_id" UUID,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_rotated_at" TIMESTAMPTZ(3),
    "next_rotation_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "secret_rotation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_identities_project_id_idx" ON "service_identities"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_identities_workspace_id_id_key" ON "service_identities"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_credentials_token_prefix_key" ON "service_credentials"("token_prefix");

-- CreateIndex
CREATE INDEX "service_credentials_service_identity_id_idx" ON "service_credentials"("service_identity_id");

-- CreateIndex
CREATE INDEX "service_credentials_oidc_issuer_oidc_subject_idx" ON "service_credentials"("oidc_issuer", "oidc_subject");

-- CreateIndex
CREATE INDEX "access_policies_workspace_membership_id_idx" ON "access_policies"("workspace_membership_id");

-- CreateIndex
CREATE INDEX "access_policies_service_identity_id_idx" ON "access_policies"("service_identity_id");

-- CreateIndex
CREATE INDEX "access_policies_role_id_idx" ON "access_policies"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_policies_environment_id_workspace_membership_id_role_key" ON "access_policies"("environment_id", "workspace_membership_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_policies_environment_id_service_identity_id_role_id_key" ON "access_policies"("environment_id", "service_identity_id", "role_id");

-- CreateIndex
CREATE INDEX "change_requests_environment_id_status_idx" ON "change_requests"("environment_id", "status");

-- CreateIndex
CREATE INDEX "change_requests_requested_by_id_idx" ON "change_requests"("requested_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "change_requests_workspace_id_id_key" ON "change_requests"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "change_request_items_secret_id_idx" ON "change_request_items"("secret_id");

-- CreateIndex
CREATE INDEX "change_request_items_encryption_key_id_idx" ON "change_request_items"("encryption_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "change_request_items_change_request_id_secret_key_key" ON "change_request_items"("change_request_id", "secret_key");

-- CreateIndex
CREATE INDEX "change_approvals_reviewer_id_idx" ON "change_approvals"("reviewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "change_approvals_change_request_id_reviewer_id_key" ON "change_approvals"("change_request_id", "reviewer_id");

-- CreateIndex
CREATE INDEX "audit_events_workspace_id_occurred_at_idx" ON "audit_events"("workspace_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_workspace_id_resource_type_resource_id_idx" ON "audit_events"("workspace_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_occurred_at_idx" ON "audit_events"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_service_identity_id_occurred_at_idx" ON "audit_events"("actor_service_identity_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "workspaces_created_by_id_idx" ON "workspaces"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_workspace_id_key_key" ON "roles"("workspace_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_workspace_id_id_key" ON "roles"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "workspace_memberships_user_id_idx" ON "workspace_memberships"("user_id");

-- CreateIndex
CREATE INDEX "workspace_memberships_role_id_idx" ON "workspace_memberships"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_memberships_workspace_id_user_id_key" ON "workspace_memberships"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_memberships_workspace_id_id_key" ON "workspace_memberships"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invitations_token_hash_key" ON "workspace_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_invitations_workspace_id_status_idx" ON "workspace_invitations"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "workspace_invitations_email_idx" ON "workspace_invitations"("email");

-- CreateIndex
CREATE INDEX "workspace_invitations_role_id_idx" ON "workspace_invitations"("role_id");

-- CreateIndex
CREATE INDEX "integration_connections_project_id_idx" ON "integration_connections"("project_id");

-- CreateIndex
CREATE INDEX "integration_connections_encryption_key_id_idx" ON "integration_connections"("encryption_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_workspace_id_id_key" ON "integration_connections"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_workspace_id_provider_name_key" ON "integration_connections"("workspace_id", "provider", "name");

-- CreateIndex
CREATE INDEX "integration_sync_jobs_integration_connection_id_created_at_idx" ON "integration_sync_jobs"("integration_connection_id", "created_at");

-- CreateIndex
CREATE INDEX "integration_sync_jobs_environment_id_idx" ON "integration_sync_jobs"("environment_id");

-- CreateIndex
CREATE INDEX "integration_sync_jobs_status_scheduled_at_idx" ON "integration_sync_jobs"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_read_at_created_at_idx" ON "notifications"("recipient_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_workspace_id_idx" ON "notifications"("workspace_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_idx" ON "projects"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_id_key" ON "projects"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "project_memberships_workspace_membership_id_idx" ON "project_memberships"("workspace_membership_id");

-- CreateIndex
CREATE INDEX "project_memberships_role_id_idx" ON "project_memberships"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_memberships_project_id_workspace_membership_id_key" ON "project_memberships"("project_id", "workspace_membership_id");

-- CreateIndex
CREATE INDEX "environments_project_id_idx" ON "environments"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "environments_workspace_id_id_key" ON "environments"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "environments_workspace_id_project_id_id_key" ON "environments"("workspace_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "environment_templates_workspace_id_name_key" ON "environment_templates"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "encryption_keys_workspace_id_version_key" ON "encryption_keys"("workspace_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "encryption_keys_workspace_id_id_key" ON "encryption_keys"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_current_version_id_key" ON "secrets"("current_version_id");

-- CreateIndex
CREATE INDEX "secrets_environment_id_idx" ON "secrets"("environment_id");

-- CreateIndex
CREATE INDEX "secrets_workspace_id_project_id_idx" ON "secrets"("workspace_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_workspace_id_id_key" ON "secrets"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_id_current_version_id_key" ON "secrets"("id", "current_version_id");

-- CreateIndex
CREATE INDEX "secret_versions_encryption_key_id_idx" ON "secret_versions"("encryption_key_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_versions_secret_id_version_number_key" ON "secret_versions"("secret_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "secret_versions_secret_id_id_key" ON "secret_versions"("secret_id", "id");

-- CreateIndex
CREATE INDEX "secret_rotation_policies_is_enabled_next_rotation_at_idx" ON "secret_rotation_policies"("is_enabled", "next_rotation_at");

-- CreateIndex
CREATE INDEX "secret_rotation_policies_integration_connection_id_idx" ON "secret_rotation_policies"("integration_connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "secret_rotation_policies_workspace_id_secret_id_key" ON "secret_rotation_policies"("workspace_id", "secret_id");

-- AddForeignKey
ALTER TABLE "service_identities" ADD CONSTRAINT "service_identities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_identities" ADD CONSTRAINT "service_identities_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_identities" ADD CONSTRAINT "service_identities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_service_identity_fkey" FOREIGN KEY ("workspace_id", "service_identity_id") REFERENCES "service_identities"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_member_fkey" FOREIGN KEY ("workspace_id", "workspace_membership_id") REFERENCES "workspace_memberships"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_service_identity_fkey" FOREIGN KEY ("workspace_id", "service_identity_id") REFERENCES "service_identities"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_role_fkey" FOREIGN KEY ("workspace_id", "role_id") REFERENCES "roles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_applied_by_id_fkey" FOREIGN KEY ("applied_by_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_items" ADD CONSTRAINT "change_request_items_change_request_fkey" FOREIGN KEY ("workspace_id", "change_request_id") REFERENCES "change_requests"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_items" ADD CONSTRAINT "change_request_items_secret_fkey" FOREIGN KEY ("workspace_id", "secret_id") REFERENCES "secrets"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_items" ADD CONSTRAINT "change_request_items_encryption_key_fkey" FOREIGN KEY ("workspace_id", "encryption_key_id") REFERENCES "encryption_keys"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_approvals" ADD CONSTRAINT "change_approvals_change_request_fkey" FOREIGN KEY ("workspace_id", "change_request_id") REFERENCES "change_requests"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_approvals" ADD CONSTRAINT "change_approvals_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_role_fkey" FOREIGN KEY ("workspace_id", "role_id") REFERENCES "roles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_role_fkey" FOREIGN KEY ("workspace_id", "role_id") REFERENCES "roles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_encryption_key_fkey" FOREIGN KEY ("workspace_id", "encryption_key_id") REFERENCES "encryption_keys"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_integration_fkey" FOREIGN KEY ("workspace_id", "integration_connection_id") REFERENCES "integration_connections"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "integration_sync_jobs_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_member_fkey" FOREIGN KEY ("workspace_id", "workspace_membership_id") REFERENCES "workspace_memberships"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_role_fkey" FOREIGN KEY ("workspace_id", "role_id") REFERENCES "roles"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_templates" ADD CONSTRAINT "environment_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encryption_keys" ADD CONSTRAINT "encryption_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_environment_fkey" FOREIGN KEY ("workspace_id", "project_id", "environment_id") REFERENCES "environments"("workspace_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_current_version_fkey" FOREIGN KEY ("id", "current_version_id") REFERENCES "secret_versions"("secret_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_service_identity_fkey" FOREIGN KEY ("workspace_id", "created_by_service_identity_id") REFERENCES "service_identities"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_updated_by_service_identity_fkey" FOREIGN KEY ("workspace_id", "updated_by_service_identity_id") REFERENCES "service_identities"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_secret_fkey" FOREIGN KEY ("workspace_id", "secret_id") REFERENCES "secrets"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_encryption_key_fkey" FOREIGN KEY ("workspace_id", "encryption_key_id") REFERENCES "encryption_keys"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_created_by_service_identity_fkey" FOREIGN KEY ("workspace_id", "created_by_service_identity_id") REFERENCES "service_identities"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_rotation_policies" ADD CONSTRAINT "secret_rotation_policies_secret_fkey" FOREIGN KEY ("workspace_id", "secret_id") REFERENCES "secrets"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_rotation_policies" ADD CONSTRAINT "secret_rotation_policies_integration_fkey" FOREIGN KEY ("workspace_id", "integration_connection_id") REFERENCES "integration_connections"("workspace_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_rotation_policies" ADD CONSTRAINT "secret_rotation_policies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
