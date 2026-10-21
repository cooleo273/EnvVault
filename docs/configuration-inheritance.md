# Configuration inheritance

An environment can use one other environment of the same project as its **base**. Variables of
the base that are marked **inheritable** apply to the inheriting environment unless it defines a
variable with the same name (an override). Nothing is copied: inheritance is resolved every time
the configuration is read.

Code: `apps/api/src/intelligence/configuration.service.ts`, database trigger
`envvault_check_environment_inheritance` in migration `20261023090000_environment_intelligence`.

## 1. Rules

1. **One level.** A base cannot itself inherit, and an environment that is a base cannot get a
   base. The API checks this, and a database trigger rejects chains and cycles under a per
   project advisory lock, so two concurrent changes cannot build a cycle.
2. **Explicit eligibility.** Only variables with `inheritable = true` are inherited. The flag
   defaults to false.
3. **No secret inheritance.** `SECRET` variables can never be inheritable (schema validation,
   service check and a `CHECK` constraint). The API refuses to make an inheritable variable a
   `SECRET`; the edit dialog clears the flag when the type changes to `SECRET`.
4. **No protected base.** A protected environment cannot be chosen as a base. A protected
   environment may inherit from an unprotected one; readiness warns about it
   (`PROTECTED_INHERITS`).
5. **Live and active base only.** Archived or deleted environments cannot be chosen. If a base
   is archived, deleted or becomes protected later, nothing is inherited and readiness reports
   `INHERITANCE_BROKEN` (blocking).
6. **Local wins.** A local variable with the same name always overrides the inherited one,
   whatever its own type or flags.

## 2. Visibility

Reading the effective configuration needs `secret:list` on the environment. Inherited variables
are shown only when the caller also has `secret:list` on the base. Otherwise the base is reported
with `state: "no_access"` and the name **Restricted environment**, and no inherited variable is
listed. Inheriting never grants access to the base.

Values are never inherited into the browser. Reading an inherited value is a reveal in the base
environment and needs `secret:read` there.

## 3. Changing the base

`PUT .../environments/{e}/inheritance` with `{ "baseEnvironmentId": "uuid" | null }`.

Needs `environment:update` on the environment (plus `environment:protect` when it is protected)
and `secret:list` on the new base. Refusals return `INHERITANCE_INVALID` with a client safe
message (self, chain, protected base, archived, no access). The change is audited as
`environment.inheritance_changed` with the previous and new base ids.

## 4. Effective configuration

`GET .../environments/{e}/effective` returns every local variable plus every inherited one, each
with `source` (`local` or `inherited`), `overridesInherited`, and metadata (never a value), along
with the base reference and its state. SDK: `client.effectiveConfiguration(...)`,
`client.setBaseEnvironment(...)`.

## 5. Web

1. **Settings, Inheritance**: choose or remove the base. Only unprotected, active environments
   are offered.
2. **Overview, Inherited variables**: inherited rows with an **Inherited from** badge and an
   **Override** button that opens the add dialog with the same name and metadata. The value is
   typed by the user; the base value is not read.
3. The variables table marks local variables that override the base, and variables that are
   inheritable.
4. The add and edit dialog has an **Inheritable** switch, disabled for `SECRET`.

## 6. Limitations

1. Exports, imports, snapshots and comparisons work on local variables only.
2. Only one base per environment and one level of inheritance.
