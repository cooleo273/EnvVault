-- Phase 2: project and environment lifecycle (status, archive), visual identifiers,
-- creator references, expected keys, favorites, visits and audit indexes.
-- Additive only: new enums, new tables, nullable columns or columns with defaults.
-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EnvironmentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "environments" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "color" VARCHAR(16) NOT NULL DEFAULT 'slate',
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "expected_keys" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "icon" VARCHAR(32),
ADD COLUMN     "status" "EnvironmentStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "color" VARCHAR(16) NOT NULL DEFAULT 'slate',
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "icon" VARCHAR(32) NOT NULL DEFAULT 'folder',
ADD COLUMN     "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "project_favorites" (
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_favorites_pkey" PRIMARY KEY ("user_id","project_id")
);

-- CreateTable
CREATE TABLE "project_visits" (
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "visited_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_visits_pkey" PRIMARY KEY ("user_id","project_id")
);

-- CreateIndex
CREATE INDEX "project_favorites_user_id_workspace_id_idx" ON "project_favorites"("user_id", "workspace_id");

-- CreateIndex
CREATE INDEX "project_visits_user_id_workspace_id_visited_at_idx" ON "project_visits"("user_id", "workspace_id", "visited_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_project_id_occurred_at_idx" ON "audit_events"("project_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_environment_id_occurred_at_idx" ON "audit_events"("environment_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "environments_created_by_id_idx" ON "environments"("created_by_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_status_idx" ON "projects"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "projects_created_by_id_idx" ON "projects"("created_by_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_favorites" ADD CONSTRAINT "project_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_favorites" ADD CONSTRAINT "project_favorites_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_visits" ADD CONSTRAINT "project_visits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_visits" ADD CONSTRAINT "project_visits_project_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- Integrity rules (reviewed by hand; constraints only, no data changes)
-- =============================================================================

-- Lifecycle: archived_at is set exactly while the row is ARCHIVED.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_archive_state_chk"
    CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL)),
  ADD CONSTRAINT "projects_description_not_blank_chk"
    CHECK ("description" IS NULL OR length(btrim("description")) > 0),
  ADD CONSTRAINT "projects_icon_format_chk" CHECK ("icon" ~ '^[a-z0-9-]{1,32}$'),
  ADD CONSTRAINT "projects_color_format_chk" CHECK ("color" ~ '^[a-z]{1,16}$');

ALTER TABLE "environments"
  ADD CONSTRAINT "environments_archive_state_chk"
    CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL)),
  ADD CONSTRAINT "environments_description_not_blank_chk"
    CHECK ("description" IS NULL OR length(btrim("description")) > 0),
  ADD CONSTRAINT "environments_icon_format_chk" CHECK ("icon" IS NULL OR "icon" ~ '^[a-z0-9-]{1,32}$'),
  ADD CONSTRAINT "environments_color_format_chk" CHECK ("color" ~ '^[a-z]{1,16}$'),
  -- Key names only (never values): an array of at most 200 entries.
  ADD CONSTRAINT "environments_expected_keys_chk"
    CHECK (jsonb_typeof("expected_keys") = 'array' AND jsonb_array_length("expected_keys") <= 200);

-- Favorites and visits can never move between users, tenants or projects.
CREATE TRIGGER "project_favorites_immutable" BEFORE UPDATE ON "project_favorites"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('user_id', 'workspace_id', 'project_id');
CREATE TRIGGER "project_visits_immutable" BEFORE UPDATE ON "project_visits"
  FOR EACH ROW EXECUTE FUNCTION "envvault_reject_immutable_column_change"('user_id', 'workspace_id', 'project_id');
