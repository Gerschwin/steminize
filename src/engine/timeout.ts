// Bounds how long to wait for something that might never finish.

/** Settles like `p`, unless that takes longer than `ms`, in which case it rejects (`p` is left running; the caller decides what to do with it). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} didn't finish within ${ms / 1000} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
