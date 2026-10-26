/**
 * What to register as GitHub log masks for each value. Masking is defence in
 * depth only: GitHub replaces exact matches in the log, so a transformed
 * value (encoded, split, reversed) still leaks. Never print values at all.
 */

/** Shorter values would hide ordinary log text (`1`, `on`); they are not masked. */
export const MIN_MASK_LENGTH = 4;

export function masksFor(value: string): string[] {
  const masks = new Set<string>();
  const add = (candidate: string) => {
    if (candidate.length >= MIN_MASK_LENGTH) masks.add(candidate);
  };
  add(value);
  // GitHub matches masks line by line, so a multiline value is masked per line too.
  for (const line of value.split(/\r?\n|\r/)) add(line.trim());
  // How the value appears when a program prints it inside JSON.
  add(JSON.stringify(value).slice(1, -1));
  return [...masks];
}

/** Replaces every known value in text (used for messages the action itself prints). */
export function redact(text: string, values: Iterable<string>): string {
  let out = text;
  const sorted = [...values]
    .filter((v) => v.length >= MIN_MASK_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of sorted) out = out.split(value).join('***');
  return out;
}
