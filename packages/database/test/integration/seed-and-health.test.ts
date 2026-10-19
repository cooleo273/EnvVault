import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../src/client.js';
import { checkDatabaseHealth } from '../../src/health.js';
import { SEED, seedDevelopmentData } from '../../src/seed/seed.js';
import { disconnectTestDb, testDb, truncateAll } from './helpers.js';

const db = testDb();

async function countAll() {
  const [users, workspaces, roles, environments, secrets, policies, notifications] =
    await Promise.all([
      db.user.count(),
      db.workspace.count(),
      db.role.count(),
      db.environment.count(),
      db.secret.count(),
      db.accessPolicy.count(),
      db.notification.count(),
    ]);
  return { users, workspaces, roles, environments, secrets, policies, notifications };
}

describe('development seed', () => {
  beforeAll(async () => {
    await truncateAll(db);
  });

  afterAll(disconnectTestDb);

  it('creates the sample workspace and is idempotent', async () => {
    const first = await seedDevelopmentData(db);
    const afterFirst = await countAll();
    const second = await seedDevelopmentData(db);
    const afterSecond = await countAll();

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst).toMatchObject({
      users: SEED.users.length,
      workspaces: 1,
      environments: SEED.environments.length,
      secrets: SEED.secrets.length,
      policies: 2,
      notifications: 1,
    });
  });

  it('contains no secret values, encryption keys, credentials or real addresses', async () => {
    await expect(db.secretVersion.count()).resolves.toBe(0);
    await expect(db.encryptionKey.count()).resolves.toBe(0);
    await expect(db.serviceCredential.count()).resolves.toBe(0);
    await expect(db.workspaceInvitation.count()).resolves.toBe(0);
    const emails = (await db.user.findMany({ select: { email: true } })).map((u) => u.email);
    expect(emails.every((email) => email.endsWith('@example.test'))).toBe(true);
  });

  it('protects the seeded production environment', async () => {
    const production = await db.environment.findFirstOrThrow({ where: { slug: 'production' } });
    expect(production).toMatchObject({
      isProtected: true,
      requiredApprovals: 1,
      kind: 'PRODUCTION',
    });
  });
});

describe('checkDatabaseHealth', () => {
  it('reports up for a migrated, reachable database', async () => {
    const health = await checkDatabaseHealth(db);
    expect(health.status).toBe('up');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports down when a migration is unfinished', async () => {
    const id = 'health-check-test-migration';
    await db.$executeRaw`
      INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "applied_steps_count")
      VALUES (${id}, 'x', 'broken', now(), 0)`;
    try {
      await expect(checkDatabaseHealth(db)).resolves.toMatchObject({
        status: 'down',
        reason: 'migrations_failed',
      });
    } finally {
      await db.$executeRaw`DELETE FROM "_prisma_migrations" WHERE "id" = ${id}`;
    }
  });

  it('reports down without leaking connection details when unreachable', async () => {
    const unreachable = createPrismaClient({
      connectionString: 'postgresql://user:hunter2@127.0.0.1:1/nowhere',
      connectionTimeoutMs: 1_000,
    });
    try {
      const health = await checkDatabaseHealth(unreachable);
      expect(health).toEqual({ status: 'down', reason: 'unreachable' });
      expect(JSON.stringify(health)).not.toContain('hunter2');
    } finally {
      await unreachable.$disconnect();
    }
  });
});
