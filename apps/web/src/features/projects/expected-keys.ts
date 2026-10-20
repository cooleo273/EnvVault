/** Expected key names, one per line: `KEY` or `KEY - description`. Names only, never values. */
export function parseExpectedKeys(text: string): { key: string; description?: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key = '', ...rest] = line.split(/\s+-\s+/);
      const description = rest.join(' - ').trim();
      return description ? { key: key.trim(), description } : { key: key.trim() };
    });
}

export function formatExpectedKeys(
  keys: readonly { key: string; description?: string | undefined }[],
): string {
  return keys.map((k) => (k.description ? `${k.key} - ${k.description}` : k.key)).join('\n');
}
