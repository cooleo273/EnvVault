import { API_ERROR_MESSAGES } from '@/features/workspaces/messages';

Object.assign(API_ERROR_MESSAGES, {
  ENVIRONMENT_TOO_LARGE: 'This environment has more variables than this feature handles at once.',
  SNAPSHOT_STALE: 'The environment changed since the preview. Nothing was restored; preview again.',
  SNAPSHOT_RESTORE_BLOCKED:
    'The snapshot cannot be restored as is. Resolve the conflicts shown in the preview.',
});
