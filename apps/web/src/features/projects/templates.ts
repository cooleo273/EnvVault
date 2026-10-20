import type { EnvironmentTemplate } from '@envvault/shared';

/** Flat list of environment definitions offered by the available templates. */
export function templateChoices(templates: EnvironmentTemplate[]) {
  return templates.flatMap((t) =>
    t.environments.map((entry, index) => ({
      id: t.environments.length === 1 ? t.id : `${t.id}#${String(index)}`,
      template: t,
      entry,
    })),
  );
}
