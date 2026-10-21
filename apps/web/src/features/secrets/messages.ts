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
  SECRET_IMPORT_REJECTED:
    'Some selected variables could not be imported. Nothing was changed. Preview again and retry.',
  SECRET_IMPORT_TOO_LARGE: 'The file is larger than the import limit.',
  SECRET_BULK_TOO_LARGE: 'Too many variables are selected for one operation.',
  SECRET_ROLLBACK_NOOP: 'That version is already the current value.',
  SECRET_ROLLBACK_TYPE_MISMATCH:
    "That version does not fit the variable's current type. Change the type first.",
  TOO_MANY_REQUESTS: 'Too many values were read in a short time. Wait a minute and try again.',
});
