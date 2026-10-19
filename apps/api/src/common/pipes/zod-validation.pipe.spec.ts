import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.object({
  name: z.string().min(1),
  port: z.coerce.number().int(),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns parsed data and strips unknown keys', () => {
    expect(pipe.transform({ name: 'api', port: '4000', extra: true })).toEqual({
      name: 'api',
      port: 4000,
    });
  });

  it('throws a BadRequestException with field-level issues', () => {
    try {
      pipe.transform({ name: '', port: 'abc', password: 'hunter2' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as {
        message: string;
        issues: { path: string; message: string }[];
      };
      expect(body.message).toBe('Validation failed');
      expect(body.issues.map((issue) => issue.path)).toEqual(['name', 'port']);
      expect(JSON.stringify(body)).not.toContain('hunter2');
    }
  });
});
