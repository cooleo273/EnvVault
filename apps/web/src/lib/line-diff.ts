export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Above this many cells the table would be too large; callers show a summary instead. */
const MAX_CELLS = 4_000_000;

/**
 * Line diff by longest common subsequence. Returns null when the inputs are
 * too large to diff in the browser.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null;
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push({ kind: 'removed', text: a[i] ?? '' });
      i++;
    } else {
      lines.push({ kind: 'added', text: b[j] ?? '' });
      j++;
    }
  }
  for (; i < a.length; i++) lines.push({ kind: 'removed', text: a[i] ?? '' });
  for (; j < b.length; j++) lines.push({ kind: 'added', text: b[j] ?? '' });
  return lines;
}
