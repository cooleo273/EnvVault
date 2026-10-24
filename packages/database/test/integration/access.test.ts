import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  disconnectTestDb,
  userData,
  expectTriggerRejection,
  expectViolation,
  role,
  type Tenant,
  testDb,
  truncateAll,
} from './helpers.js';

const db = testDb();
const DAY = 86_400_000;

function tokenHash(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(randomBytes(32)).digest());
}

describe('access control constraints', () => {
  let t: Tenant;
  let memberId: string;

  beforeEach(async () => {
    await truncateAll(db);
    t = await createTenant(db, 'acl');
    const user = await db.user.create({ data: userData('member@example.test') });
    const membership = await db.workspaceMembership.create({
      data: { workspaceId: t.workspaceId, userId: user.id, roleId: role(t, 'member') },
    });
    memberId = membership.id;
  });

  afterAll(disconnectTestDb);

  it('only assigns roles where their scope allows', async () => {
    const user = await db.user.create({ data: userData('scoped@example.test') });
    await expectTriggerRejection(
      db.workspaceMembership.create({
        data: { workspaceId: t.workspaceId, userId: user.id, roleId: role(t, 'project-developer') },
      }),
      /must reference a WORKSPACE role/,
    );
    await expectTriggerRejection(
      db.projectMembership.create({
        data: {
          workspaceId: t.workspaceId,
          projectId: t.projectId,
          workspaceMembershipId: memberId,
          roleId: role(t, 'admin'),
        },
      }),
      /must reference a PROJECT role/,
    );
    await expectTriggerRejection(
      db.accessPolicy.create({
        data: {
          workspaceId: t.workspaceId,
          projectId: t.projectId,
          environmentId: t.productionId,
          workspaceMembershipId: memberId,
          roleId: role(t, 'project-viewer'),
        },
      }),
      /must reference a ENVIRONMENT role/,
    );
  });

  it('does not allow changing a role scope after creation', async () => {
    await expectTriggerRejection(
      db.role.update({ where: { id: role(t, 'member') }, data: { scope: 'PROJECT' } }),
      /roles\.scope is immutable/,
    );
  });

  it('allows one membership per user and workspace', async () => {
    await expectViolation(
      db.workspaceMembership.create({
        data: { workspaceId: t.workspaceId, userId: t.userId, roleId: role(t, 'member') },
      }),
      'unique',
    );
  });

  it('requires access policies to have exactly one subject', async () => {
    const base = {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      environmentId: t.productionId,
      roleId: role(t, 'environment-reader'),
    };
    await expectViolation(
      db.accessPolicy.create({ data: base }),
      'check',
      'access_policies_one_subject_chk',
    );
    const identity = await db.serviceIdentity.create({
      data: { workspaceId: t.workspaceId, projectId: t.projectId, name: 'ci' },
    });
    await expectViolation(
      db.accessPolicy.create({
        data: { ...base, workspaceMembershipId: memberId, serviceIdentityId: identity.id },
      }),
      'check',
      'access_policies_one_subject_chk',
    );

    await db.accessPolicy.create({ data: { ...base, workspaceMembershipId: memberId } });
    await expectViolation(
      db.accessPolicy.create({ data: { ...base, workspaceMembershipId: memberId } }),
      'unique',
    );
  });

  it('revokes all project and environment access when a member is removed', async () => {
    await db.projectMembership.create({
      data: {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        workspaceMembershipId: memberId,
        roleId: role(t, 'project-developer'),
      },
    });
    await db.accessPolicy.create({
      data: {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        environmentId: t.productionId,
        workspaceMembershipId: memberId,
        roleId: role(t, 'environment-reader'),
      },
    });

    await db.workspaceMembership.delete({ where: { id: memberId } });

    await expect(
      db.projectMembership.count({ where: { workspaceMembershipId: memberId } }),
    ).resolves.toBe(0);
    await expect(
      db.accessPolicy.count({ where: { workspaceMembershipId: memberId } }),
    ).resolves.toBe(0);
  });

  it('prevents deleting a role that is still assigned', async () => {
    const custom = await db.role.create({
      data: { workspaceId: t.workspaceId, key: 'custom', name: 'Custom', scope: 'WORKSPACE' },
    });
    await db.workspaceMembership.update({ where: { id: memberId }, data: { roleId: custom.id } });
    await expectViolation(db.role.delete({ where: { id: custom.id } }), 'foreign_key');
  });

  describe('service credentials', () => {
    let identityId: string;

    beforeEach(async () => {
      const identity = await db.serviceIdentity.create({
        data: { workspaceId: t.workspaceId, projectId: t.projectId, name: 'deployer' },
      });
      identityId = identity.id;
    });

    const apiToken = (overrides: Record<string, unknown> = {}) => ({
      workspaceId: t.workspaceId,
      serviceIdentityId: identityId,
      type: 'API_TOKEN' as const,
      name: 'deploy token',
      tokenPrefix: randomBytes(8).toString('hex'),
      secretHash: tokenHash(),
      hashAlgorithm: 'hmac-sha256',
      digestKeyId: 'ik-0123456789abcdef',
      scopes: ['environment:read', 'secret:runtime'],
      expiresAt: new Date(Date.now() + 30 * DAY),
      ...overrides,
    });

    it('stores API tokens only as hashes and requires an expiry', async () => {
      await expect(db.serviceCredential.create({ data: apiToken() })).resolves.toBeDefined();
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ expiresAt: null }) }),
        'check',
        'service_credentials_api_token_chk',
      );
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ secretHash: null }) }),
        'check',
        'service_credentials_api_token_chk',
      );
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ secretHash: new Uint8Array(8) }) }),
        'check',
        'service_credentials_secret_hash_len_chk',
      );
    });

    it('rejects expired-at-creation tokens and duplicate prefixes', async () => {
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ expiresAt: new Date(Date.now() - DAY) }) }),
        'check',
        'service_credentials_expiry_chk',
      );
      const first = await db.serviceCredential.create({ data: apiToken() });
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ tokenPrefix: first.tokenPrefix }) }),
        'unique',
      );
    });

    it('stores no secret for OIDC federation credentials', async () => {
      const oidc = {
        workspaceId: t.workspaceId,
        serviceIdentityId: identityId,
        type: 'OIDC_FEDERATION' as const,
        name: 'github actions',
        oidcIssuer: 'https://token.actions.githubusercontent.com',
        oidcSubject: 'repo:acme/checkout:ref:refs/heads/main',
      };
      await expect(db.serviceCredential.create({ data: oidc })).resolves.toBeDefined();
      await expectViolation(
        db.serviceCredential.create({ data: { ...oidc, secretHash: tokenHash() } }),
        'check',
        'service_credentials_oidc_chk',
      );
    });

    it('records revocation metadata consistently and keeps the token hash immutable', async () => {
      const credential = await db.serviceCredential.create({ data: apiToken() });
      await expectViolation(
        db.serviceCredential.update({
          where: { id: credential.id },
          data: { revocationReason: 'leaked' },
        }),
        'check',
        'service_credentials_revocation_reason_chk',
      );
      await expect(
        db.serviceCredential.update({
          where: { id: credential.id },
          data: { revokedAt: new Date(), revokedById: t.userId, revocationReason: 'leaked' },
        }),
      ).resolves.toMatchObject({ revocationReason: 'leaked' });
      await expectTriggerRejection(
        db.serviceCredential.update({
          where: { id: credential.id },
          data: { secretHash: tokenHash() },
        }),
        /secret_hash is immutable/,
      );
    });

    it('confines scopes to machine permissions and requires a keyed digest', async () => {
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ scopes: ['secret:read'] }) }),
        'check',
        'service_credentials_scopes_chk',
      );
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ scopes: [] }) }),
        'check',
        'service_credentials_scopes_chk',
      );
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ hashAlgorithm: 'sha256' }) }),
        'check',
        'service_credentials_digest_chk',
      );
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ digestKeyId: null }) }),
        'check',
        'service_credentials_digest_chk',
      );
    });

    it('rotates a credential at most once and keeps scopes immutable', async () => {
      const first = await db.serviceCredential.create({ data: apiToken() });
      await db.serviceCredential.create({ data: apiToken({ rotatedFromId: first.id }) });
      await expectViolation(
        db.serviceCredential.create({ data: apiToken({ rotatedFromId: first.id }) }),
        'unique',
      );
      await expectTriggerRejection(
        db.serviceCredential.update({
          where: { id: first.id },
          data: { scopes: ['environment:read', 'secret:list', 'secret:runtime'] },
        }),
        /scopes is immutable/,
      );
    });

    it('stores access tokens as 32 byte hashes bound to their credential', async () => {
      const credential = await db.serviceCredential.create({ data: apiToken() });
      const token = {
        workspaceId: t.workspaceId,
        serviceIdentityId: identityId,
        credentialId: credential.id,
        tokenHash: tokenHash(),
        scopes: ['secret:runtime'],
        expiresAt: new Date(Date.now() + 60_000),
      };
      await expect(db.machineAccessToken.create({ data: token })).resolves.toBeDefined();
      await expectViolation(
        db.machineAccessToken.create({ data: { ...token, tokenHash: new Uint8Array(8) } }),
        'check',
        'machine_access_tokens_hash_chk',
      );
      await expectViolation(
        db.machineAccessToken.create({
          data: { ...token, tokenHash: tokenHash(), scopes: ['secret:export'] },
        }),
        'check',
        'machine_access_tokens_scopes_chk',
      );
      const other = await db.serviceIdentity.create({
        data: { workspaceId: t.workspaceId, projectId: t.projectId, name: 'other' },
      });
      await expectViolation(
        db.machineAccessToken.create({
          data: { ...token, tokenHash: tokenHash(), serviceIdentityId: other.id },
        }),
        'foreign_key',
        'machine_access_tokens_credential_fkey',
      );
    });

    it('grants an identity only environments of its own project', async () => {
      const second = await db.project.create({
        data: { workspaceId: t.workspaceId, name: 'Second', slug: 'second' },
      });
      const environment = await db.environment.create({
        data: { workspaceId: t.workspaceId, projectId: second.id, name: 'QA', slug: 'qa' },
      });
      const role = await db.role.findFirstOrThrow({
        where: { workspaceId: t.workspaceId, key: 'environment-viewer' },
      });
      await expectViolation(
        db.accessPolicy.create({
          data: {
            workspaceId: t.workspaceId,
            projectId: second.id,
            environmentId: environment.id,
            serviceIdentityId: identityId,
            roleId: role.id,
          },
        }),
        'foreign_key',
        'access_policies_service_identity_fkey',
      );
    });

    it('confines project-scoped identities to their own workspace projects', async () => {
      const other = await createTenant(db, 'other');
      await expectViolation(
        db.serviceIdentity.create({
          data: { workspaceId: t.workspaceId, projectId: other.projectId, name: 'cross' },
        }),
        'foreign_key',
        'service_identities_project_fkey',
      );
    });
  });

  describe('invitations', () => {
    const invitation = (overrides: Record<string, unknown> = {}) => ({
      workspaceId: t.workspaceId,
      email: 'invitee@example.test',
      roleId: role(t, 'member'),
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY),
      invitedById: t.userId,
      ...overrides,
    });

    it('allows one pending invitation per email and workspace', async () => {
      const first = await db.workspaceInvitation.create({ data: invitation() });
      await expectViolation(
        db.workspaceInvitation.create({ data: invitation() }),
        'unique',
        'workspace_invitations_pending_email_key',
      );
      await db.workspaceInvitation.update({
        where: { id: first.id },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      await expect(db.workspaceInvitation.create({ data: invitation() })).resolves.toBeDefined();
    });

    it('validates email normalisation, token hash size and status metadata', async () => {
      await expectViolation(
        db.workspaceInvitation.create({ data: invitation({ email: 'Invitee@Example.test' }) }),
        'check',
        'workspace_invitations_email_normalized_chk',
      );
      await expectViolation(
        db.workspaceInvitation.create({ data: invitation({ tokenHash: new Uint8Array(16) }) }),
        'check',
        'workspace_invitations_token_hash_len_chk',
      );
      await expectViolation(
        db.workspaceInvitation.create({ data: invitation({ status: 'ACCEPTED' }) }),
        'check',
        'workspace_invitations_accepted_chk',
      );
    });
  });

  it('stores user emails lower-cased', async () => {
    await expectViolation(
      db.user.create({ data: userData('Mixed@Example.test') }),
      'check',
      'users_email_normalized_chk',
    );
  });
});
