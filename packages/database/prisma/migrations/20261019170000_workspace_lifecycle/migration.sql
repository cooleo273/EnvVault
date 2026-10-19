-- Phase 1: workspace lifecycle (description, type, archive), last-opened
-- workspace preference and declined invitations. Additive only: new enum,
-- new enum value, nullable columns and one column with a default.
-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('PERSONAL', 'TEAM');

-- AlterEnum
ALTER TYPE "InvitationStatus" ADD VALUE 'DECLINED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_workspace_id" UUID;

-- AlterTable
ALTER TABLE "workspace_invitations" ADD COLUMN     "declined_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "description" VARCHAR(500),
ADD COLUMN     "type" "WorkspaceType" NOT NULL DEFAULT 'TEAM';

-- CreateIndex
CREATE INDEX "users_last_workspace_id_idx" ON "users"("last_workspace_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_last_workspace_id_fkey" FOREIGN KEY ("last_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

