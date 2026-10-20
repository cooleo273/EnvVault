'use server';

import {
  createEnvironmentGrantInputSchema,
  createEnvironmentInputSchema,
  createProjectInputSchema,
  duplicateEnvironmentInputSchema,
  duplicateProjectInputSchema,
  environmentTemplateEntrySchema,
  projectRoleKeySchema,
  updateEnvironmentInputSchema,
  updateProjectInputSchema,
} from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { AUTH_ROUTES } from '@/config/routes';
import { messageFor } from '@/features/workspaces/messages';
import { parseExpectedKeys } from './expected-keys';
import { isApiError, withApi } from '@/lib/api/server-api';
import type { ActionResult, FormState } from '@/lib/form-state';
import { environmentPath, projectPath } from '@/lib/projects/server';

/**
 * Project and environment server actions. Ids bound to an action and every
 * form value are client-controlled: the API authorizes each call against the
 * caller's workspace membership, project role and environment grants.
 */

const SESSION_ENDED = ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_INVALID'];

function failure(error: unknown): string {
  if (isApiError(error) && SESSION_ENDED.includes(error.code)) redirect(AUTH_ROUTES.login);
  return messageFor(isApiError(error) ? error.code : undefined);
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: failure(error) };
}

function failForm(error: unknown, fieldErrors?: Record<string, string>): FormState {
  return { status: 'error', message: failure(error), ...(fieldErrors ? { fieldErrors } : {}) };
}

function zodFieldErrors(error: z.ZodError): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors };
}

const optional = (value: FormDataEntryValue | null) =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

function parseJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function refresh(workspaceId: string, projectId?: string) {
  revalidatePath(`/workspaces/${workspaceId}/projects`);
  if (projectId) revalidatePath(projectPath(workspaceId, projectId), 'layout');
}

const passwordSchema = z.string().min(1, 'Enter your password').max(1024);

/* ------------------------------------------------------------ Projects */

export async function createProjectAction(
  workspaceId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = createProjectInputSchema.safeParse({
    name: formData.get('name'),
    slug: optional(formData.get('slug')),
    description: optional(formData.get('description')),
    icon: optional(formData.get('icon')),
    color: optional(formData.get('color')),
    environments: parseJson(formData.get('environments')) ?? [],
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  let id: string;
  try {
    ({ id } = await withApi((api) => api.createProject(workspaceId, parsed.data)));
  } catch (error) {
    if (isApiError(error, 'PROJECT_SLUG_TAKEN')) {
      return failForm(error, { slug: 'That URL is already taken' });
    }
    return failForm(error);
  }
  refresh(workspaceId);
  redirect(`${projectPath(workspaceId, id)}?created=1`);
}

export async function updateProjectAction(
  workspaceId: string,
  projectId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = updateProjectInputSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? undefined,
    icon: optional(formData.get('icon')),
    color: optional(formData.get('color')),
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  try {
    await withApi((api) => api.updateProject(workspaceId, projectId, parsed.data));
  } catch (error) {
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  return { status: 'success', message: 'Project settings saved.' };
}

export async function setProjectArchivedAction(
  workspaceId: string,
  projectId: string,
  archived: boolean,
): Promise<ActionResult> {
  try {
    await withApi((api) =>
      archived
        ? api.archiveProject(workspaceId, projectId)
        : api.restoreProject(workspaceId, projectId),
    );
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId, projectId);
  return {
    ok: true,
    message: archived ? 'Project archived. It is now read-only.' : 'Project restored.',
  };
}

export async function deleteProjectAction(
  workspaceId: string,
  projectId: string,
  expectedSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (formData.get('confirmation') !== expectedSlug) {
    return {
      status: 'error',
      fieldErrors: { confirmation: 'Type the project URL exactly' },
      message: 'Confirmation does not match.',
    };
  }
  const password = passwordSchema.safeParse(formData.get('password'));
  if (!password.success) {
    return {
      status: 'error',
      fieldErrors: { password: 'Enter your password' },
      message: 'Enter your password.',
    };
  }
  try {
    await withApi(async (api) => {
      await api.stepUp(password.data);
      await api.deleteProject(workspaceId, projectId);
    });
  } catch (error) {
    if (isApiError(error, 'STEP_UP_FAILED'))
      return failForm(error, { password: 'Incorrect password' });
    return failForm(error);
  }
  refresh(workspaceId);
  redirect(`/workspaces/${workspaceId}/projects?deleted=1`);
}

export async function duplicateProjectAction(
  workspaceId: string,
  projectId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = duplicateProjectInputSchema.safeParse({
    name: formData.get('name'),
    slug: optional(formData.get('slug')),
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  let id: string;
  try {
    ({ id } = await withApi((api) => api.duplicateProject(workspaceId, projectId, parsed.data)));
  } catch (error) {
    return failForm(error);
  }
  refresh(workspaceId);
  redirect(`${projectPath(workspaceId, id)}?created=1`);
}

export async function setFavoriteAction(
  workspaceId: string,
  projectId: string,
  favorite: boolean,
): Promise<ActionResult> {
  try {
    await withApi((api) => api.setProjectFavorite(workspaceId, projectId, favorite));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId, projectId);
  return { ok: true };
}

/* ------------------------------------------------------ Project members */

export async function addProjectMemberAction(
  workspaceId: string,
  projectId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = z
    .object({ workspaceMembershipId: z.uuid('Choose a person'), roleKey: projectRoleKeySchema })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodFieldErrors(parsed.error);
  try {
    await withApi((api) => api.addProjectMember(workspaceId, projectId, parsed.data));
  } catch (error) {
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  return { status: 'success', message: 'Member added.' };
}

export async function changeProjectMemberRoleAction(
  workspaceId: string,
  projectId: string,
  memberId: string,
  roleKey: string,
): Promise<ActionResult> {
  const role = projectRoleKeySchema.safeParse(roleKey);
  if (!role.success) return { ok: false, message: 'Choose a valid role.' };
  try {
    await withApi((api) =>
      api.changeProjectMemberRole(workspaceId, projectId, memberId, role.data),
    );
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId, projectId);
  return { ok: true, message: 'Project role updated.' };
}

export async function removeProjectMemberAction(
  workspaceId: string,
  projectId: string,
  memberId: string,
): Promise<ActionResult> {
  try {
    await withApi((api) => api.removeProjectMember(workspaceId, projectId, memberId));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId, projectId);
  return { ok: true, message: 'Member removed from the project.' };
}

/* ---------------------------------------------------------- Environments */

export async function createEnvironmentAction(
  workspaceId: string,
  projectId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const keys = parseExpectedKeys(text(formData, 'expectedKeys'));
  const parsed = createEnvironmentInputSchema.safeParse({
    name: formData.get('name'),
    slug: optional(formData.get('slug')),
    kind: optional(formData.get('kind')),
    description: optional(formData.get('description')),
    color: optional(formData.get('color')),
    icon: optional(formData.get('icon')),
    isProtected: formData.get('isProtected') === 'on',
    expectedKeys: keys,
    templateId: optional(formData.get('templateId')),
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  let id: string;
  try {
    ({ id } = await withApi((api) => api.createEnvironment(workspaceId, projectId, parsed.data)));
  } catch (error) {
    if (isApiError(error, 'ENVIRONMENT_NAME_TAKEN'))
      return failForm(error, { name: 'Name already used' });
    if (isApiError(error, 'ENVIRONMENT_SLUG_TAKEN'))
      return failForm(error, { slug: 'URL already used' });
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  redirect(`${environmentPath(workspaceId, projectId, id)}?created=1`);
}

export async function updateEnvironmentAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const keys = parseExpectedKeys(text(formData, 'expectedKeys'));
  const parsed = updateEnvironmentInputSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? undefined,
    kind: optional(formData.get('kind')),
    color: optional(formData.get('color')),
    icon: optional(formData.get('icon')) ?? null,
    expectedKeys: keys,
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  try {
    await withApi((api) =>
      api.updateEnvironment(workspaceId, projectId, environmentId, parsed.data),
    );
  } catch (error) {
    if (isApiError(error, 'ENVIRONMENT_NAME_TAKEN'))
      return failForm(error, { name: 'Name already used' });
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  return { status: 'success', message: 'Environment saved.' };
}

/** Turning protection off re-verifies the password (step-up) first. */
export async function setEnvironmentProtectionAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  currentlyProtected: boolean,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = z
    .object({
      isProtected: z.boolean(),
      requiredApprovals: z.coerce.number().int().min(0).max(10),
    })
    .safeParse({
      isProtected: formData.get('isProtected') === 'on',
      requiredApprovals: formData.get('requiredApprovals') ?? 0,
    });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  const unprotecting = currentlyProtected && !parsed.data.isProtected;
  const password = text(formData, 'password');
  if (unprotecting && !password) {
    return {
      status: 'error',
      fieldErrors: { password: 'Enter your password' },
      message: 'Removing protection requires your password.',
    };
  }
  try {
    await withApi(async (api) => {
      if (unprotecting) await api.stepUp(password);
      await api.setEnvironmentProtection(workspaceId, projectId, environmentId, {
        isProtected: parsed.data.isProtected,
        requiredApprovals: parsed.data.isProtected ? parsed.data.requiredApprovals : 0,
      });
    });
  } catch (error) {
    if (isApiError(error, 'STEP_UP_FAILED'))
      return failForm(error, { password: 'Incorrect password' });
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  return {
    status: 'success',
    message: parsed.data.isProtected ? 'Protection settings saved.' : 'Protection removed.',
  };
}

export async function setEnvironmentArchivedAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  archived: boolean,
): Promise<ActionResult> {
  try {
    await withApi((api) =>
      archived
        ? api.archiveEnvironment(workspaceId, projectId, environmentId)
        : api.restoreEnvironment(workspaceId, projectId, environmentId),
    );
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId, projectId);
  return { ok: true, message: archived ? 'Environment archived.' : 'Environment restored.' };
}

export async function deleteEnvironmentAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  expectedSlug: string,
  isProtected: boolean,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (formData.get('confirmation') !== expectedSlug) {
    return {
      status: 'error',
      fieldErrors: { confirmation: 'Type the environment URL exactly' },
      message: 'Confirmation does not match.',
    };
  }
  const password = text(formData, 'password');
  if (isProtected && !password) {
    return {
      status: 'error',
      fieldErrors: { password: 'Enter your password' },
      message: 'Enter your password.',
    };
  }
  try {
    await withApi(async (api) => {
      if (isProtected) await api.stepUp(password);
      await api.deleteEnvironment(workspaceId, projectId, environmentId);
    });
  } catch (error) {
    if (isApiError(error, 'STEP_UP_FAILED'))
      return failForm(error, { password: 'Incorrect password' });
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  redirect(`${projectPath(workspaceId, projectId)}/environments?deleted=1`);
}

export async function duplicateEnvironmentAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = duplicateEnvironmentInputSchema.safeParse({
    name: formData.get('name'),
    slug: optional(formData.get('slug')),
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  let id: string;
  try {
    ({ id } = await withApi((api) =>
      api.duplicateEnvironment(workspaceId, projectId, environmentId, parsed.data),
    ));
  } catch (error) {
    if (isApiError(error, 'ENVIRONMENT_NAME_TAKEN'))
      return failForm(error, { name: 'Name already used' });
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  redirect(`${environmentPath(workspaceId, projectId, id)}?created=1`);
}

export async function reorderEnvironmentsAction(
  workspaceId: string,
  projectId: string,
  environmentIds: string[],
): Promise<ActionResult> {
  if (!z.array(z.uuid()).min(1).max(500).safeParse(environmentIds).success) {
    return { ok: false, message: 'Invalid order.' };
  }
  try {
    await withApi((api) => api.reorderEnvironments(workspaceId, projectId, environmentIds));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId, projectId);
  return { ok: true };
}

/* ---------------------------------------------------- Environment access */

export async function grantEnvironmentAccessAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const expires = optional(formData.get('expiresAt'));
  const parsed = createEnvironmentGrantInputSchema.safeParse({
    workspaceMembershipId: formData.get('workspaceMembershipId'),
    roleKey: formData.get('roleKey'),
    effect: optional(formData.get('effect')),
    expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : undefined,
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  try {
    await withApi((api) =>
      api.grantEnvironmentAccess(workspaceId, projectId, environmentId, parsed.data),
    );
  } catch (error) {
    return failForm(error);
  }
  refresh(workspaceId, projectId);
  return { status: 'success', message: 'Access updated.' };
}

export async function revokeEnvironmentAccessAction(
  workspaceId: string,
  projectId: string,
  environmentId: string,
  grantId: string,
): Promise<ActionResult> {
  try {
    await withApi((api) =>
      api.revokeEnvironmentAccess(workspaceId, projectId, environmentId, grantId),
    );
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId, projectId);
  return { ok: true, message: 'Grant revoked.' };
}

/* ------------------------------------------------------------ Templates */

/** Saves an environment's structure (never values) as a workspace template. */
export async function saveEnvironmentAsTemplateAction(
  workspaceId: string,
  entry: unknown,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const name = z.string().trim().min(1, 'Enter a name').max(100).safeParse(formData.get('name'));
  if (!name.success)
    return { status: 'error', fieldErrors: { name: 'Enter a name' }, message: 'Enter a name.' };
  const environment = environmentTemplateEntrySchema.safeParse(entry);
  if (!environment.success)
    return { status: 'error', message: 'This environment cannot be saved as a template.' };
  try {
    await withApi((api) =>
      api.createEnvironmentTemplate(workspaceId, {
        name: name.data,
        environments: [environment.data],
      }),
    );
  } catch (error) {
    if (isApiError(error, 'TEMPLATE_NAME_TAKEN'))
      return failForm(error, { name: 'Name already used' });
    return failForm(error);
  }
  return { status: 'success', message: `Template “${name.data}” saved for this workspace.` };
}
