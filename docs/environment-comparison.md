# Environment comparison

Compare two environments of the same project side by side: which variable names exist where,
and how their metadata differs. Value equality is available on request, computed on the server
and never shown.

Code: `apps/api/src/intelligence/comparison.service.ts`, web
`apps/web/src/features/intelligence/environment-comparison.tsx`.

## 1. What is compared

Rows are keyed by variable name across both environments (live variables only, up to 2000 per
environment; larger environments get `ENVIRONMENT_TOO_LARGE`).

| Status        | Meaning                              |
| ------------- | ------------------------------------ |
| `both`        | The name exists in source and target |
| `only_source` | Missing from the target              |
| `only_target` | Missing from the source              |

For `both`, `differences` lists the metadata fields that differ: `type`, `isRequired`,
`category`, `tags`, `description`, `inheritable` and `hasValue`. The summary counts type and
required mismatches separately because they are the ones most likely to break a deployment.

Present in both never means the same value. By default every row reports `value:
"not_checked"`.

## 2. Value comparison

`compareValues: true` asks the server to decrypt the current version of each shared name in both
environments and compare the plaintexts in memory with a constant time comparison. The result
per row is `equal`, `different`, or `not_comparable` (one side has no value). Plaintext,
ciphertext, wrapped data keys and authentication tags never leave the API; nothing derived from
a value (no hash, no fingerprint) is stored or returned.

Requirements for value comparison:

1. `secret:read` in both environments (refusals are audited as `secret.access_denied`).
2. A recent password step up when either environment is protected (`STEP_UP_REQUIRED`).
3. The per user `bulk-read` rate limit, shared with export and value inspecting readiness.

Each value comparison is audited as `environment.values_compared` in both environments, with
counts only. A plain metadata comparison is audited as `environment.compared`.

## 3. API

`POST /api/v1/workspaces/{w}/projects/{p}/environments/compare`

```json
{
  "sourceEnvironmentId": "uuid",
  "targetEnvironmentId": "uuid",
  "compareValues": false,
  "filter": "all",
  "q": "DATABASE",
  "page": 1,
  "pageSize": 100
}
```

`filter` is one of `all`, `differences`, `both`, `only_source`, `only_target`, `metadata`. The
route needs `project:read`; the service then requires `secret:list` on both environments (a
missing environment and one the caller cannot see both return 404). SDK:
`client.compareEnvironments(w, p, input)`.

## 4. Web

`/workspaces/{w}/projects/{p}/compare` (the **Compare** tab of a project). Source and target
live in the URL (`?source=&target=`); search, filters and paging reload through a server action.
**Compare values** is a toggle; a protected environment opens the password dialog first.

## 5. Limitations

1. One page of rows per request; the summary always covers the whole comparison.
2. Inherited variables are not part of the comparison; it compares what each environment defines
   itself. The effective configuration of an environment is on its overview page.
3. Archived environments can be compared (read only); deleted ones cannot.
