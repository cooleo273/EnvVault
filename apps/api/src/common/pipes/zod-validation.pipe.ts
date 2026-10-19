import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import type { ValidationExceptionBody } from '../filters/all-exceptions.filter.js';

/**
 * Validates and parses input (body, query, params) against a Zod schema.
 * Unknown keys are stripped by Zod's default object behaviour. Validation
 * errors expose field paths and messages only, never the submitted values.
 *
 * Usage: `@Body(new ZodValidationPipe(createProjectSchema)) body: CreateProject`
 */
@Injectable()
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const body: ValidationExceptionBody = {
        message: 'Validation failed',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      };
      throw new BadRequestException(body);
    }
    return result.data;
  }
}
