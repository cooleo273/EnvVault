import { API_ERROR_MESSAGES } from '@/features/workspaces/messages';

Object.assign(API_ERROR_MESSAGES, {
  SECRET_KEY_TAKEN: 'A variable with that name already exists in this environment.',
  SECRET_CONFLICT:
    'Someone else changed this variable while you were editing. Reload to see the latest version.',
  SECRET_NOT_DELETED: 'This variable is not deleted.',
  SECRET_VALUE_NOT_SET: 'This variable has no value yet.',
  SECRET_VALUE_REQUIRED: 'Enter a value of the new type when changing to it.',
  ENCRYPTION_UNAVAILABLE:
    'Encryption keys are unavailable, so values cannot be stored or read right now. Contact an administrator.',
  SECRET_INTEGRITY_ERROR:
    'The stored value failed an integrity check and was not shown. Contact an administrator.',
  AUDIT_UNAVAILABLE: 'The value was not shown because the access could not be recorded. Try again.',
  BAD_REQUEST: 'Please check the values you entered.',
});
