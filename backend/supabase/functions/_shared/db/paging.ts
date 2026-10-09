// Reads every row of a query, a page at a time. PostgREST returns at most
// `max-rows` (1,000 on Supabase) per request and silently drops the rest, so
// any read that can exceed that must page with .range() on a stable order.
// deno-lint-ignore-file no-explicit-any

/** Must not exceed the project's PostgREST max-rows, or a short page ends the read early. */
export const PAGE_SIZE = 1000;
export const ID_CHUNK = 200;

type Result = { data: any[] | null; error: { message: string } | null };

/** `build` must return a fresh, fully filtered and uniquely ordered query each call. */
export async function readAll<T = any>(build: () => any, pageSize = PAGE_SIZE): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = (await build().range(from, from + pageSize - 1)) as Result;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...(rows as T[]));
    if (rows.length === 0) break;
    from += rows.length;
    if (rows.length < pageSize) break;
  }
  return out;
}

/** Splits a long id list into URL-safe chunks and reads each chunk completely. */
export async function readAllIn<T = any>(ids: string[], build: (chunk: string[]) => any, chunkSize = ID_CHUNK): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    out.push(...(await readAll<T>(() => build(chunk))));
  }
  return out;
}
