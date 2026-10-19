# EnvVault Design System

The web app's visual language and shared components. Every new module must be
built from these pieces. A live reference with example data is at
**`/design-system`** (Settings → Developer).

## Principles

- **Restrained.** Neutral surfaces, one brand accent (teal) used sparingly for the
  logo, links and focus. No gradients or decorative backgrounds.
- **Meaningful colour.** Colour encodes status (success, warning, danger, info,
  neutral) and is always paired with text or an icon, never used alone.
- **Dense but calm.** 14 px body text, compact controls, tables first. Avoid
  dashboards of repeated cards.
- **Honest.** Unbuilt features are marked **Preview** or **Not available yet**.
  Only data that really comes from the API is marked **Live**. No fake users,
  activity, metrics or secret values outside `/design-system`.
- **Accessible by default.** Keyboard access everywhere, visible focus,
  labelled landmarks, sufficient contrast in both themes, and reduced motion
  respected.

## Tokens

Defined as CSS variables in `apps/web/src/app/globals.css` and exposed as
Tailwind utilities. Typed counterparts are in `apps/web/src/design/tokens.ts`.
**Never use raw colour values or arbitrary sizes when a token exists.**

| Group         | Tokens / utilities                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Surfaces      | `bg-background`, `bg-surface`, `bg-surface-muted`, `bg-popover`, `bg-muted`, `bg-accent` (hover/selected)                                  |
| Text          | `text-foreground`, `text-muted-foreground`, `text-brand`                                                                                   |
| Lines         | `border` (default), `border-border-strong`, `border-input`                                                                                 |
| Actions       | `bg-primary`, `bg-secondary`, `bg-destructive`, `bg-brand`                                                                                 |
| Status        | `text-{success,warning,danger,info,neutral}`, `bg-*-subtle`, `border-*-border` (prefer `STATUS_TONE_CLASSES`)                              |
| Radii         | `rounded-sm` 4px · `rounded-md` 6px · `rounded-lg` 8px · `rounded-xl` 12px                                                                 |
| Elevation     | `shadow-xs` (controls), `shadow-sm`, `shadow-popover` (menus), `shadow-overlay` (dialogs)                                                  |
| Type          | `text-2xs` badges · `text-xs` meta · `text-sm` body · `text-xl` page title; `font-mono` for keys, slugs and permissions (see `TYPE_SCALE`) |
| Sizing        | `h-header`, `w-sidebar`, `h-control-sm/control/control-lg`, `max-w-content`                                                                |
| Table density | `data-density="compact \| default \| comfortable"` sets `--table-row-h` (`h-(--table-row-h)`)                                              |
| Focus         | `focus-ring` utility: 2px outline in `--ring`; works in forced-colours mode                                                                |

Themes: light, dark, or follow the system (`next-themes`, class strategy on `<html>`).
Every token is redefined under `.dark`.

## Components

| Area       | Component                                                                              | Notes                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout     | `AppShell`, `AppSidebar`, `AppHeader`, `WorkspaceSwitcher`                             | Fixed sidebar ≥ `lg`, drawer below; skip link                                                                                                               |
|            | `PageHeader`, `Breadcrumbs`                                                            | One `h1` per page; `status="live" \| "preview"`                                                                                                             |
|            | `ModulePlaceholder`                                                                    | Standard page for designed-but-unbuilt modules                                                                                                              |
| Data       | `DataTable`                                                                            | Sortable (`aria-sort`), paginated, responsive column hiding, density, loading/empty/error states                                                            |
|            | `Pagination`, `SearchInput`, `FilterDropdown`                                          | Keyboard-accessible; Escape clears search                                                                                                                   |
| Feedback   | `StatusBadge`, `EmptyState` (`empty` / `placeholder`), `ErrorState`, `LoadingSkeleton` | States are announced to screen readers                                                                                                                      |
|            | `ConfirmDialog`                                                                        | Alert dialog; optional typed confirmation; async with failure handling                                                                                      |
|            | `ResponsiveModal`                                                                      | Bottom sheet on mobile, centred dialog from `sm`                                                                                                            |
|            | `Toaster` + `notify`                                                                   | Never put secrets or raw server errors in toasts                                                                                                            |
| Forms      | `FormField`                                                                            | Wires `id`, `aria-describedby`, `aria-invalid`, `required`                                                                                                  |
|            | `CopyField`                                                                            | Non-secret values only                                                                                                                                      |
|            | `SecretMaskedField`                                                                    | Value loaded **on demand** via `loadValue` (authorize and audit server-side); fixed-length mask; auto re-mask (30 s); value dropped from memory when hidden |
| Domain     | `EnvironmentBadge`, `PermissionBadge`                                                  | Driven by `@envvault/shared` contracts; sensitive permissions highlighted                                                                                   |
| Primitives | `components/ui/*`                                                                      | Button, Badge, Input, Label, Separator, Skeleton, Kbd, Dialog, AlertDialog, DropdownMenu (Radix)                                                            |

## Building a new module

1. Add the route under `app/(app)/` and the nav entry in `config/navigation.ts`.
2. Start the page with `PageHeader` (breadcrumbs, description, primary action).
3. Lists use `DataTable` with a `caption`, an `isRowHeader` column, `emptyState`
   and `errorState`. Use `pageSize={false}` with an external `Pagination` for
   server-side paging.
4. Use `ConfirmDialog` with `confirmationText` for destructive actions.
5. Change the nav status from `preview` to `live` only once the module reads real data.
