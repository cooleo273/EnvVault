/** Date formatting shared by server pages and client components. */
export const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

export function when(value: string | null, never = 'Never'): string {
  return value ? dateTime.format(new Date(value)) : never;
}
