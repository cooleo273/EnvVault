import { z } from 'zod';

/** Environment classification. Mirrors the `EnvironmentKind` database enum. */
export const ENVIRONMENT_KINDS = [
  'DEVELOPMENT',
  'TESTING',
  'STAGING',
  'PRODUCTION',
  'OTHER',
] as const;

export const environmentKindSchema = z.enum(ENVIRONMENT_KINDS);
export type EnvironmentKind = z.infer<typeof environmentKindSchema>;

export const ENVIRONMENT_KIND_LABELS: Record<EnvironmentKind, string> = {
  DEVELOPMENT: 'Development',
  TESTING: 'Testing',
  STAGING: 'Staging',
  PRODUCTION: 'Production',
  OTHER: 'Other',
};

/* ------------------------------------------------------- Visual identifiers */

/** Named colors for projects and environments (mapped to design tokens in the UI). */
export const VISUAL_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'pink',
] as const;
export const visualColorSchema = z.enum(VISUAL_COLORS);
export type VisualColor = z.infer<typeof visualColorSchema>;

/** Named icons for projects and environments (mapped to icon components in the UI). */
export const VISUAL_ICONS = [
  'folder',
  'box',
  'globe',
  'server',
  'database',
  'smartphone',
  'cloud',
  'code',
  'terminal',
  'cpu',
  'rocket',
  'layers',
  'shield',
  'lock',
  'flask-conical',
  'eye',
  'presentation',
  'git-branch',
  'package',
  'wrench',
] as const;
export const visualIconSchema = z.enum(VISUAL_ICONS);
export type VisualIcon = z.infer<typeof visualIconSchema>;

/* ------------------------------------------------------ Environment templates */

export const expectedKeySchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/, 'Use letters, digits, _ . - (no spaces)'),
  description: z.string().trim().max(200).optional(),
});
export type ExpectedKey = z.infer<typeof expectedKeySchema>;

/** One environment definition inside a template. Never contains values. */
export const environmentTemplateEntrySchema = z.object({
  name: z.string().trim().min(1).max(64),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
    .optional(),
  kind: environmentKindSchema,
  description: z.string().trim().max(1000).optional(),
  isProtected: z.boolean().default(false),
  color: visualColorSchema.optional(),
  icon: visualIconSchema.optional(),
  expectedKeys: z.array(expectedKeySchema).max(200).default([]),
});
export type EnvironmentTemplateEntry = z.output<typeof environmentTemplateEntrySchema>;

export interface BuiltInEnvironmentTemplate {
  /** Stable reference, e.g. `builtin:production`. */
  id: `builtin:${string}`;
  name: string;
  description: string;
  environments: EnvironmentTemplateEntry[];
}

function single(
  id: string,
  entry: Omit<EnvironmentTemplateEntry, 'expectedKeys'> & { expectedKeys?: ExpectedKey[] },
): BuiltInEnvironmentTemplate {
  return {
    id: `builtin:${id}`,
    name: entry.name,
    description: entry.description ?? '',
    environments: [{ ...entry, expectedKeys: entry.expectedKeys ?? [] }],
  };
}

/**
 * Built-in templates available in every workspace. Each defines one
 * environment; workspaces can also save their own (multi-environment) ones.
 */
export const BUILT_IN_ENVIRONMENT_TEMPLATES: readonly BuiltInEnvironmentTemplate[] = [
  single('development', {
    name: 'Development',
    slug: 'development',
    kind: 'DEVELOPMENT',
    description: 'Day-to-day development and local work.',
    isProtected: false,
    color: 'green',
    icon: 'code',
  }),
  single('qa', {
    name: 'QA',
    slug: 'qa',
    kind: 'TESTING',
    description: 'Quality assurance and manual testing.',
    isProtected: false,
    color: 'cyan',
    icon: 'flask-conical',
  }),
  single('testing', {
    name: 'Testing',
    slug: 'testing',
    kind: 'TESTING',
    description: 'Automated test runs and CI.',
    isProtected: false,
    color: 'teal',
    icon: 'terminal',
  }),
  single('staging', {
    name: 'Staging',
    slug: 'staging',
    kind: 'STAGING',
    description: 'Production-like environment for final checks.',
    isProtected: false,
    color: 'amber',
    icon: 'layers',
  }),
  single('uat', {
    name: 'UAT',
    slug: 'uat',
    kind: 'STAGING',
    description: 'User acceptance testing with stakeholders.',
    isProtected: false,
    color: 'orange',
    icon: 'presentation',
  }),
  single('production', {
    name: 'Production',
    slug: 'production',
    kind: 'PRODUCTION',
    description: 'Live customer-facing environment.',
    isProtected: true,
    color: 'red',
    icon: 'shield',
  }),
  single('demo', {
    name: 'Demo',
    slug: 'demo',
    kind: 'OTHER',
    description: 'Sales and product demonstrations.',
    isProtected: false,
    color: 'violet',
    icon: 'rocket',
  }),
  single('preview', {
    name: 'Preview',
    slug: 'preview',
    kind: 'OTHER',
    description: 'Short-lived preview deployments.',
    isProtected: false,
    color: 'sky',
    icon: 'eye',
  }),
];

/** Default color per kind when none is chosen. */
export const DEFAULT_ENVIRONMENT_COLORS: Record<EnvironmentKind, VisualColor> = {
  DEVELOPMENT: 'green',
  TESTING: 'cyan',
  STAGING: 'amber',
  PRODUCTION: 'red',
  OTHER: 'slate',
};
