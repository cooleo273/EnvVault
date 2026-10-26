import { HttpStatus } from '@nestjs/common';
import {
  type EnvironmentRecord,
  getConstraintViolation,
  type NewEnvironmentData,
  type ProjectRecord,
  type Repositories,
  slugify,
} from '@envvault/database';
import {
  AUTH_ERROR_CODES,
  DEFAULT_ENVIRONMENT_COLORS,
  type EnvironmentDetail,
  type EnvironmentSummary,
  type EnvironmentTemplateEntry,
  PROJECT_ERROR_CODES,
  type ProjectDetail,
  type ProjectSummary,
} from '@envvault/shared';
import type { AuthorizedProject } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';

/* ------------------------------------------------------------------ DTOs */

export function toProjectSummary(record: ProjectRecord, viaWorkspaceRole: boolean): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    description: record.description,
    icon: record.icon,
    color: record.color,
    status: record.status,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    environmentCount: record.environmentCount,
    protectedEnvironmentCount: record.protectedEnvironmentCount,
    memberCount: record.memberCount,
    isFavorite: record.isFavorite,
    lastVisitedAt: record.lastVisitedAt?.toISOString() ?? null,
    access: {
      source: record.role || !viaWorkspaceRole ? 'project_member' : 'workspace_role',
      role: record.role,
    },
  };
}

export function toProjectDetail(record: ProjectRecord, project: AuthorizedProject): ProjectDetail {
  return {
    ...toProjectSummary(record, project.access.source === 'workspace_role'),
    access: project.access,
    permissions: [...project.permissions].sort(),
    createdBy: record.createdBy,
  };
}

export function toEnvironmentSummary(record: EnvironmentRecord): EnvironmentSummary {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    slug: record.slug,
    kind: record.kind,
    description: record.description,
    color: record.color,
    icon: record.icon,
    sortOrder: record.sortOrder,
    isProtected: record.isProtected,
    requiredApprovals: record.requiredApprovals,
    status: record.status,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    expectedKeyCount: record.expectedKeys.length,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toEnvironmentDetail(
  record: EnvironmentRecord,
  permissions: ReadonlySet<string>,
): EnvironmentDetail {
  return {
    ...toEnvironmentSummary(record),
    expectedKeys: record.expectedKeys,
    baseEnvironmentId: record.baseEnvironmentId,
    permissions: [...permissions].sort(),
    createdBy: record.createdBy,
  };
}

/* ----------------------------------------------------------------- Slugs */

/** First free slug: `base`, `base-2`, `base-3`, ... (within the given set). */
export function uniqueSlug(base: string, used: ReadonlySet<string>): string {
  const root = (base || 'item').slice(0, 56).replace(/-+$/g, '') || 'item';
  if (!used.has(root)) return root;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${root}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('No free slug');
}

/**
 * Turns template entries into environment rows for one project: generates
 * unique slugs, rejects duplicate names (case-insensitive) and assigns order.
 */
export function planEnvironments(
  entries: readonly EnvironmentTemplateEntry[],
  existing: { slugs: Set<string>; names: Set<string> },
  firstSortOrder = 0,
): NewEnvironmentData[] {
  const slugs = new Set(existing.slugs);
  const names = new Set(existing.names);
  return entries.map((entry, index) => {
    const lower = entry.name.trim().toLowerCase();
    if (names.has(lower)) throw environmentNameTaken(entry.name);
    names.add(lower);
    const slug =
      entry.slug && !slugs.has(entry.slug)
        ? entry.slug
        : uniqueSlug(entry.slug ?? slugify(entry.name), slugs);
    slugs.add(slug);
    return {
      name: entry.name.trim(),
      slug,
      kind: entry.kind,
      description: entry.description ?? null,
      color: entry.color ?? DEFAULT_ENVIRONMENT_COLORS[entry.kind],
      icon: entry.icon ?? null,
      isProtected: entry.isProtected,
      expectedKeys: entry.expectedKeys,
      sortOrder: firstSortOrder + index * 10,
    };
  });
}

/* ---------------------------------------------------------------- Errors */

export function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
}

export function environmentNameTaken(name: string): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    PROJECT_ERROR_CODES.ENVIRONMENT_NAME_TAKEN,
    `An environment named “${name.trim()}” already exists in this project`,
  );
}

export function protectionRequired(): ApiException {
  return new ApiException(
    HttpStatus.FORBIDDEN,
    PROJECT_ERROR_CODES.PROTECTION_REQUIRED,
    'This environment is protected. Changing it requires the environment:protect permission.',
  );
}

export function cannotChangeOwnAccess(): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    PROJECT_ERROR_CODES.CANNOT_CHANGE_OWN_ACCESS,
    'You cannot change your own project role or environment access.',
  );
}

/** Maps unique-constraint violations of projects and environments to 409s. */
export function mapConstraintError(error: unknown): never {
  const violation = getConstraintViolation(error);
  switch (violation?.constraint) {
    case 'projects_workspace_slug_live_key':
      throw new ApiException(
        HttpStatus.CONFLICT,
        PROJECT_ERROR_CODES.PROJECT_SLUG_TAKEN,
        'A project with that URL already exists in this workspace',
      );
    case 'environments_project_slug_live_key':
      throw new ApiException(
        HttpStatus.CONFLICT,
        PROJECT_ERROR_CODES.ENVIRONMENT_SLUG_TAKEN,
        'An environment with that URL already exists in this project',
      );
    case 'environments_project_name_live_key':
      throw new ApiException(
        HttpStatus.CONFLICT,
        PROJECT_ERROR_CODES.ENVIRONMENT_NAME_TAKEN,
        'An environment with that name already exists in this project',
      );
    case 'environment_templates_workspace_id_name_key':
      throw new ApiException(
        HttpStatus.CONFLICT,
        PROJECT_ERROR_CODES.TEMPLATE_NAME_TAKEN,
        'A template with that name already exists',
      );
    default:
      throw error;
  }
}

/** Throws 403 STEP_UP_REQUIRED unless the caller re-verified recently. */
export async function assertRecentStepUp(repos: Repositories, userId: string): Promise<void> {
  const expiry = await repos.authState.findActiveStepUpExpiry(userId);
  if (!expiry) {
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      AUTH_ERROR_CODES.STEP_UP_REQUIRED,
      'Confirm your password to continue',
    );
  }
}
