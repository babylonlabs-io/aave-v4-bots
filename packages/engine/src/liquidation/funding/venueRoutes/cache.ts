/**
 * Memoises reads for one poll cycle.
 *
 * Several candidates in a cycle ask the same venue about different amounts, and part of what a venue
 * needs to answer does not depend on the amount — a lender's balance, a pool's premium, a spot price.
 * A cycle's cache reads those once instead of once per candidate; starting a fresh one each cycle
 * keeps any of them from outliving the block it described.
 *
 * It holds promises, not values, so concurrent quotes share one in-flight read. A read that rejects
 * is evicted, so one transient failure does not fail every later quote in the cycle.
 */
export interface ReadCache {
  get<T>(key: string, load: () => Promise<T>): Promise<T>;
}

export function createReadCache(): ReadCache {
  const entries = new Map<string, Promise<unknown>>();
  return {
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit !== undefined) return hit as Promise<T>;
      const pending = load();
      entries.set(key, pending);
      pending.catch(() => {
        if (entries.get(key) === pending) entries.delete(key);
      });
      return pending;
    },
  };
}
