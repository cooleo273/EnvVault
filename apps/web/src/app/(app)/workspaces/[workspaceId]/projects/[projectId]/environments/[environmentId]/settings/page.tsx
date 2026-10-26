import {
  canModifyEnvironment,
  type EffectiveConfiguration,
  type EnvironmentAccess,
  type EnvironmentSummary,
  type ProjectAccessList,
  type VisualColor,
  type ValidationRule,
  type VisualIcon,
} from '@envvault/shared';
import type { Metadata } from 'next';
import { SettingsSection } from '@/components/layout/settings-section';
import { EnvironmentForm } from '@/features/projects/environment-form';
import {
  EnvironmentLifecycle,
  EnvironmentPermissions,
  EnvironmentProtectionSettings,
} from '@/features/projects/environment-settings';
import { InheritanceSettings } from '@/features/intelligence/inheritance-settings';
import { ValidationRulesEditor } from '@/features/intelligence/validation-rules-editor';
import { formatExpectedKeys } from '@/features/projects/expected-keys';
import { withApi } from '@/lib/api/server-api';
import { getEnvironment, getProject } from '@/lib/projects/server';
import { getWorkspace } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Environment settings' };

/** EnvironmentSettings: metadata, protection, access and lifecycle. */
export default async function EnvironmentSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; environmentId: string }>;
}) {
  const ids = await params;
  const { workspaceId, projectId, environmentId } = ids;
  const [workspace, project, environment] = await Promise.all([
    getWorkspace(workspaceId),
    getProject(workspaceId, projectId),
    getEnvironment(workspaceId, projectId, environmentId),
  ]);
  const permissions = new Set(environment.permissions);
  const canManageAccess = permissions.has('access_policy:manage');
  let access: EnvironmentAccess | null = null;
  let members: ProjectAccessList | null = null;
  if (canManageAccess) {
    [access, members] = await withApi((api) =>
      Promise.all([
        api.environmentAccess(workspaceId, projectId, environmentId),
        api.projectMembers(workspaceId, projectId),
      ]),
    ).catch(() => [null, null] as const);
  }
  const candidates = members
    ? [
        ...members.members.filter((m) => !m.isCurrentUser),
        ...members.inherited.filter(
          (i) =>
            !i.isCurrentUser &&
            !members.members.some((m) => m.workspaceMembershipId === i.workspaceMembershipId),
        ),
      ]
    : [];
  const canEdit = canModifyEnvironment(permissions, 'environment:update', environment.isProtected);
  const archived = environment.status === 'ARCHIVED';
  const canList = permissions.has('secret:list');
  const [effective, siblings, rules] = canList
    ? await Promise.all([
        withApi((api) => api.effectiveConfiguration(workspaceId, projectId, environmentId)).catch(
          () => null as EffectiveConfiguration | null,
        ),
        withApi((api) => api.listEnvironments(workspaceId, projectId, { pageSize: 200 }))
          .then((r) => r.items)
          .catch(() => [] as EnvironmentSummary[]),
        withApi((api) => api.validationRules(workspaceId, projectId, environmentId)).catch(
          () => null as ValidationRule[] | null,
        ),
      ])
    : [null, [] as EnvironmentSummary[], null];
  const canConfigure = canEdit && !archived && project.status === 'ACTIVE';

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        id="general"
        title="General"
        description={
          canEdit
            ? 'Name, type, appearance and expected variable names.'
            : environment.isProtected && permissions.has('environment:update')
              ? 'This environment is protected: editing requires environment:protect.'
              : 'You can view these settings but not change them.'
        }
      >
        <EnvironmentForm
          mode="edit"
          workspaceId={workspaceId}
          projectId={projectId}
          environmentId={environmentId}
          slug={environment.slug}
          disabled={!canEdit || archived || project.status !== 'ACTIVE'}
          initial={{
            name: environment.name,
            kind: environment.kind,
            description: environment.description ?? '',
            color: environment.color as VisualColor,
            icon: environment.icon as VisualIcon | null,
            isProtected: environment.isProtected,
            expectedKeys: formatExpectedKeys(environment.expectedKeys),
          }}
        />
      </SettingsSection>

      {canList ? (
        <InheritanceSettings
          ids={ids}
          environmentName={environment.name}
          current={effective}
          candidates={siblings}
          canEdit={canConfigure}
        />
      ) : null}

      {canList && rules ? (
        <ValidationRulesEditor ids={ids} initial={rules} canEdit={canConfigure} />
      ) : null}

      <EnvironmentProtectionSettings
        ids={ids}
        environment={environment}
        canProtect={permissions.has('environment:protect') && project.status === 'ACTIVE'}
      />

      {canManageAccess && access ? (
        <EnvironmentPermissions
          ids={ids}
          environment={environment}
          grants={access.grants}
          roles={access.roles}
          candidates={candidates}
        />
      ) : null}

      <EnvironmentLifecycle
        ids={ids}
        environment={environment}
        canUpdate={canEdit && project.status === 'ACTIVE'}
        canDelete={
          canModifyEnvironment(permissions, 'environment:delete', environment.isProtected) &&
          project.status === 'ACTIVE'
        }
        canDuplicate={
          project.permissions.includes('environment:create') &&
          (!environment.isProtected || project.permissions.includes('environment:protect')) &&
          project.status === 'ACTIVE'
        }
        canSaveTemplate={workspace.permissions.includes('workspace:update')}
      />
    </div>
  );
}
