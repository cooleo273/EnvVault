import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EXAMPLES = join(HERE, '../../../examples/github-actions');
const ACTION_YML = readFileSync(join(HERE, '../action.yml'), 'utf8');

/** Input names declared in action.yml (two space indented keys under `inputs:`). */
const declared = new Set(
  [
    ...(/^inputs:\n([\s\S]*?)^outputs:/m.exec(ACTION_YML)?.[1] ?? '').matchAll(
      /^ {2}([a-z-]+):$/gm,
    ),
  ].map((m) => m[1] ?? ''),
);

const examples = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => ({ file, text: readFileSync(join(EXAMPLES, file), 'utf8') }));

/** `with:` keys of the EnvVault action step. */
function actionInputs(text: string): string[] {
  const step =
    /uses: <owner>\/<repo>\/packages\/github-action@<full-commit-sha>\n\s+with:\n((?:\s{10}[a-z-]+:.*\n?)+)/.exec(
      text,
    );
  return [...(step?.[1] ?? '').matchAll(/^\s{10}([a-z-]+):/gm)].map((m) => m[1] ?? '');
}

describe('workflow examples', () => {
  it('covers the documented scenarios', () => {
    expect(examples.map((e) => e.file).sort()).toEqual([
      'docker-build.yml',
      'nextjs-build.yml',
      'node-tests.yml',
      'production-deploy.yml',
      'service-credential-fallback.yml',
      'staging-deploy.yml',
    ]);
    expect(declared.size).toBeGreaterThan(10);
  });

  for (const { file, text } of examples) {
    it(`${file} uses real inputs, pinned actions and the right permissions`, () => {
      const inputs = actionInputs(text);
      expect(inputs.length, file).toBeGreaterThan(2);
      for (const name of inputs) expect(declared.has(name), `${file}: ${name}`).toBe(true);
      for (const [, ref] of text.matchAll(/uses: (\S+)/g)) {
        expect(ref, file).toMatch(/@<full-commit-sha>$/);
      }
      const code = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(code).not.toMatch(/pull_request_target/);
      const fallback = inputs.includes('auth-mode');
      if (fallback) {
        expect(text).toContain('service-credential: ${{ secrets.ENVVAULT_SERVICE_CREDENTIAL }}');
        expect(text).not.toContain('id-token: write');
      } else {
        expect(text).toContain('  id-token: write');
        expect(text).not.toContain('secrets.');
      }
      expect(text).not.toMatch(/evv_(sk|mt)_[A-Za-z0-9]/);
    });
  }

  it('keeps pull requests away from the production deployment', () => {
    const production = examples.find((e) => e.file === 'production-deploy.yml')?.text ?? '';
    const triggers = /^on:\n([\s\S]*?)^\S/m.exec(production)?.[1] ?? '';
    expect(triggers).not.toMatch(/pull_request/);
    expect(production).toContain('    environment: production');
  });
});
