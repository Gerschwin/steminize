// A download that can be stopped and carried on later. The bytes arrive in parts that are kept as they come (in a PartStore, which the
// app backs with Cache Storage); a later attempt asks the server for only the rest (an HTTP Range request) and joins the parts. If the
// server doesn't honour the request, or the answer doesn't line up, it starts again from the beginning rather than join wrong bytes.
// No browser-only code here, so it can be tested with a fake server.

/** Where the parts of an unfinished download are kept, in order (part 0, part 1, ...). */
export interface PartStore {
  sizes(): Promise<number[]>;
  put(index: number, data: Blob): Promise<void>;
  blobs(): Promise<Blob[]>;
  clear(): Promise<void>;
}

export interface ResumableOptions {
  url: string;
  parts: PartStore;
  /** The size to expect if the server doesn't say. */
  expected: number;
  onProgress: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** About how much to hold in memory before writing a part. */
  partBytes?: number;
}

/** "bytes 100-199/1000" as numbers, or null if it isn't that. */
export function parseContentRange(header: string | null): { start: number; end: number; total: number } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((header ?? '').trim());
  return m ? { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) } : null;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** How many bytes of an unfinished download are kept. */
export async function keptBytes(parts: PartStore): Promise<number> {
  return sum(await parts.sizes());
}

/** Downloads `url`, carrying on from whatever parts are already kept, and returns the whole file. A stop or a failure keeps what arrived. */
export async function downloadResumable(o: ResumableOptions): Promise<Blob> {
  const doFetch = o.fetchFn ?? fetch;
  const partBytes = o.partBytes ?? 16 * 1024 * 1024;
  const sizes = await o.parts.sizes();
  let have = sum(sizes);
  const get = (from: number) => doFetch(o.url, { signal: o.signal, mode: 'cors', headers: from > 0 ? { Range: `bytes=${from}-` } : undefined });
  const restart = async () => {
    await o.parts.clear();
    sizes.length = 0;
    have = 0;
  };

  let res = await get(have);
  let total = 0;
  if (have > 0) {
    const cr = res.status === 206 ? parseContentRange(res.headers.get('content-range')) : null;
    if (cr && cr.start === have && cr.end + 1 === cr.total) total = cr.total;
    else {
      // Not the rest of the file as asked (the whole file, a refusal, or something else): throw the parts away and start again.
      await res.body?.cancel().catch(() => {});
      await restart();
      res = await get(0);
    }
  }
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  if (!total) total = Number(res.headers.get('content-length')) || o.expected;

  let buf: Uint8Array[] = [];
  let bufBytes = 0;
  const flush = async () => {
    if (!bufBytes) return;
    const blob = new Blob(buf as BlobPart[]);
    await o.parts.put(sizes.length, blob);
    sizes.push(blob.size);
    buf = [];
    bufBytes = 0;
  };
  let loaded = have;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.push(value);
      bufBytes += value.byteLength;
      loaded += value.byteLength;
      o.onProgress(loaded, total);
      if (bufBytes >= partBytes) await flush();
    }
  } catch (e) {
    await flush().catch(() => {}); // keep what arrived so the next try can carry on from here
    throw e;
  }
  await flush();
  if (loaded < 1024 * 1024 || (total !== o.expected && loaded !== total && Number(res.headers.get('content-length')))) {
    await restart();
    throw new Error('The download looks incomplete');
  }
  return new Blob(await o.parts.blobs());
}
