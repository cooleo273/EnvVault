import type { PrismaClient } from '../generated/prisma/client.js';
import type { DbClient } from '../client.js';
import { PERMISSIONS, type PermissionKey } from './permissions.js';
import { SYSTEM_ROLES } from './roles.js';

/**
 * Upserts the permission catalog. Idempotent; run on deploy and by the seed.
 * Permissions removed from code are left in place (they may still be
 * referenced) and should be removed with an explicit migration.
 */
export async function syncPermissionCatalog(db: DbClient): Promise<Map<PermissionKey, string>> {
  const ids = new Map<PermissionKey, string>();
  for (const [key, description] of Object.entries(PERMISSIONS) as [PermissionKey, string][]) {
    const [resource = key, action = key] = key.split(':');
    const permission = await db.permission.upsert({
      where: { key },
      create: { key, resource, action, description },
      update: { description },
      select: { id: true },
    });
    ids.set(key, permission.id);
  }
  return ids;
}

/**
 * Creates or updates the built-in roles of a workspace and aligns their
 * permissions with SYSTEM_ROLES. Must run inside the transaction that creates
 * the workspace. Requires the permission catalog to be synchronised.
 *
 * @returns role ids keyed by role key
 */
export async function provisionSystemRoles(
  db: DbClient,
  workspaceId: string,
): Promise<Map<string, string>> {
  const permissions = await db.permission.findMany({ select: { id: true, key: true } });
  const permissionIds = new Map(permissions.map((p) => [p.key, p.id]));
  const roleIds = new Map<string, string>();

  for (const definition of SYSTEM_ROLES) {
    const role = await db.role.upsert({
      where: { workspaceId_key: { workspaceId, key: definition.key } },
      create: {
        workspaceId,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        scope: definition.scope,
        isSystem: true,
      },
      update: { name: definition.name, description: definition.description },
      select: { id: true },
    });
    roleIds.set(definition.key, role.id);

    const wanted = definition.permissions.map((key) => {
      const id = permissionIds.get(key);
      if (id === undefined) {
        throw new Error(`Permission ${key} is missing; run syncPermissionCatalog first`);
      }
      return id;
    });
    await db.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: wanted } },
    });
    await db.rolePermission.createMany({
      data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }
  return roleIds;
}

/**
 * Inserts any permissions missing from the catalog in one statement. Unlike
 * syncPermissionCatalog it does not update descriptions, so it is cheap
 * enough to run on a request path (e.g. the first workspace ever created).
 */
export async function ensurePermissionCatalog(db: DbClient): Promise<void> {
  await db.permission.createMany({
    data: (Object.entries(PERMISSIONS) as [PermissionKey, string][]).map(([key, description]) => {
      const [resource = key, action = key] = key.split(':');
      return { key, resource, action, description };
    }),
    skipDuplicates: true,
  });
}

/**
 * Creates the built-in roles of a workspace that has none yet, using a
 * constant number of statements (no per-role round trips). Use
 * provisionSystemRoles to realign an existing workspace.
 *
 * @returns role ids keyed by role key
 */
export async function provisionNewWorkspaceRoles(
  db: DbClient,
  workspaceId: string,
): Promise<Map<string, string>> {
  const permissions = await db.permission.findMany({ select: { id: true, key: true } });
  const permissionIds = new Map(permissions.map((p) => [p.key, p.id]));

  const roles = await db.role.createManyAndReturn({
    data: SYSTEM_ROLES.map((definition) => ({
      workspaceId,
      key: definition.key,
      name: definition.name,
      description: definition.description,
      scope: definition.scope,
      isSystem: true,
    })),
    select: { id: true, key: true },
  });
  const roleIds = new Map(roles.map((role) => [role.key, role.id]));

  await db.rolePermission.createMany({
    data: SYSTEM_ROLES.flatMap((definition) => {
      const roleId = roleIds.get(definition.key);
      if (roleId === undefined) throw new Error(`Role ${definition.key} was not created`);
      return definition.permissions.map((key) => {
        const permissionId = permissionIds.get(key);
        if (permissionId === undefined) {
          throw new Error(`Permission ${key} is missing; run ensurePermissionCatalog first`);
        }
        return { roleId, permissionId };
      });
    }),
  });
  return roleIds;
}

/**
 * Aligns the permission catalog and every workspace's built-in roles with
 * code. Idempotent and safe to run on every deploy: it adds missing
 * permissions and roles, and removes built-in-role grants that code no longer
 * defines (it never touches custom roles or memberships).
 */
export async function syncAllWorkspaceRoles(
  client: Pick<PrismaClient, '$transaction' | 'workspace'>,
): Promise<{ workspaces: number }> {
  await client.$transaction((tx) => syncPermissionCatalog(tx), { timeout: 30_000 });
  const workspaces = await client.workspace.findMany({ select: { id: true } });
  for (const { id } of workspaces) {
    await client.$transaction((tx) => provisionSystemRoles(tx, id), { timeout: 30_000 });
  }
  return { workspaces: workspaces.length };
}
