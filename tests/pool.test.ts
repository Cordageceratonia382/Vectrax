import { describe, expect, it } from 'vitest';

import { mapPool, delay } from '../src/core/util/pool.js';
import { computeBackoff } from '../src/core/http/client.js';

describe('mapPool', () => {
  it('returns results in input order', async () => {
    const results = await mapPool(
      [30, 10, 20],
      async (ms) => {
        await delay(ms);
        return ms;
      },
      { limit: 3 },
    );
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(5);
        running--;
      },
      { limit: 4 },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('settles every task even when some reject', async () => {
    const results = await mapPool(
      [1, 2, 3, 4],
      async (n) => {
        if (n % 2 === 0) throw new Error(`boom ${n}`);
        return n;
      },
      { limit: 2 },
    );
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected']);
    expect(results[1]?.status === 'rejected' && (results[1].reason as Error).message).toBe('boom 2');
  });

  it('stops scheduling once the signal aborts, leaving no holes', async () => {
    const controller = new AbortController();
    let started = 0;
    const results = await mapPool(
      Array.from({ length: 50 }, (_, i) => i),
      async (n) => {
        started++;
        if (n === 3) controller.abort(new Error('stop'));
        await delay(1);
        return n;
      },
      { limit: 2, signal: controller.signal },
    );
    expect(started).toBeLessThan(50);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r !== undefined)).toBe(true);
  });

  it('handles an empty input list', async () => {
    expect(await mapPool([], async () => 1, { limit: 4 })).toEqual([]);
  });

  it('clamps a limit below 1', async () => {
    const results = await mapPool([1, 2], async (n) => n, { limit: 0 });
    expect(results).toHaveLength(2);
  });
});

describe('delay', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('nope'));
    await expect(delay(1000, controller.signal)).rejects.toThrow('nope');
  });

  it('rejects when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const promise = delay(5000, controller.signal);
    setTimeout(() => controller.abort(new Error('later')), 10);
    await expect(promise).rejects.toThrow('later');
  });
});

describe('computeBackoff', () => {
  it('grows exponentially and stays within the jitter band', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const ceiling = Math.min(100 * 2 ** (attempt - 1), 15_000);
      for (let i = 0; i < 25; i++) {
        const value = computeBackoff(attempt, 100, null);
        expect(value).toBeGreaterThanOrEqual(Math.floor(ceiling * 0.5));
        expect(value).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('honours a numeric Retry-After', () => {
    expect(computeBackoff(1, 100, '5')).toBe(5000);
  });

  it('caps Retry-After at 30 seconds', () => {
    expect(computeBackoff(1, 100, '9999')).toBe(30_000);
  });

  it('honours an HTTP-date Retry-After', () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const value = computeBackoff(1, 100, future);
    expect(value).toBeGreaterThan(1000);
    expect(value).toBeLessThanOrEqual(3000);
  });

  it('ignores an unparseable Retry-After', () => {
    expect(computeBackoff(1, 100, 'soon')).toBeLessThanOrEqual(100);
  });
});
