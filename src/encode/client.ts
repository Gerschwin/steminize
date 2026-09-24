import type { EncodeReq, EncodeRes } from './worker.ts';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type Req = DistributiveOmit<EncodeReq, 'id'>;

export class Encoder {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private id = 0;
  private handlers = new Map<number, (m: EncodeRes) => void>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<EncodeRes>) => this.handlers.get(e.data.id)?.(e.data);
  }

  /**
   * Runs a request. `onFile` is called for each encoded file as it is ready;
   * resolves with the request's result value (if it has one).
   */
  run<T = unknown>(
    req: Req,
    onFile: (name: string, bytes: Uint8Array) => Promise<void> | void = () => {},
    onProgress: (done: number, total: number) => void = () => {},
  ) {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      let chain = Promise.resolve();
      let value: unknown;
      this.handlers.set(id, (m) => {
        if (m.type === 'file') chain = chain.then(() => onFile(m.name, m.bytes));
        else if (m.type === 'progress') onProgress(m.done, m.total);
        else if (m.type === 'result') value = m.value;
        else {
          this.handlers.delete(id);
          if (m.type === 'done') chain.then(() => resolve(value as T), reject);
          else reject(new Error(m.message));
        }
      });
      this.worker.postMessage({ ...req, id });
    });
  }
}

/** Worker for things you wait for (exports). */
export const encoder = new Encoder();
/** Separate worker for background jobs (library saves, tempo analysis), so they never hold up an export. */
export const background = new Encoder();
