-- Phase 1: integrity rules for the workspace lifecycle. Separate from the
-- previous migration because PostgreSQL cannot use an enum value ('DECLINED')
-- in the transaction that adds it. Constraints only; no data is changed.

-- Value checks ----------------------------------------------------------------

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_description_not_blank_chk"
    CHECK ("description" IS NULL OR length(btrim("description")) > 0);

ALTER TABLE "workspace_invitations"
  ADD CONSTRAINT "workspace_invitations_declined_chk"
    CHECK ("status" <> 'DECLINED' OR "declined_at" IS NOT NULL);

-- Every live workspace keeps at least one ACTIVE owner -----------------------
--
-- Deferred to commit so that ownership transfer (promote the new owner,
-- demote the old one) can run as two statements in one transaction. The
-- workspace row is locked first, so concurrent transactions that each remove
-- a different owner serialise and the second one sees the first's change.
-- Soft-deleted and purged workspaces are exempt (cascading deletes).

CREATE OR REPLACE FUNCTION "envvault_ensure_workspace_has_owner"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "workspaces"
    WHERE "id" = OLD."workspace_id" AND "deleted_at" IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_memberships" m
    JOIN "roles" r ON r."id" = m."role_id"
    WHERE m."workspace_id" = OLD."workspace_id"
      AND m."status" = 'ACTIVE'
      AND r."key" = 'owner'
  ) THEN
    RAISE EXCEPTION 'update or delete on "workspace_memberships" violates constraint "workspace_memberships_last_owner"'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "workspace_memberships_last_owner"
  AFTER UPDATE OR DELETE ON "workspace_memberships"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "envvault_ensure_workspace_has_owner"();
