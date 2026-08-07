export type Settled<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown };

export interface PoolOptions {
  limit: number;
  signal?: AbortSignal | undefined;
}

export async function mapPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: PoolOptions,
): Promise<Settled<R>[]> {
  const limit = Math.max(1, Math.floor(options.limit));
  const results = new Array<Settled<R>>(items.length);
  let cursor = 0;

  const runNext = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);

  const abortReason = options.signal?.reason ?? new Error('Aborted');
  for (let i = 0; i < results.length; i++) {
    results[i] ??= { status: 'rejected', reason: abortReason };
  }
  return results;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
