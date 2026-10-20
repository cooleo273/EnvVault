import type { PrismaClient } from '../client.js';
import { provisionSystemRoles, syncPermissionCatalog } from '../catalog/provisioning.js';
import type { Prisma } from '../generated/prisma/client.js';
import { withTransaction } from '../transaction.js';

/**
 * Development seed data. Safe by construction:
 * - only reserved `example.test` addresses (RFC 2606), no real people;
 * - users are linked to synthetic `seed:` identities, not Neon Auth accounts,
 *   so they cannot sign in (create your own account through the app);
 * - no secret VALUES, no ciphertext and no encryption keys: storing values
 *   requires a configured KMS (Phase 1). Seeded secrets are metadata only;
 * - no credentials or tokens of any kind.
 * Idempotent: re-running converges on the same data set.
 */
export const SEED = {
  users: [
    { email: 'alice@example.test', displayName: 'Alice (owner)' },
    { email: 'bob@example.test', displayName: 'Bob (developer)' },
    { email: 'carol@example.test', displayName: 'Carol (reviewer)' },
  ],
  workspace: { slug: 'acme-dev', name: 'Acme (development)' },
  project: {
    slug: 'checkout-api',
    name: 'Checkout API',
    description: 'Sample project created by the development seed.',
  },
  environments: [
    { slug: 'development', name: 'Development', kind: 'DEVELOPMENT', sortOrder: 0 },
    { slug: 'staging', name: 'Staging', kind: 'STAGING', sortOrder: 1 },
    {
      slug: 'production',
      name: 'Production',
      kind: 'PRODUCTION',
      sortOrder: 2,
      isProtected: true,
      requiredApprovals: 1,
    },
  ],
  secrets: [
    {
      key: 'DATABASE_URL',
      type: 'SECRET',
      category: 'Database',
      description: 'Primary database connection',
    },
    {
      key: 'STRIPE_API_KEY',
      type: 'SECRET',
      category: 'Payments',
      description: 'Payment provider key',
    },
    { key: 'LOG_LEVEL', type: 'STRING', category: 'General', description: 'Application log level' },
  ],
  serviceIdentity: { name: 'ci-deployer', description: 'Sample CI/CD pipeline identity' },
} as const satisfies {
  environments: readonly Omit<
    Prisma.EnvironmentUncheckedCreateInput,
    'workspaceId' | 'projectId'
  >[];
  secrets: readonly {
    key: string;
    type: Prisma.SecretUncheckedCreateInput['type'];
    category: string;
    description: string;
  }[];
  [key: string]: unknown;
};

export interface SeedResult {
  workspaceId: string;
  projectId: string;
  userIds: Record<string, string>;
}

export function assertSeedAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the development seed with NODE_ENV=production');
  }
}

export async function seedDevelopmentData(client: PrismaClient): Promise<SeedResult> {
  assertSeedAllowed();

  return withTransaction(
    client,
    async (tx) => {
      await syncPermissionCatalog(tx);

      const userIds: Record<string, string> = {};
      for (const user of SEED.users) {
        // Seed users are fixtures linked to synthetic `seed:` identities. They
        // cannot sign in: no Neon Auth user id contains ':'.
        const authUserId = `seed:${user.email.split('@')[0] ?? user.email}`;
        const row = await tx.user.upsert({
          where: { authUserId },
          create: { ...user, authUserId, emailVerifiedAt: new Date() },
          update: { displayName: user.displayName },
          select: { id: true },
        });
        userIds[user.email] = row.id;
      }
      const alice = required(userIds['alice@example.test'], 'alice');
      const bob = required(userIds['bob@example.test'], 'bob');
      const carol = required(userIds['carol@example.test'], 'carol');

      const workspace =
        (await tx.workspace.findFirst({ where: { slug: SEED.workspace.slug, deletedAt: null } })) ??
        (await tx.workspace.create({ data: { ...SEED.workspace, createdById: alice } }));
      const workspaceId = workspace.id;
      const roles = await provisionSystemRoles(tx, workspaceId);
      const roleId = (key: string): string => {
        const id = roles.get(key);
        if (id === undefined) throw new Error(`System role ${key} missing`);
        return id;
      };

      const memberIds: Record<string, string> = {};
      for (const [userId, roleKey] of [
        [alice, 'owner'],
        [bob, 'member'],
        [carol, 'member'],
      ] as const) {
        const membership = await tx.workspaceMembership.upsert({
          where: { workspaceId_userId: { workspaceId, userId } },
          create: { workspaceId, userId, roleId: roleId(roleKey) },
          update: {},
          select: { id: true },
        });
        memberIds[userId] = membership.id;
      }

      await tx.environmentTemplate.upsert({
        where: { workspaceId_name: { workspaceId, name: 'Standard' } },
        create: {
          workspaceId,
          name: 'Standard',
          description: 'Development, staging and a protected production environment.',
          isDefault: true,
          environments: SEED.environments.map(({ name, slug, kind }) => ({
            name,
            slug,
            kind,
            isProtected: kind === 'PRODUCTION',
          })),
        },
        update: {},
      });

      const project =
        (await tx.project.findFirst({
          where: { workspaceId, slug: SEED.project.slug, deletedAt: null },
        })) ?? (await tx.project.create({ data: { workspaceId, ...SEED.project } }));
      const projectId = project.id;

      await tx.projectMembership.upsert({
        where: {
          projectId_workspaceMembershipId: {
            projectId,
            workspaceMembershipId: required(memberIds[bob], 'bob membership'),
          },
        },
        create: {
          workspaceId,
          projectId,
          workspaceMembershipId: required(memberIds[bob], 'bob membership'),
          roleId: roleId('project-developer'),
        },
        update: {},
      });

      const environmentIds: Record<string, string> = {};
      for (const definition of SEED.environments) {
        const environment =
          (await tx.environment.findFirst({
            where: { projectId, slug: definition.slug, deletedAt: null },
          })) ?? (await tx.environment.create({ data: { workspaceId, projectId, ...definition } }));
        environmentIds[definition.slug] = environment.id;
      }

      // Metadata only: no SecretVersion rows (values need a configured KMS).
      const developmentId = required(environmentIds.development, 'development environment');
      for (const secret of SEED.secrets) {
        const existing = await tx.secret.findFirst({
          where: { environmentId: developmentId, key: secret.key, deletedAt: null },
        });
        if (!existing) {
          await tx.secret.create({
            data: {
              workspaceId,
              projectId,
              environmentId: developmentId,
              ...secret,
              createdByUserId: alice,
              updatedByUserId: alice,
            },
          });
        }
      }

      const databaseUrl = await tx.secret.findFirstOrThrow({
        where: { environmentId: developmentId, key: 'DATABASE_URL', deletedAt: null },
        select: { id: true },
      });
      await tx.secretRotationPolicy.upsert({
        where: { workspaceId_secretId: { workspaceId, secretId: databaseUrl.id } },
        create: {
          workspaceId,
          secretId: databaseUrl.id,
          strategy: 'MANUAL_REMINDER',
          intervalDays: 90,
          createdById: alice,
        },
        update: {},
      });

      // Machine identity without credentials (tokens are only ever issued on demand).
      const identity =
        (await tx.serviceIdentity.findFirst({
          where: { workspaceId, name: SEED.serviceIdentity.name, deletedAt: null },
        })) ??
        (await tx.serviceIdentity.create({
          data: { workspaceId, projectId, ...SEED.serviceIdentity, createdById: alice },
        }));

      // Environment-scoped grants: CI reads staging; Carol approves production.
      const grants = [
        {
          environmentId: required(environmentIds.staging, 'staging environment'),
          serviceIdentityId: identity.id,
          roleId: roleId('environment-reader'),
        },
        {
          environmentId: required(environmentIds.production, 'production environment'),
          workspaceMembershipId: required(memberIds[carol], 'carol membership'),
          roleId: roleId('environment-approver'),
        },
      ];
      for (const grant of grants) {
        const exists = await tx.accessPolicy.findFirst({ where: grant });
        if (!exists) {
          await tx.accessPolicy.create({
            data: { workspaceId, projectId, createdById: alice, ...grant },
          });
        }
      }

      const welcome = await tx.notification.findFirst({
        where: { recipientId: alice, workspaceId, type: 'workspace.seeded' },
      });
      if (!welcome) {
        await tx.notification.create({
          data: {
            recipientId: alice,
            workspaceId,
            type: 'workspace.seeded',
            title: 'Development workspace ready',
            body: 'The Acme development workspace was created by the seed script.',
            data: { workspaceSlug: SEED.workspace.slug },
          },
        });
      }

      return { workspaceId, projectId, userIds };
    },
    { timeoutMs: 30_000 },
  );
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Seed invariant violated: ${what} missing`);
  return value;
}
