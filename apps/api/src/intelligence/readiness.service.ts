import { Injectable } from '@nestjs/common';
import type { StoredSecretVersion, ValidationRuleRecord, VariableRow } from '@envvault/database';
import {
  NAMING_RULE_KEY,
  type ReadinessIssue,
  type ReadinessReport,
  type readinessInputSchema,
} from '@envvault/shared';
import type { z } from 'zod';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { SecretAuthorizationService } from '../secrets/secret-authorization.service.js';
import { SecretRateLimiter } from '../secrets/secret-rate-limiter.js';
import { SecretVault } from '../secrets/secret-vault.service.js';
import { ConfigurationService } from './configuration.service.js';
import type { ProjectCaller } from './environment-access.service.js';
import { safeMatch } from './safe-match.js';
import { checkValue, needsValue } from './validation.service.js';

type ReadinessInput = z.output<typeof readinessInputSchema>;
type Check = ReadinessReport['checks'][number];

const BASE_MESSAGES = {
  deleted: 'The base environment was deleted, so nothing is inherited.',
  archived: 'The base environment is archived, so nothing is inherited.',
  protected:
    'The base environment became protected; protected environments are never inherited from.',
} as const;

/**
 * Configuration readiness of one environment. This checks EnvVault's own
 * records only: it never contacts external services, so READY does not mean
 * a database or API behind a variable works.
 *
 * Status rules, in order:
 * - BLOCKED: at least one blocking issue (missing required variable or value,
 *   broken inheritance, disallowed name, a value that fails its type or rule).
 * - UNKNOWN: no blocking issue, but something could not be checked (values
 *   not inspected while rules need them, values that could not be decrypted,
 *   a base the caller cannot read, a pattern that could not run).
 * - WARNING: only warnings (template keys missing, names differing only by
 *   case, overrides that change a type, protected environment inheriting).
 * - READY: every check ran and passed.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly vault: SecretVault,
    private readonly configuration: ConfigurationService,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
  ) {}

  async evaluate(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    input: ReadinessInput,
  ): Promise<ReadinessReport> {
    const ctx = { principal: caller.principal, environment, requestId: caller.requestId };
    if (input.inspectValues) {
      await this.authorization.require(
        ctx,
        'secret:read',
        'environment.readiness_values_inspected',
      );
      await this.authorization.requireStepUpIfProtected(
        ctx,
        null,
        'environment.readiness_values_inspected',
      );
      await this.limiter.consume(ctx, 'bulk-read');
    }
    const repos = this.vault.repos;
    const [rows, rules, detail] = await Promise.all([
      this.configuration.rows(caller, environment),
      repos.validationRules.list(environment.scope),
      repos.environments.getDetail(environment.scope),
    ]);
    const issues: ReadinessIssue[] = [];
    const checks: Check[] = [];
    const issue = (
      severity: ReadinessIssue['severity'],
      code: string,
      key: string | null,
      message: string,
      remediation: string,
    ) => issues.push({ severity, code, key, message, remediation });

    // Inheritance.
    const base = rows.base;
    if (!base) {
      checks.push({ name: 'Inheritance', outcome: 'skipped', detail: 'No base environment' });
    } else if (base.ref.state === 'ok') {
      checks.push({
        name: 'Inheritance',
        outcome: 'passed',
        detail: `Inherits ${String(rows.inherited.length)} variables from ${base.ref.name}`,
      });
    } else if (base.ref.state === 'no_access') {
      issue(
        'unknown',
        'INHERITANCE_NOT_VISIBLE',
        null,
        'You cannot read the base environment, so inherited variables were not checked.',
        'Ask for secret:list on the base environment, or check as someone who has it.',
      );
      checks.push({ name: 'Inheritance', outcome: 'skipped', detail: 'Base not visible to you' });
    } else {
      issue(
        'blocking',
        'INHERITANCE_BROKEN',
        null,
        BASE_MESSAGES[base.ref.state],
        'Choose another base or remove it in the environment settings.',
      );
      checks.push({
        name: 'Inheritance',
        outcome: 'failed',
        detail: BASE_MESSAGES[base.ref.state],
      });
    }

    const effective = new Map<string, { row: VariableRow; inherited: boolean }>();
    for (const row of rows.local) effective.set(row.key, { row, inherited: false });
    for (const row of rows.inherited) effective.set(row.key, { row, inherited: true });

    // Required variables (rules and flags).
    const required = new Set<string>();
    for (const rule of rules) if (rule.required) required.add(rule.key);
    for (const { row } of effective.values()) if (row.isRequired) required.add(row.key);
    let present = 0;
    for (const key of [...required].sort()) {
      const found = effective.get(key);
      if (!found) {
        issue(
          'blocking',
          'REQUIRED_MISSING',
          key,
          'A required variable is missing.',
          'Add the variable, or inherit it from a base environment.',
        );
      } else if (found.row.currentVersionId === null) {
        issue(
          'blocking',
          'REQUIRED_NO_VALUE',
          key,
          'A required variable has no value.',
          'Set a value for it.',
        );
      } else {
        present++;
      }
    }
    checks.push({
      name: 'Required variables',
      outcome: present === required.size ? 'passed' : 'failed',
      detail: `${String(present)} of ${String(required.size)} have a value`,
    });

    // Template keys.
    const missingTemplate = (detail?.expectedKeys ?? []).filter((k) => !effective.has(k.key));
    for (const k of missingTemplate) {
      issue(
        'warning',
        'TEMPLATE_KEY_MISSING',
        k.key,
        'A variable expected by the environment template is missing.',
        'Add it, or remove it from the expected keys.',
      );
    }
    checks.push({
      name: 'Template keys',
      outcome: missingTemplate.length === 0 ? 'passed' : 'warning',
      detail: `${String((detail?.expectedKeys.length ?? 0) - missingTemplate.length)} of ${String(detail?.expectedKeys.length ?? 0)} present`,
    });

    // Naming rule.
    const naming = rules.find((r) => r.key === NAMING_RULE_KEY);
    if (naming?.pattern) {
      let failed = 0;
      for (const row of rows.local) {
        const match = safeMatch(naming.pattern, row.key);
        if (match === 'no_match') {
          failed++;
          issue(
            'blocking',
            'NAME_NOT_ALLOWED',
            row.key,
            'The name does not follow the naming rule.',
            'Rename the variable or change the naming rule.',
          );
        } else if (match === 'not_checked') {
          issue(
            'unknown',
            'NAME_NOT_CHECKED',
            row.key,
            'The naming rule could not be checked for this name.',
            'Simplify the naming rule pattern.',
          );
        }
      }
      checks.push({
        name: 'Naming rule',
        outcome: failed === 0 ? 'passed' : 'failed',
        detail: `${String(failed)} names do not match`,
      });
    } else {
      checks.push({ name: 'Naming rule', outcome: 'skipped', detail: 'No naming rule' });
    }

    // Names that differ only by case are easy to confuse.
    const byLower = new Map<string, string[]>();
    for (const key of effective.keys())
      byLower.set(key.toLowerCase(), [...(byLower.get(key.toLowerCase()) ?? []), key]);
    for (const keys of byLower.values()) {
      if (keys.length > 1) {
        issue(
          'warning',
          'CASE_DUPLICATE',
          keys.join(', '),
          'These names differ only by case.',
          'Keep one of them, unless both are intended.',
        );
      }
    }

    // Overrides that change the type of the inherited variable.
    for (const baseRow of rows.overridden) {
      const local = rows.local.find((r) => r.key === baseRow.key);
      if (local && local.type !== baseRow.type) {
        issue(
          'warning',
          'OVERRIDE_TYPE_CHANGE',
          local.key,
          `The local override is ${local.type}, the base variable is ${baseRow.type}.`,
          'Align the types, or keep the override if intended.',
        );
      }
    }

    if (environment.isProtected && base?.ref.state === 'ok') {
      issue(
        'warning',
        'PROTECTED_INHERITS',
        null,
        'This protected environment inherits configuration from an unprotected one.',
        'Make sure changes to the base are reviewed as carefully as changes here.',
      );
    }

    // Value rules and types.
    const valueRules = new Map(
      rules.filter((r) => r.key !== NAMING_RULE_KEY && needsValue(r)).map((r) => [r.key, r]),
    );
    const withValues = [...effective.values()].filter(({ row }) => row.currentVersionId !== null);
    if (!input.inspectValues) {
      for (const { row } of withValues) {
        if (valueRules.has(row.key)) {
          issue(
            'unknown',
            'VALUE_NOT_INSPECTED',
            row.key,
            'The value has rules that were not checked.',
            'Run the check with values (needs secret:read).',
          );
        }
      }
      checks.push({ name: 'Values', outcome: 'skipped', detail: 'Values were not inspected' });
    } else {
      const counts = await this.inspect(caller, environment, rows, withValues, valueRules, issue);
      checks.push({
        name: 'Values',
        outcome: counts.failed > 0 ? 'failed' : counts.unknown > 0 ? 'skipped' : 'passed',
        detail: `${String(counts.passed)} passed, ${String(counts.failed)} failed, ${String(counts.unknown)} not checked`,
      });
      await this.vault.auditRead(
        ctx,
        'environment.readiness_values_inspected',
        environment.scope.environmentId,
        {
          inspected: counts.passed + counts.failed,
          failed: counts.failed,
        },
        'environment',
      );
    }

    const counts = {
      blocking: issues.filter((i) => i.severity === 'blocking').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      unknown: issues.filter((i) => i.severity === 'unknown').length,
    };
    const status =
      counts.blocking > 0
        ? 'BLOCKED'
        : counts.unknown > 0
          ? 'UNKNOWN'
          : counts.warning > 0
            ? 'WARNING'
            : 'READY';
    return {
      environmentId: environment.scope.environmentId,
      status,
      evaluatedAt: new Date().toISOString(),
      valuesInspected: input.inspectValues,
      coverage: { required: required.size, present },
      counts,
      checks,
      issues,
    };
  }

  /** Decrypts and checks values on the server; inherited ones through the base's own access. */
  private async inspect(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    rows: Awaited<ReturnType<ConfigurationService['rows']>>,
    withValues: { row: VariableRow; inherited: boolean }[],
    valueRules: Map<string, ValidationRuleRecord>,
    issue: (
      severity: ReadinessIssue['severity'],
      code: string,
      key: string | null,
      message: string,
      remediation: string,
    ) => void,
  ): Promise<{ passed: number; failed: number; unknown: number }> {
    const counts = { passed: 0, failed: 0, unknown: 0 };
    const baseEnv = rows.base?.environment ?? null;
    const canReadBase = baseEnv?.permissions.has('secret:read') === true && !baseEnv.isProtected;
    const repos = this.vault.repos;
    const [localStored, baseStored] = await Promise.all([
      repos.secretBulk.currentVersions(
        environment.scope,
        withValues.filter((v) => !v.inherited).map((v) => v.row.id),
      ),
      baseEnv && canReadBase
        ? repos.secretBulk.currentVersions(
            baseEnv.scope,
            withValues.filter((v) => v.inherited).map((v) => v.row.id),
          )
        : Promise.resolve(new Map<string, StoredSecretVersion>()),
    ]);
    for (const { row, inherited } of withValues) {
      const target = inherited ? baseEnv : environment;
      const stored = (inherited ? baseStored : localStored).get(row.id);
      if (!target || !stored) {
        counts.unknown++;
        issue(
          'unknown',
          'VALUE_NOT_READABLE',
          row.key,
          'You cannot read this inherited value, so it was not checked.',
          'Ask for secret:read on the base environment.',
        );
        continue;
      }
      let value: string;
      try {
        value = await this.vault.open(
          { principal: caller.principal, environment: target, requestId: caller.requestId },
          row.id,
          stored,
          { key: row.key, attempted: 'environment.readiness_values_inspected' },
        );
      } catch {
        counts.unknown++;
        issue(
          'unknown',
          'VALUE_UNAVAILABLE',
          row.key,
          'The value could not be decrypted, so it was not checked.',
          'Check that the encryption keys are available.',
        );
        continue;
      }
      const result = checkValue(row.type, value, valueRules.get(row.key));
      if (result.outcome === 'passed') counts.passed++;
      else if (result.outcome === 'failed') {
        counts.failed++;
        issue(
          'blocking',
          'VALUE_INVALID',
          row.key,
          result.message,
          'Set a value that satisfies the rule.',
        );
      } else {
        counts.unknown++;
        issue(
          'unknown',
          'VALUE_NOT_CHECKED',
          row.key,
          result.message,
          'Simplify the rule or shorten the value.',
        );
      }
    }
    return counts;
  }
}
