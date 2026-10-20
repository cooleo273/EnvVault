/**
 * User-facing messages for API error codes. Kept client-safe: the codes come
 * from the API's error envelope, never from raw exception text.
 */
export const API_ERROR_MESSAGES: Record<string, string> = {
  SLUG_TAKEN: 'That workspace URL is already taken. Choose another.',
  WORKSPACE_ARCHIVED: 'This workspace is archived. Restore it to make changes.',
  WORKSPACE_NOT_ARCHIVED: 'This workspace is not archived.',
  LAST_OWNER: 'A workspace needs at least one owner. Transfer ownership first.',
  OWNER_REQUIRED: 'Only owners can change or remove owners.',
  CANNOT_CHANGE_OWN_ROLE: 'You cannot change your own role. Transfer ownership or leave instead.',
  ALREADY_MEMBER: 'That person is already a member of this workspace.',
  INVITATION_PENDING: 'An invitation for that email is already pending. Resend or revoke it.',
  INVITATION_INVALID: 'This invitation is invalid, already used, or has expired.',
  INVITATION_EMAIL_MISMATCH:
    'This invitation was sent to a different email address. Sign in with that address to accept it.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'Not found, or you no longer have access.',
  STEP_UP_FAILED: 'Incorrect password.',
  STEP_UP_REQUIRED: 'Confirm your password to continue.',
  TOO_MANY_REQUESTS: 'Too many attempts. Wait a minute and try again.',
  AUTH_UNAVAILABLE: 'Authentication is temporarily unavailable. Try again shortly.',
  VALIDATION_FAILED: 'Please check the values you entered.',
};

export const GENERIC_ERROR = 'Something went wrong. Please try again.';

export function messageFor(code: string | undefined): string {
  return (code === undefined ? undefined : API_ERROR_MESSAGES[code]) ?? GENERIC_ERROR;
}

Object.assign(API_ERROR_MESSAGES, {
  PROJECT_SLUG_TAKEN: 'A project with that URL already exists in this workspace.',
  PROJECT_ARCHIVED: 'This project is archived. Restore it to make changes.',
  PROJECT_NOT_ARCHIVED: 'This project is not archived.',
  ENVIRONMENT_SLUG_TAKEN: 'An environment with that URL already exists in this project.',
  ENVIRONMENT_NAME_TAKEN: 'An environment with that name already exists in this project.',
  ENVIRONMENT_ARCHIVED: 'This environment is archived. Restore it to make changes.',
  ENVIRONMENT_NOT_ARCHIVED: 'This environment is not archived.',
  PROTECTION_REQUIRED:
    'This environment is protected. Only people who can manage protection may change it.',
  NOT_WORKSPACE_MEMBER: 'Only active members of this workspace can be added.',
  ALREADY_PROJECT_MEMBER: 'That person is already a member of this project.',
  NOT_PROJECT_MEMBER: 'Add this person to the project before granting environment access.',
  CANNOT_CHANGE_OWN_ACCESS: 'You cannot change your own project role or environment access.',
  TEMPLATE_NOT_FOUND: 'That template no longer exists.',
  TEMPLATE_NAME_TAKEN: 'A template with that name already exists.',
});
