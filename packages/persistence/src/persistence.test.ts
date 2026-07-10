import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { type IntentInput, idempotencyKey } from "./index";
import { createMemoryStateStore } from "./memory";

// `reconcilePending` moved to `@repo/engine` (it orchestrates this store *and* chain queries);
// its tests live there, in `reconcile.test.ts`.

const TARGET = "0x2222222222222222222222222222222222222222" as Address;

function input(subject: string, over: Partial<IntentInput> = {}): IntentInput {
  return { chainId: 31337, target: TARGET, action: "liquidation", subject, ...over };
}

describe("idempotencyKey", () => {
  it("is deterministic and independent of address casing", () => {
    const a = idempotencyKey(input("0xABCDEF0000000000000000000000000000000000"));
    const b = idempotencyKey(input("0xabcdef0000000000000000000000000000000000"));
    expect(a).toBe(b);
    expect(a).toBe(
      "31337:0x2222222222222222222222222222222222222222:liquidation:0xabcdef0000000000000000000000000000000000"
    );
  });

  it("distinguishes chain, target, action and subject", () => {
    const base = input("pos-1");
    expect(idempotencyKey(base)).not.toBe(idempotencyKey(input("pos-2")));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey(input("pos-1", { action: "arb" })));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey(input("pos-1", { chainId: 1 })));
  });
});

describe("recordIntent idempotency (memory model)", () => {
  it("refuses a second live record, revives a terminal one", async () => {
    const store = createMemoryStateStore();
    expect((await store.recordIntent(input("p"))).recorded).toBe(true);

    const second = await store.recordIntent(input("p"));
    expect(second.recorded).toBe(false);

    await store.transition(idempotencyKey(input("p")), "confirmed");
    expect((await store.recordIntent(input("p"))).recorded).toBe(true); // revived
  });
});
