import type { Transport } from './transport.js';

const METADATA_KEYS = new Set(['ok', 'response_metadata', 'headers', 'warning']);

export async function* paginatePages(
  transport: Transport,
  method: string,
  params: Record<string, unknown>
): AsyncIterable<Record<string, any>> {
  let cursor: string | undefined;
  do {
    const page = await transport.call(method, cursor ? { ...params, cursor } : params);
    yield page;
    const next = page?.response_metadata?.next_cursor;
    cursor = typeof next === 'string' && next.length > 0 ? next : undefined;
  } while (cursor);
}

export async function mergePages(pages: AsyncIterable<Record<string, any>>): Promise<Record<string, any>> {
  const merged: Record<string, any> = {};
  const arrays: Record<string, any[]> = {};

  for await (const page of pages) {
    for (const [key, value] of Object.entries(page)) {
      if (METADATA_KEYS.has(key)) {
        merged[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        if (!arrays[key]) arrays[key] = [];
        arrays[key] = arrays[key].concat(value);
      } else {
        merged[key] = value;
      }
    }
  }

  return { ...merged, ...arrays };
}
