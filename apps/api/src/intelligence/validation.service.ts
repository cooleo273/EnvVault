import { Injectable } from '@nestjs/common';
import { createRepositories, type ValidationRuleRecord, withTransaction } from '@envvault/database';
import {
  canModifyEnvironment,
  type replaceValidationRulesInputSchema,
  type SecretType,
  secretValueProblem,
  type ValidationRule,
} from '@envvault/shared';
import type { z } from 'zod';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { protectionRequired } from '../projects/project.helpers.js';
import { SecretVault } from '../secrets/secret-vault.service.js';
import type { ProjectCaller } from './environment-access.service.js';
import { safeMatch } from './safe-match.js';

type ReplaceInput = z.output<typeof replaceValidationRulesInputSchema>;

export type ValueCheck = { outcome: 'passed' } | { outcome: 'failed' | 'unknown'; message: string };

export function toRule(record: ValidationRuleRecord): ValidationRule {
  return {
    id: record.id,
    key: record.key,
    required: record.required,
    allowEmpty: record.allowEmpty,
    format: record.format,
    minNumber: record.minNumber,
    maxNumber: record.maxNumber,
    minLength: record.minLength,
    maxLength: record.maxLength,
    pattern: record.pattern,
    allowedValues: record.allowedValues,
    description: record.description,
    updatedAt: record.updatedAt.toISOString(),
    updatedBy: record.updatedBy,
  };
}

/** Whether a rule constrains the value (and so needs decryption to check). */
export function needsValue(rule: ValidationRuleRecord): boolean {
  return (
    !rule.allowEmpty ||
    rule.format !== 'ANY' ||
    rule.minNumber !== null ||
    rule.maxNumber !== null ||
    rule.minLength !== null ||
    rule.maxLength !== null ||
    rule.pattern !== null ||
    rule.allowedValues.length > 0
  );
}

/**
 * Checks a decrypted value against its variable type and a rule. Runs on the
 * server only; messages describe the rule, never the value.
 */
export function checkValue(
  type: SecretType,
  value: string,
  rule?: ValidationRuleRecord,
): ValueCheck {
  const typeProblem = secretValueProblem(type, value);
  if (typeProblem) return { outcome: 'failed', message: `Does not match its type: ${typeProblem}` };
  if (!rule) return { outcome: 'passed' };
  if (value === '') {
    return rule.allowEmpty
      ? { outcome: 'passed' }
      : { outcome: 'failed', message: 'Must not be empty' };
  }
  if (rule.format === 'URL' && !(/^[a-z][a-z0-9+.-]*:\/\/\S/i.test(value) && URL.canParse(value))) {
    return { outcome: 'failed', message: 'Must be a URL with a scheme, such as https://' };
  }
  if (rule.format === 'JSON') {
    try {
      JSON.parse(value);
    } catch {
      return { outcome: 'failed', message: 'Must be valid JSON' };
    }
  }
  if (rule.format === 'NUMBER' || rule.minNumber !== null || rule.maxNumber !== null) {
    const number = secretValueProblem('NUMBER', value) === null ? Number(value) : Number.NaN;
    if (!Number.isFinite(number)) return { outcome: 'failed', message: 'Must be a number' };
    if (rule.minNumber !== null && number < rule.minNumber) {
      return { outcome: 'failed', message: `Must be at least ${String(rule.minNumber)}` };
    }
    if (rule.maxNumber !== null && number > rule.maxNumber) {
      return { outcome: 'failed', message: `Must be at most ${String(rule.maxNumber)}` };
    }
  }
  // Unicode code points, so an emoji counts as one character.
  let length = 0;
  for (const _char of value) length++;
  if (rule.minLength !== null && length < rule.minLength) {
    return { outcome: 'failed', message: `Must be at least ${String(rule.minLength)} characters` };
  }
  if (rule.maxLength !== null && length > rule.maxLength) {
    return { outcome: 'failed', message: `Must be at most ${String(rule.maxLength)} characters` };
  }
  if (rule.allowedValues.length > 0 && !rule.allowedValues.includes(value)) {
    return { outcome: 'failed', message: 'Is not one of the allowed values' };
  }
  if (rule.pattern !== null) {
    const match = safeMatch(rule.pattern, value);
    if (match === 'no_match')
      return { outcome: 'failed', message: 'Does not match the required pattern' };
    if (match === 'not_checked') {
      return {
        outcome: 'unknown',
        message: 'The pattern could not be checked (value too long or too slow)',
      };
    }
  }
  return { outcome: 'passed' };
}

/** Validation rules of an environment (stored per environment, one per variable name). */
@Injectable()
export class ValidationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
  ) {}

  async list(environment: AuthorizedEnvironment): Promise<ValidationRule[]> {
    return (await this.vault.repos.validationRules.list(environment.scope)).map(toRule);
  }

  /** Replaces the rule set. Needs `environment:update` (and `environment:protect` when protected). */
  async replace(
    caller: ProjectCaller,
    environment: AuthorizedEnvironment,
    input: ReplaceInput,
  ): Promise<ValidationRule[]> {
    if (
      !canModifyEnvironment(environment.permissions, 'environment:update', environment.isProtected)
    ) {
      throw protectionRequired();
    }
    await this.vault.write(null, () =>
      withTransaction(this.database.client, async (tx) => {
        const repos = createRepositories(tx);
        await repos.validationRules.replace(
          environment.scope,
          input.rules.map((rule) => ({
            ...rule,
            description: rule.description === '' ? null : rule.description,
          })),
          caller.principal.userId,
        );
        await this.vault.audit(
          repos,
          { principal: caller.principal, environment, requestId: caller.requestId },
          'environment.validation_rules_updated',
          environment.scope.environmentId,
          { count: input.rules.length, keys: input.rules.map((r) => r.key).slice(0, 200) },
          { resourceType: 'environment' },
        );
      }),
    );
    return this.list(environment);
  }
}
