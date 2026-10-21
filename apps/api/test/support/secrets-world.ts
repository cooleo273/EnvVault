import {
  createdSecretSchema,
  environmentSummarySchema,
  issuedInvitationSchema,
  paginatedSchema,
  workspaceMemberSchema,
  workspaceSummarySchema,
} from '@envvault/shared';
import { expect } from 'vitest';
import { z } from 'zod';
import { errorCode, type Harness, type TestUser } from './harness.js';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Request helpers bound to one running API. */
export function client(h: Harness) {
  async function call(user: TestUser, method: Method, path: string, body?: object) {
    const req = h
      .api()
      [method](`/api/v1${path}`)
      .set('Authorization', await h.bearer(user));
    return body === undefined ? req : req.send(body);
  }

  async function ok<T>(
    promise: Promise<{ status: number; body: unknown }>,
    status: number,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const response = await promise;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return (schema ? schema.parse(response.body) : response.body) as T;
  }

  async function fails(promise: Promise<{ status: number; body: unknown }>, status: number) {
    const response = await promise;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return errorCode(response.body);
  }

  async function join(owner: TestUser, workspaceId: string, user: TestUser, roleKey = 'member') {
    const issued = await ok(
      call(owner, 'post', `/workspaces/${workspaceId}/invitations`, { email: user.email, roleKey }),
      201,
      issuedInvitationSchema,
    );
    const token = new URL(issued.acceptUrl ?? '').hash.replace('#token=', '');
    await ok(call(user, 'post', '/invitations/accept', { token }), 200);
    const members = await ok(
      call(owner, 'get', `/workspaces/${workspaceId}/members`),
      200,
      z.array(workspaceMemberSchema),
    );
    const found = members.find((m) => m.user.email === user.email);
    if (!found) throw new Error('join failed');
    return found.id;
  }

  /** Owner, workspace and a project (owner is Project Admin) with Development and protected Production. */
  async function world(label = 'acme') {
    const owner = h.newUser(`${label}-owner`);
    const workspace = await ok(
      call(owner, 'post', '/workspaces', { name: label }),
      201,
      workspaceSummarySchema,
    );
    const project = await ok(
      call(owner, 'post', `/workspaces/${workspace.id}/projects`, {
        name: 'Backend',
        environments: [
          { name: 'Development', kind: 'DEVELOPMENT' },
          { name: 'Production', kind: 'PRODUCTION', isProtected: true },
        ],
      }),
      201,
      z.object({ id: z.uuid() }),
    );
    const envs = await ok(
      call(owner, 'get', `/workspaces/${workspace.id}/projects/${project.id}/environments`),
      200,
      paginatedSchema(environmentSummarySchema),
    );
    const byName = (name: string) => envs.items.find((e) => e.name === name)?.id ?? '';
    const base = `/workspaces/${workspace.id}/projects/${project.id}/environments`;
    return {
      owner,
      ws: workspace.id,
      project: project.id,
      dev: byName('Development'),
      prod: byName('Production'),
      secrets: (env: string) => `${base}/${env}/secrets`,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function addToProject(w: World, user: TestUser, roleKey: string) {
    const membershipId = await join(w.owner, w.ws, user);
    await ok(
      call(w.owner, 'post', `/workspaces/${w.ws}/projects/${w.project}/members`, {
        workspaceMembershipId: membershipId,
        roleKey,
      }),
      201,
    );
    return membershipId;
  }

  async function grant(w: World, env: string, membershipId: string, roleKey: string) {
    await ok(
      call(
        w.owner,
        'post',
        `/workspaces/${w.ws}/projects/${w.project}/environments/${env}/access`,
        {
          workspaceMembershipId: membershipId,
          roleKey,
          effect: 'ALLOW',
        },
      ),
      201,
    );
  }

  async function createSecret(user: TestUser, path: string, body: object) {
    return ok(call(user, 'post', path, body), 201, createdSecretSchema);
  }

  async function stepUp(user: TestUser) {
    await ok(call(user, 'post', '/auth/step-up', { password: user.password }), 200);
  }

  return { call, ok, fails, join, world, addToProject, grant, createSecret, stepUp };
}
