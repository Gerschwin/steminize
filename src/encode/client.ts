import type { EncodeReq, EncodeRes } from './worker.ts';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

export class Encoder {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private id = 0;
  private handlers = new Map<number, (m: EncodeRes) => void>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<EncodeRes>) => this.handlers.get(e.data.id)?.(e.data);
  }

  /** Runs a request; `onFile` is called for each encoded file as it is ready. */
  run(req: DistributiveOmit<EncodeReq, 'id'>, onFile: (name: string, bytes: Uint8Array) => Promise<void> | void) {
    const id = ++this.id;
    return new Promise<void>((resolve, reject) => {
      let chain = Promise.resolve();
      this.handlers.set(id, (m) => {
        if (m.type === 'file') chain = chain.then(() => onFile(m.name, m.bytes));
        else {
          this.handlers.delete(id);
          if (m.type === 'done') chain.then(resolve, reject);
          else reject(new Error(m.message));
        }
      });
      this.worker.postMessage({ ...req, id });
    });
  }
}
