import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSecret,
  createTenant,
  disconnectTestDb,
  userData,
  expectTriggerRejection,
  expectViolation,
  fakeEnvelope,
  type Tenant,
  testDb,
  truncateAll,
} from './helpers.js';

const db = testDb();

describe('change requests, approvals and audit', () => {
  let t: Tenant;
  let reviewerId: string;

  beforeEach(async () => {
    await truncateAll(db);
    t = await createTenant(db, 'gov');
    reviewerId = (await db.user.create({ data: userData('reviewer@example.test') })).id;
  });

  afterAll(disconnectTestDb);

  function openChangeRequest() {
    return db.changeRequest.create({
      data: {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        environmentId: t.productionId,
        title: 'Rotate payment key',
        requiredApprovals: 1,
        requestedById: t.userId,
      },
    });
  }

  it('rejects self-approval and allows one decision per reviewer', async () => {
    const request = await openChangeRequest();
    const approval = (reviewer: string) => ({
      workspaceId: t.workspaceId,
      changeRequestId: request.id,
      reviewerId: reviewer,
      decision: 'APPROVED' as const,
    });

    await expectTriggerRejection(
      db.changeApproval.create({ data: approval(t.userId) }),
      /cannot be reviewed by its requester/,
    );
    await expect(db.changeApproval.create({ data: approval(reviewerId) })).resolves.toBeDefined();
    await expectViolation(db.changeApproval.create({ data: approval(reviewerId) }), 'unique');
  });

  it('requires applied change requests to record who applied them', async () => {
    const request = await openChangeRequest();
    await expectViolation(
      db.changeRequest.update({ where: { id: request.id }, data: { status: 'APPLIED' } }),
      'check',
      'change_requests_applied_chk',
    );
  });

  it('stores proposed values encrypted and validates item operations', async () => {
    const request = await openChangeRequest();
    const secret = await createSecret(db, t, 'PAYMENT_KEY', t.productionId);
    const base = { workspaceId: t.workspaceId, changeRequestId: request.id };
    const encrypted = {
      ...fakeEnvelope(),
      algorithm: 'AES_256_GCM' as const,
      envelopeVersion: 1,
      encryptionKeyId: t.encryptionKeyId,
    };

    await expect(
      db.changeRequestItem.create({
        data: {
          ...base,
          operation: 'UPDATE',
          secretId: secret.id,
          secretKey: secret.key,
          ...encrypted,
        },
      }),
    ).resolves.toBeDefined();

    await expectViolation(
      db.changeRequestItem.create({
        data: {
          ...base,
          operation: 'DELETE',
          secretId: secret.id,
          secretKey: 'OTHER',
          ...encrypted,
        },
      }),
      'check',
      'change_request_items_value_matches_operation_chk',
    );
    await expectViolation(
      db.changeRequestItem.create({
        data: {
          ...base,
          operation: 'CREATE',
          secretId: secret.id,
          secretKey: 'NEW_KEY',
          ...encrypted,
        },
      }),
      'check',
      'change_request_items_target_matches_operation_chk',
    );
    await expectViolation(
      db.changeRequestItem.create({
        data: { ...base, operation: 'CREATE', secretKey: 'PARTIAL', ciphertext: new Uint8Array(4) },
      }),
      'check',
      'change_request_items_envelope_complete_chk',
    );
  });

  describe('audit events', () => {
    function auditEvent(overrides: Record<string, unknown> = {}) {
      return db.auditEvent.create({
        data: {
          workspaceId: t.workspaceId,
          actorType: 'USER',
          actorUserId: t.userId,
          action: 'secret.version.created',
          outcome: 'SUCCESS',
          resourceType: 'secret',
          metadata: { key: 'API_KEY', versionNumber: 1 },
          ...overrides,
        },
      });
    }

    it('is append-only', async () => {
      const event = await auditEvent();
      await expectTriggerRejection(
        db.auditEvent.update({ where: { id: event.id }, data: { outcome: 'DENIED' } }),
        /append-only \(UPDATE rejected\)/,
      );
      await expectTriggerRejection(
        db.auditEvent.delete({ where: { id: event.id } }),
        /append-only \(DELETE rejected\)/,
      );
      // Plain TRUNCATE already fails on the audit_seals foreign key; CASCADE reaches the trigger.
      await expect(db.$executeRawUnsafe('TRUNCATE TABLE "audit_events"')).rejects.toThrow();
      await expectTriggerRejection(
        db.$executeRawUnsafe('TRUNCATE TABLE "audit_events" CASCADE'),
        /append-only \(TRUNCATE rejected\)/,
      );
    });

    it('requires actor details that match the actor type', async () => {
      await expectViolation(
        auditEvent({ actorUserId: null }),
        'check',
        'audit_events_actor_user_chk',
      );
      await expectViolation(
        auditEvent({ actorType: 'SYSTEM' }),
        'check',
        'audit_events_actor_user_chk',
      );
      await expect(auditEvent({ actorType: 'SYSTEM', actorUserId: null })).resolves.toBeDefined();
    });

    it('validates action names and metadata shape', async () => {
      await expectViolation(
        auditEvent({ action: 'Secret Read' }),
        'check',
        'audit_events_action_format_chk',
      );
      await expectViolation(
        auditEvent({ metadata: ['not', 'an', 'object'] }),
        'check',
        'audit_events_metadata_chk',
      );
      await expectViolation(
        auditEvent({ metadata: { blob: 'x'.repeat(20_000) } }),
        'check',
        'audit_events_metadata_chk',
      );
    });

    it('blocks purging a workspace while it has audit history', async () => {
      await auditEvent();
      await expectViolation(
        db.workspace.delete({ where: { id: t.workspaceId } }),
        'foreign_key',
        'audit_events_workspace_id_fkey',
      );
    });
  });
});
