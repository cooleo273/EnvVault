# Configuration validation and readiness

Validation rules describe what an environment needs. The readiness check applies them, together
with required flags, variable types and template keys, and reports one of four statuses. It
never claims a check passed when it did not run.

Code: `apps/api/src/intelligence/validation.service.ts`, `readiness.service.ts`,
`safe-match.ts`, `packages/shared/src/domain/safe-pattern.ts`.

## 1. Rules

One rule per variable name per environment, up to 200, replaced as a whole set.

| Field           | Effect                                                              |
| --------------- | ------------------------------------------------------------------- |
| `required`      | The variable must exist (locally or inherited) and have a value     |
| `allowEmpty`    | When false, an empty value fails (distinct from a missing variable) |
| `format`        | `ANY`, `URL` (with a scheme), `JSON`, `NUMBER`                      |
| `minNumber`     | Numeric lower bound (implies a number)                              |
| `maxNumber`     | Numeric upper bound (implies a number)                              |
| `minLength`     | Length bounds in Unicode code points                                |
| `maxLength`     | Length bounds in Unicode code points                                |
| `pattern`       | The whole value must match (see section 2)                          |
| `allowedValues` | Up to 50 exact values                                               |
| `description`   | Shown to people fixing the issue                                    |

The key `*` is the **naming rule**: its pattern applies to every local variable name, and it
cannot be required.

Variable types are always checked as well (for example a `NUMBER` variable must hold a number),
with or without a rule.

## 2. Safe patterns

Patterns are user supplied regular expressions, so they are restricted before they are stored:

1. At most 200 characters and 4 unbounded quantifiers.
2. No backreferences, no lookahead or lookbehind.
3. No repeated group that itself contains repetition or alternatives (the classic catastrophic
   backtracking shapes such as `(a+)+`); an optional group `(...)?` is allowed.
4. It must compile.

At check time the pattern runs in a `node:vm` context with a 50 ms timeout, and only on values
up to 16 KiB. A timeout or an oversized value reports the check as **not checked**, never as
passed.

## 3. Readiness

`POST .../environments/{e}/readiness` with `{ "inspectValues": false }`.

| Check              | Without values                  | With `inspectValues`                |
| ------------------ | ------------------------------- | ----------------------------------- |
| Inheritance        | yes                             | yes                                 |
| Required variables | yes (existence and has a value) | yes                                 |
| Template keys      | yes                             | yes                                 |
| Naming rule        | yes (names are metadata)        | yes                                 |
| Case duplicates    | yes                             | yes                                 |
| Override types     | yes                             | yes                                 |
| Value rules, types | reported as not checked         | decrypted and checked on the server |

Issue severities and the resulting status, in order of precedence:

1. **BLOCKED**: any blocking issue (`REQUIRED_MISSING`, `REQUIRED_NO_VALUE`,
   `NAME_NOT_ALLOWED`, `INHERITANCE_BROKEN`, a failed value rule or type).
2. **UNKNOWN**: no blocking issue, but something could not be checked (`VALUE_NOT_INSPECTED`,
   `INHERITANCE_NOT_VISIBLE`, `NAME_NOT_CHECKED`, a pattern that timed out).
3. **WARNING**: only warnings (`TEMPLATE_KEY_MISSING`, `CASE_DUPLICATE`,
   `OVERRIDE_TYPE_CHANGE`, `PROTECTED_INHERITS`).
4. **READY**: every check that ran passed and nothing was skipped that a rule depends on.

Messages describe the rule, never the value. Value inspection needs `secret:read`, a step up for
protected environments and the `bulk-read` rate limit, and is audited as
`environment.readiness_values_inspected` with counts. Inherited variables are inspected in their
base environment, under the caller's access there.

## 4. API and permissions

| Route                                       | Permission                                                  |
| ------------------------------------------- | ----------------------------------------------------------- |
| `GET .../environments/{e}/validation-rules` | `secret:list`                                               |
| `PUT .../environments/{e}/validation-rules` | `environment:update` (+ `environment:protect` if protected) |
| `POST .../environments/{e}/readiness`       | `secret:list` (+ `secret:read` and step up to inspect)      |

Rule changes are audited as `environment.validation_rules_updated`. SDK: `validationRules`,
`replaceValidationRules`, `evaluateReadiness`.

## 5. Web

1. **Settings, Validation rules**: add, edit and remove rules, then save the set. Patterns are
   validated in the browser with the same checks as the API.
2. **Readiness** tab: status, coverage, each check with its outcome, and issues with remediation.
   **Check values too** appears only with `secret:read`.

## 6. Limitations

1. Readiness is evaluated on request; it is not stored or scheduled.
2. Rules are per environment; there is no project wide rule set yet.
