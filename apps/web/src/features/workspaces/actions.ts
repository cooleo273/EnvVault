'use server';

import {
  createInvitationInputSchema,
  createWorkspaceInputSchema,
  INVITATION_TOKEN_PATTERN,
  type IssuedInvitation,
  type ReceivedInvitation,
  updateWorkspaceInputSchema,
  workspaceRoleKeySchema,
} from '@envvault/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { AUTH_ROUTES } from '@/config/routes';
import { isApiError, withApi } from '@/lib/api/server-api';
import type { ActionResult, FormState } from '@/lib/form-state';
import { messageFor } from './messages';

/**
 * Workspace, member and invitation server actions. Every input, including
 * ids bound to an action, is client-controlled: the API authorizes each call
 * against the signed-in user's memberships, so nothing here is evidence of
 * access. Errors are mapped to fixed messages by code.
 */

const SESSION_ENDED = ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_INVALID'];

function failure(error: unknown): { message: string; code: string | undefined } {
  if (isApiError(error) && SESSION_ENDED.includes(error.code)) redirect(AUTH_ROUTES.login);
  return {
    message: messageFor(isApiError(error) ? error.code : undefined),
    code: isApiError(error) ? error.code : undefined,
  };
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: failure(error).message };
}

function failForm(error: unknown, fieldErrors?: Record<string, string>): FormState {
  return {
    status: 'error',
    message: failure(error).message,
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

function zodFieldErrors(error: z.ZodError): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message;
  return { status: 'error', message: 'Please correct the highlighted fields.', fieldErrors };
}

function refresh(workspaceId?: string) {
  revalidatePath('/', 'layout');
  if (workspaceId) revalidatePath(`/workspaces/${workspaceId}`, 'layout');
}

/* -------------------------------------------------------------- Workspaces */

const emptyToUndefined = (value: FormDataEntryValue | null) =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

export async function createWorkspaceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = createWorkspaceInputSchema.safeParse({
    name: formData.get('name'),
    slug: emptyToUndefined(formData.get('slug')),
    description: emptyToUndefined(formData.get('description')),
    type: emptyToUndefined(formData.get('type')),
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);

  let id: string;
  try {
    ({ id } = await withApi((api) => api.createWorkspace(parsed.data)));
  } catch (error) {
    if (isApiError(error, 'SLUG_TAKEN')) {
      return failForm(error, { slug: 'That URL is already taken' });
    }
    return failForm(error);
  }
  refresh();
  // Onboarding continues to the dashboard; elsewhere open the new workspace.
  redirect(
    formData.get('next') === 'dashboard' ? '/dashboard?welcome=1' : `/workspaces/${id}?created=1`,
  );
}

export async function updateWorkspaceAction(
  workspaceId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = updateWorkspaceInputSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? undefined,
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  try {
    await withApi((api) => api.updateWorkspace(workspaceId, parsed.data));
  } catch (error) {
    return failForm(error);
  }
  refresh(workspaceId);
  return { status: 'success', message: 'Workspace settings saved.' };
}

export async function archiveWorkspaceAction(workspaceId: string): Promise<ActionResult> {
  try {
    await withApi((api) => api.archiveWorkspace(workspaceId));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId);
  return { ok: true, message: 'Workspace archived. It is now read-only.' };
}

export async function restoreWorkspaceAction(workspaceId: string): Promise<ActionResult> {
  try {
    await withApi((api) => api.restoreWorkspace(workspaceId));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId);
  return { ok: true, message: 'Workspace restored.' };
}

const passwordSchema = z.string().min(1, 'Enter your password').max(1024);

/**
 * Deletes a workspace: a sensitive action. The API requires `workspace:delete`
 * AND a fresh step-up, so the password is re-verified with Neon Auth first.
 */
export async function deleteWorkspaceAction(
  workspaceId: string,
  expectedSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const password = passwordSchema.safeParse(formData.get('password'));
  if (!password.success) {
    return {
      status: 'error',
      fieldErrors: { password: 'Enter your password' },
      message: 'Enter your password.',
    };
  }
  if (formData.get('confirmation') !== expectedSlug) {
    return {
      status: 'error',
      fieldErrors: { confirmation: 'Type the workspace URL exactly' },
      message: 'Confirmation does not match.',
    };
  }
  try {
    await withApi(async (api) => {
      await api.stepUp(password.data);
      await api.deleteWorkspace(workspaceId);
    });
  } catch (error) {
    if (isApiError(error, 'STEP_UP_FAILED')) {
      return failForm(error, { password: 'Incorrect password' });
    }
    return failForm(error);
  }
  refresh();
  redirect('/workspaces?deleted=1');
}

/** Sensitive: re-verifies the password, then hands ownership to another member. */
export async function transferOwnershipAction(
  workspaceId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const membershipId = z.uuid().safeParse(formData.get('membershipId'));
  if (!membershipId.success) {
    return {
      status: 'error',
      fieldErrors: { membershipId: 'Choose a member' },
      message: 'Choose a member.',
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
      await api.transferOwnership(workspaceId, membershipId.data);
    });
  } catch (error) {
    if (isApiError(error, 'STEP_UP_FAILED')) {
      return failForm(error, { password: 'Incorrect password' });
    }
    return failForm(error);
  }
  refresh(workspaceId);
  redirect(`/workspaces/${workspaceId}/members?transferred=1`);
}

export async function leaveWorkspaceAction(workspaceId: string): Promise<ActionResult> {
  try {
    await withApi((api) => api.leaveWorkspace(workspaceId));
  } catch (error) {
    return fail(error);
  }
  refresh();
  redirect('/dashboard?left=1');
}

/** Remembers the selection (if the API confirms access) and opens the workspace. */
export async function selectWorkspaceAction(workspaceId: string): Promise<void> {
  if (!z.uuid().safeParse(workspaceId).success) redirect('/workspaces');
  try {
    await withApi((api) => api.setActiveWorkspace(workspaceId));
  } catch (error) {
    failure(error);
    redirect('/workspaces');
  }
  redirect(`/workspaces/${workspaceId}`);
}

/* ----------------------------------------------------------------- Members */

export async function changeMemberRoleAction(
  workspaceId: string,
  membershipId: string,
  roleKey: string,
): Promise<ActionResult> {
  const role = workspaceRoleKeySchema.safeParse(roleKey);
  if (!role.success) return { ok: false, message: 'Choose a valid role.' };
  try {
    await withApi((api) => api.changeMemberRole(workspaceId, membershipId, role.data));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId);
  return { ok: true, message: 'Role updated.' };
}

export async function removeMemberAction(
  workspaceId: string,
  membershipId: string,
): Promise<ActionResult> {
  try {
    await withApi((api) => api.removeMember(workspaceId, membershipId));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId);
  return { ok: true, message: 'Member removed.' };
}

/* ------------------------------------------------------------- Invitations */

export interface InviteFormState extends FormState {
  issued?: {
    email: string;
    delivery: IssuedInvitation['delivery']['status'];
    acceptUrl: string | null;
  };
}

function issuedState(issued: IssuedInvitation): InviteFormState {
  const emailed = issued.delivery.status === 'sent';
  return {
    status: 'success',
    message: emailed
      ? `Invitation emailed to ${issued.invitation.email}.`
      : `Invitation created for ${issued.invitation.email}. It was not emailed: share the link below.`,
    issued: {
      email: issued.invitation.email,
      delivery: issued.delivery.status,
      acceptUrl: issued.acceptUrl,
    },
  };
}

export async function inviteMemberAction(
  workspaceId: string,
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const parsed = createInvitationInputSchema.safeParse({
    email: formData.get('email'),
    roleKey: formData.get('roleKey'),
  });
  if (!parsed.success) return zodFieldErrors(parsed.error);
  try {
    const issued = await withApi((api) => api.inviteMember(workspaceId, parsed.data));
    refresh(workspaceId);
    return issuedState(issued);
  } catch (error) {
    if (isApiError(error, 'ALREADY_MEMBER') || isApiError(error, 'INVITATION_PENDING')) {
      return failForm(error, { email: messageFor(error.code) });
    }
    return failForm(error);
  }
}

export async function resendInvitationAction(
  workspaceId: string,
  invitationId: string,
): Promise<ActionResult & { acceptUrl?: string | null }> {
  try {
    const issued = await withApi((api) => api.resendInvitation(workspaceId, invitationId));
    refresh(workspaceId);
    return { ok: true, message: issuedState(issued).message ?? '', acceptUrl: issued.acceptUrl };
  } catch (error) {
    return fail(error);
  }
}

export async function revokeInvitationAction(
  workspaceId: string,
  invitationId: string,
): Promise<ActionResult> {
  try {
    await withApi((api) => api.revokeInvitation(workspaceId, invitationId));
  } catch (error) {
    return fail(error);
  }
  refresh(workspaceId);
  return { ok: true, message: 'Invitation revoked. The link no longer works.' };
}

type InvitationRef = { token: string } | { id: string };

function parseRef(ref: InvitationRef): InvitationRef | null {
  if ('token' in ref) return INVITATION_TOKEN_PATTERN.test(ref.token) ? { token: ref.token } : null;
  return z.uuid().safeParse(ref.id).success ? { id: ref.id } : null;
}

export async function acceptInvitationAction(ref: InvitationRef): Promise<ActionResult> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, message: messageFor('INVITATION_INVALID') };
  let workspaceId: string;
  try {
    ({ workspaceId } = await withApi((api) => api.acceptInvitation(parsed)));
  } catch (error) {
    return fail(error);
  }
  refresh();
  redirect(`/workspaces/${workspaceId}?joined=1`);
}

export async function declineInvitationAction(ref: InvitationRef): Promise<ActionResult> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, message: messageFor('INVITATION_INVALID') };
  try {
    await withApi((api) => api.declineInvitation(parsed));
  } catch (error) {
    return fail(error);
  }
  refresh();
  return { ok: true, message: 'Invitation declined.' };
}

export type InvitationLookup =
  | { status: 'ok'; invitation: ReceivedInvitation }
  | { status: 'signed_out' }
  | { status: 'error'; message: string };

/** Resolves an invitation link for the invite page. Never throws or redirects. */
export async function lookupInvitationAction(token: string): Promise<InvitationLookup> {
  if (!INVITATION_TOKEN_PATTERN.test(token)) {
    return { status: 'error', message: messageFor('INVITATION_INVALID') };
  }
  try {
    return { status: 'ok', invitation: await withApi((api) => api.lookupInvitation(token)) };
  } catch (error) {
    if (isApiError(error) && SESSION_ENDED.includes(error.code)) return { status: 'signed_out' };
    if (isApiError(error, 'EMAIL_NOT_VERIFIED')) {
      return {
        status: 'error',
        message: 'Verify your email address first, then open the link again.',
      };
    }
    return { status: 'error', message: messageFor(isApiError(error) ? error.code : undefined) };
  }
}
