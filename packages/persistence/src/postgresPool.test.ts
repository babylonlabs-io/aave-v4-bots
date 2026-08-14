import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POOL_TIMEOUTS, createPostgresStateStore } from "./postgres";

// The pool the store builds when no client is injected is the one production runs on, and it is the
// only place these deadlines are applied — every other test in this package injects a client and
// never touches it. Without this, the store could construct a pool with no deadlines at all and
// every other suite would still pass.

const Pool = vi.fn();
vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = vi.fn();
      constructor(options: unknown) {
        Pool(options);
      }
    },
  },
}));

describe("the pool the store builds for itself", () => {
  beforeEach(() => Pool.mockClear());

  it("carries a deadline on every way a query can fail to return", () => {
    createPostgresStateStore({ connectionString: "postgres://localhost/bot" });

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining(DEFAULT_POOL_TIMEOUTS));
  });

  it("still lets a caller supply its own client", () => {
    const client = { query: vi.fn(), end: vi.fn() };

    createPostgresStateStore({ connectionString: "postgres://localhost/bot", client });

    expect(Pool).not.toHaveBeenCalled();
  });
});
