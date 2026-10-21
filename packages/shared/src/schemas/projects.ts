import { z } from 'zod';
import {
  environmentKindSchema,
  environmentTemplateEntrySchema,
  expectedKeySchema,
  visualColorSchema,
  visualIconSchema,
} from '../domain/environments.js';
import { roleRefSchema } from './workspaces.js';

/** Error codes (`error.code`) of the project and environment APIs. */
export const PROJECT_ERROR_CODES = {
  PROJECT_SLUG_TAKEN: 'PROJECT_SLUG_TAKEN',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  PROJECT_NOT_ARCHIVED: 'PROJECT_NOT_ARCHIVED',
  ENVIRONMENT_SLUG_TAKEN: 'ENVIRONMENT_SLUG_TAKEN',
  ENVIRONMENT_NAME_TAKEN: 'ENVIRONMENT_NAME_TAKEN',
  ENVIRONMENT_ARCHIVED: 'ENVIRONMENT_ARCHIVED',
  ENVIRONMENT_NOT_ARCHIVED: 'ENVIRONMENT_NOT_ARCHIVED',
  /** Protected environments need `environment:protect` (and sometimes step-up). */
  PROTECTION_REQUIRED: 'PROTECTION_REQUIRED',
  NOT_WORKSPACE_MEMBER: 'NOT_WORKSPACE_MEMBER',
  ALREADY_PROJECT_MEMBER: 'ALREADY_PROJECT_MEMBER',
  NOT_PROJECT_MEMBER: 'NOT_PROJECT_MEMBER',
  /** Nobody changes their own project role or environment grants. */
  CANNOT_CHANGE_OWN_ACCESS: 'CANNOT_CHANGE_OWN_ACCESS',
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  TEMPLATE_NAME_TAKEN: 'TEMPLATE_NAME_TAKEN',
} as const;

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single dashes');
const descriptionSchema = z.string().trim().max(1000, 'Use at most 1000 characters');

/* ------------------------------------------------------------- Pagination */

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int().nonnegative(),
  });
}
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/* -------------------------------------------------------------- Roles */

export const PROJECT_ROLE_KEYS = [
  'project-admin',
  'project-developer',
  'project-viewer',
  'project-deployer',
] as const;
export const projectRoleKeySchema = z.enum(PROJECT_ROLE_KEYS);
export type ProjectRoleKey = z.infer<typeof projectRoleKeySchema>;

export const ENVIRONMENT_ROLE_KEYS = [
  'environment-viewer',
  'environment-maintainer',
  'environment-deployer',
  'environment-reader',
  'environment-writer',
  'environment-exporter',
  'environment-approver',
] as const;
export const environmentRoleKeySchema = z.enum(ENVIRONMENT_ROLE_KEYS);
export type EnvironmentRoleKey = z.infer<typeof environmentRoleKeySchema>;

export const scopedRoleSchema = roleRefSchema.extend({
  description: z.string().nullable(),
  permissions: z.array(z.string()),
});
export type ScopedRole = z.infer<typeof scopedRoleSchema>;

/* ------------------------------------------------------------ Projects */

export const PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectAccessSchema = z.object({
  /** How the caller has access: explicit project role or workspace administration. */
  source: z.enum(['project_member', 'workspace_role']),
  role: roleRefSchema.nullable(),
});

export const projectSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  icon: z.string(),
  color: z.string(),
  status: projectStatusSchema,
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  environmentCount: z.number().int().nonnegative(),
  protectedEnvironmentCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  isFavorite: z.boolean(),
  lastVisitedAt: z.iso.datetime().nullable(),
  access: projectAccessSchema,
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectDetailSchema = projectSummarySchema.extend({
  /** The caller's effective project permissions. */
  permissions: z.array(z.string()),
  createdBy: z.object({ displayName: z.string().nullable(), email: z.string() }).nullable(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const PROJECT_SORTS = ['name', 'updated', 'created', 'recent'] as const;
export const listProjectsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  favorite: z.enum(['true', 'false']).optional(),
  sort: z.enum(PROJECT_SORTS).default('name'),
  order: z.enum(['asc', 'desc']).optional(),
});
export type ListProjectsQuery = z.input<typeof listProjectsQuerySchema>;

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100, 'Use at most 100 characters'),
  slug: slugSchema.optional(),
  description: descriptionSchema.optional(),
  icon: visualIconSchema.default('folder'),
  color: visualColorSchema.default('slate'),
  /** Initial environments (e.g. from templates). Any number, including none. */
  environments: z.array(environmentTemplateEntrySchema).max(50).default([]),
});
export type CreateProjectInput = z.input<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(100).optional(),
    description: descriptionSchema.nullable().optional(),
    icon: visualIconSchema.optional(),
    color: visualColorSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type UpdateProjectInput = z.input<typeof updateProjectInputSchema>;

/** Copies metadata and environment structure; never members, grants or secrets. */
export const duplicateProjectInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  slug: slugSchema.optional(),
});
export type DuplicateProjectInput = z.input<typeof duplicateProjectInputSchema>;

/* -------------------------------------------------------- Environments */

export const ENVIRONMENT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export const environmentStatusSchema = z.enum(ENVIRONMENT_STATUSES);

export const environmentSummarySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  kind: environmentKindSchema,
  description: z.string().nullable(),
  color: z.string(),
  icon: z.string().nullable(),
  sortOrder: z.number().int(),
  isProtected: z.boolean(),
  requiredApprovals: z.number().int(),
  status: environmentStatusSchema,
  archivedAt: z.iso.datetime().nullable(),
  expectedKeyCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EnvironmentSummary = z.infer<typeof environmentSummarySchema>;

export const environmentDetailSchema = environmentSummarySchema.extend({
  expectedKeys: z.array(expectedKeySchema),
  /** The caller's effective permissions in this environment. */
  permissions: z.array(z.string()),
  createdBy: z.object({ displayName: z.string().nullable(), email: z.string() }).nullable(),
});
export type EnvironmentDetail = z.infer<typeof environmentDetailSchema>;

export const listEnvironmentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  kind: environmentKindSchema.optional(),
});
export type ListEnvironmentsQuery = z.input<typeof listEnvironmentsQuerySchema>;

const environmentNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(64, 'Use at most 64 characters');

export const createEnvironmentInputSchema = z.object({
  name: environmentNameSchema,
  slug: slugSchema.optional(),
  kind: environmentKindSchema.default('OTHER'),
  description: descriptionSchema.optional(),
  color: visualColorSchema.optional(),
  icon: visualIconSchema.optional(),
  isProtected: z.boolean().default(false),
  expectedKeys: z.array(expectedKeySchema).max(200).default([]),
  /** The template the definition came from (recorded in the audit log). */
  templateId: z.string().max(100).optional(),
});
export type CreateEnvironmentInput = z.input<typeof createEnvironmentInputSchema>;

/** Metadata only. The slug is a stable identifier and cannot change. */
export const updateEnvironmentInputSchema = z
  .object({
    name: environmentNameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    kind: environmentKindSchema.optional(),
    color: visualColorSchema.optional(),
    icon: visualIconSchema.nullable().optional(),
    expectedKeys: z.array(expectedKeySchema).max(200).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type UpdateEnvironmentInput = z.input<typeof updateEnvironmentInputSchema>;

/** Protection settings (`environment:protect`; removing protection needs step-up). */
export const updateEnvironmentProtectionInputSchema = z
  .object({
    isProtected: z.boolean(),
    /** For the future approval workflow; stored, not enforced yet. */
    requiredApprovals: z.number().int().min(0).max(10).default(0),
  })
  .refine((v) => v.isProtected || v.requiredApprovals === 0, {
    message: 'Approvals require a protected environment',
    path: ['requiredApprovals'],
  });
export type UpdateEnvironmentProtectionInput = z.input<
  typeof updateEnvironmentProtectionInputSchema
>;

export const reorderEnvironmentsInputSchema = z.object({
  environmentIds: z.array(z.uuid()).min(1).max(500),
});
export type ReorderEnvironmentsInput = z.infer<typeof reorderEnvironmentsInputSchema>;

export const duplicateEnvironmentInputSchema = z.object({
  name: environmentNameSchema,
  slug: slugSchema.optional(),
});
export type DuplicateEnvironmentInput = z.input<typeof duplicateEnvironmentInputSchema>;

/* -------------------------------------------------------- Templates */

export const environmentTemplateSchema = z.object({
  /** `builtin:<key>` or a workspace template UUID. */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  builtIn: z.boolean(),
  environments: z.array(environmentTemplateEntrySchema),
});
export type EnvironmentTemplate = z.infer<typeof environmentTemplateSchema>;

export const createEnvironmentTemplateInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  description: descriptionSchema.optional(),
  environments: z.array(environmentTemplateEntrySchema).min(1).max(50),
});
export type CreateEnvironmentTemplateInput = z.input<typeof createEnvironmentTemplateInputSchema>;

/* -------------------------------------------------- Project membership */

const userRefSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
});

export const projectMemberSchema = z.object({
  /** Project membership id. */
  id: z.uuid(),
  workspaceMembershipId: z.uuid(),
  user: userRefSchema,
  role: roleRefSchema,
  createdAt: z.iso.datetime(),
  isCurrentUser: z.boolean(),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

/** Workspace owners/admins administer every project through their workspace role. */
export const inheritedProjectAccessSchema = z.object({
  workspaceMembershipId: z.uuid(),
  user: userRefSchema,
  workspaceRole: roleRefSchema,
  isCurrentUser: z.boolean(),
});
export type InheritedProjectAccess = z.infer<typeof inheritedProjectAccessSchema>;

export const projectAccessListSchema = z.object({
  members: z.array(projectMemberSchema),
  inherited: z.array(inheritedProjectAccessSchema),
});
export type ProjectAccessList = z.infer<typeof projectAccessListSchema>;

export const addProjectMemberInputSchema = z.object({
  workspaceMembershipId: z.uuid(),
  roleKey: projectRoleKeySchema,
});
export type AddProjectMemberInput = z.infer<typeof addProjectMemberInputSchema>;

export const updateProjectMemberInputSchema = z.object({ roleKey: projectRoleKeySchema });
export type UpdateProjectMemberInput = z.infer<typeof updateProjectMemberInputSchema>;

/* ---------------------------------------------- Environment access grants */

export const environmentGrantSchema = z.object({
  id: z.uuid(),
  workspaceMembershipId: z.uuid(),
  user: userRefSchema,
  role: scopedRoleSchema,
  effect: z.enum(['ALLOW', 'DENY']),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  isCurrentUser: z.boolean(),
});
export type EnvironmentGrant = z.infer<typeof environmentGrantSchema>;

export const environmentAccessSchema = z.object({
  grants: z.array(environmentGrantSchema),
  /** Roles that can be granted on this environment. */
  roles: z.array(scopedRoleSchema),
});
export type EnvironmentAccess = z.infer<typeof environmentAccessSchema>;

export const createEnvironmentGrantInputSchema = z.object({
  workspaceMembershipId: z.uuid(),
  roleKey: environmentRoleKeySchema,
  effect: z.enum(['ALLOW', 'DENY']).default('ALLOW'),
  expiresAt: z.iso.datetime().optional(),
});
export type CreateEnvironmentGrantInput = z.input<typeof createEnvironmentGrantInputSchema>;

/* ------------------------------------------------------------ Activity */

export const activityEventSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']),
  occurredAt: z.iso.datetime(),
  actor: z.object({ displayName: z.string().nullable(), email: z.string() }).nullable(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  environmentId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  environmentId: z.uuid().optional(),
});
export type ActivityQuery = z.input<typeof activityQuerySchema>;

export const activityPageSchema = z.object({
  items: z.array(activityEventSchema),
  nextCursor: z.string().nullable(),
});
export type ActivityPage = z.infer<typeof activityPageSchema>;
