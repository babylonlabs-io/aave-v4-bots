// `@repo/execution` — everything about getting a signed transaction onto a chain, and knowing what
// became of it. A barrel only; each concern lives in its own module:
//
//   ./nonce       the shared nonce authority (one owner per signer, re-seeded from the chain)
//   ./txSender    assemble → sign → durably record → broadcast, and what a failure there means
//   ./receipt     bounded receipt waiting
//   ./submission  WHERE a signed tx goes: the `Submitter` port + its adapters (`./submission/flashbots`)
//   ./safe        Safe{Wallet} `execTransaction` primitives — a separate concern, used by MANUAL
//                 `safe` custody (operator-cli signs with them; reconcile reads the events back)

export * from "./nonce";
export * from "./txSender";
export * from "./receipt";
export * from "./submission";
export * from "./submission/flashbots";
export * from "./safe";
