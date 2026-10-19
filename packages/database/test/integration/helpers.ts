import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { provisionSystemRoles, syncPermissionCatalog } from '../../src/catalog/provisioning.js';
import { createPrismaClient, type DbClient, type PrismaClient } from '../../src/client.js';
import { type ConstraintViolationKind, getConstraintViolation } from '../../src/errors.js';
import { truncateAllTables } from '../../src/testing.js';

let client: PrismaClient | undefined;

export function testDb(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  client ??= createPrismaClient({ connectionString: url, applicationName: 'envvault-test' });
  return client;
}

export async function disconnectTestDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

/** Empties every table (see truncateAllTables). */
export async function truncateAll(db: PrismaClient): Promise<void> {
  await truncateAllTables(db);
}

/**
 * Random bytes shaped like an AES-256-GCM envelope. Test data only: it is not
 * the output of any encryption and decrypts to nothing.
 */
export function fakeEnvelope() {
  return {
    ciphertext: new Uint8Array(randomBytes(48)),
    iv: new Uint8Array(randomBytes(12)),
    authTag: new Uint8Array(randomBytes(16)),
    encryptedDataKey: new Uint8Array(randomBytes(184)),
  };
}

export interface Tenant {
  label: string;
  userId: string;
  workspaceId: string;
  ownerMembershipId: string;
  roles: Map<string, string>;
  projectId: string;
  developmentId: string;
  productionId: string;
  encryptionKeyId: string;
}

let suffix = 0;

/**
 * Profile data for a test user. The auth id is a deterministic stand-in for a
 * Neon Auth user id (the JWT `sub`); test ids never collide with real ones.
 */
export function userData(email: string) {
  return { email, authUserId: `test:${email.toLowerCase().replace('@', '.at.')}` };
}

/** Creates a fully provisioned workspace: owner, system roles, project, environments, key. */
export async function createTenant(db: DbClient, label: string): Promise<Tenant> {
  suffix += 1;
  const tag = `${label}-${suffix}`;
  await syncPermissionCatalog(db);
  const user = await db.user.create({ data: userData(`${tag}@example.test`) });
  const workspace = await db.workspace.create({
    data: { name: `Workspace ${tag}`, slug: `ws-${tag}`, createdById: user.id },
  });
  const roles = await provisionSystemRoles(db, workspace.id);
  const membership = await db.workspaceMembership.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      roleId: required(roles.get('owner'), 'owner role'),
    },
  });
  const project = await db.project.create({
    data: { workspaceId: workspace.id, name: 'Project', slug: 'project' },
  });
  const development = await db.environment.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Development',
      slug: 'development',
    },
  });
  const production = await db.environment.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Production',
      slug: 'production',
      kind: 'PRODUCTION',
      isProtected: true,
      requiredApprovals: 1,
    },
  });
  const key = await db.encryptionKey.create({
    data: {
      workspaceId: workspace.id,
      version: 1,
      kmsProvider: 'test',
      kmsKeyRef: `test-key-${tag}`,
    },
  });
  return {
    label,
    userId: user.id,
    workspaceId: workspace.id,
    ownerMembershipId: membership.id,
    roles,
    projectId: project.id,
    developmentId: development.id,
    productionId: production.id,
    encryptionKeyId: key.id,
  };
}

/** Creates a secret attributed to the tenant owner. */
export function createSecret(
  db: DbClient,
  tenant: Tenant,
  key = 'API_KEY',
  environmentId?: string,
) {
  return db.secret.create({
    data: {
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      environmentId: environmentId ?? tenant.developmentId,
      key,
      createdByUserId: tenant.userId,
      updatedByUserId: tenant.userId,
    },
  });
}

export function role(tenant: Tenant, key: string): string {
  const id = tenant.roles.get(key);
  if (id === undefined) throw new Error(`role ${key} missing`);
  return id;
}

/** Asserts that a write is rejected by a database constraint of the given kind. */
export async function expectViolation(
  operation: Promise<unknown>,
  kind: ConstraintViolationKind,
  constraint?: string | RegExp,
): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'expected the database to reject the write').toBeDefined();
  const violation = getConstraintViolation(error);
  expect(violation, String(error)).not.toBeNull();
  expect(violation?.kind).toBe(kind);
  if (constraint !== undefined) {
    if (typeof constraint === 'string') {
      expect(violation?.constraint).toBe(constraint);
    } else {
      expect(violation?.constraint ?? (error as Error).message).toMatch(constraint);
    }
  }
}

/** Asserts rejection by an EnvVault integrity trigger (SQLSTATE 23514) with a message. */
export async function expectTriggerRejection(
  operation: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'expected the database to reject the write').toBeDefined();
  expect(getConstraintViolation(error)?.kind).toBe('check');
  expect((error as Error).message).toMatch(message);
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} missing`);
  return value;
}
