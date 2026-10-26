/**
 * Iterators over the API's three pagination styles. Each stops at the end of
 * the data, on an empty page, or after `maxPages`, so a misbehaving server
 * cannot make a loop run forever.
 */

export interface PageOf<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CursorPageOf<T> {
  items: T[];
  nextCursor: string | null;
}

export interface BeforePageOf<T> {
  items: T[];
  nextBefore: number | null;
}

export interface PaginateOptions {
  /** Upper bound on requests (default 1000). */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 1000;

/** `?page=&pageSize=` lists (projects, environments, variables, snapshots). */
export async function* paginate<T>(
  fetchPage: (page: number) => Promise<PageOf<T>>,
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(page);
    yield* result.items;
    if (result.items.length === 0 || result.page * result.pageSize >= result.total) return;
  }
}

/** `?cursor=` lists (activity); `nextCursor` is null on the last page. */
export async function* paginateCursor<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPageOf<T>>,
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let cursor: string | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(cursor);
    yield* result.items;
    if (result.items.length === 0 || result.nextCursor === null) return;
    cursor = result.nextCursor;
  }
}

/** `?before=` lists (version history); `nextBefore` is null on the last page. */
export async function* paginateBefore<T>(
  fetchPage: (before: number | undefined) => Promise<BeforePageOf<T>>,
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let before: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(before);
    yield* result.items;
    if (result.items.length === 0 || result.nextBefore === null) return;
    before = result.nextBefore;
  }
}

/** Collects an iterator into an array, stopping after `limit` items. */
export async function collect<T>(items: AsyncIterable<T>, limit = Infinity): Promise<T[]> {
  const out: T[] = [];
  if (limit <= 0) return out;
  for await (const item of items) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
