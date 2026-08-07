import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, encodeAbiParameters, hashTypedData, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARBITRAGE_ROUTER_EIP712_NAME,
  ARBITRAGE_ROUTER_EIP712_VERSION,
  RELAYER_MESSAGE_TYPES,
  arbitrageRouterDomain,
} from "./arbitrageRouter";

// The EIP-712 schema is written twice — as a string literal the contract keccaks into
// `RELAYER_MESSAGE_TYPEHASH`, and as the object viem derives the same string from. Nothing links
// them, and a mismatch does not fail loudly: the signature simply recovers to some other address,
// and the router reverts with "invalid signature". That reads as a key or config problem, not a
// schema problem, which is exactly why this is worth pinning.
//
// These read the Solidity source rather than a compiled artifact: the values are `constant`
// expressions, so they never appear in the ABI, and the string literal IS the specification.

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts");

const source = (file: string) => readFileSync(join(CONTRACTS, file), "utf8");

/** The single-quoted or double-quoted literal a Solidity `keccak256("…")` constant hashes. */
function keccakLiteral(src: string, constantName: string): string {
  const pattern = new RegExp(`${constantName}\\s*=\\s*\\n?\\s*keccak256\\("([^"]+)"\\)`);
  const match = src.match(pattern);
  if (!match) throw new Error(`could not find keccak256 literal for ${constantName}`);
  return match[1];
}

type TypeName = keyof typeof RELAYER_MESSAGE_TYPES;

/** EIP-712 `encodeType`, derived from the schema rather than asserted, so the test has its own say. */
function encodeType(primary: TypeName): string {
  const render = (name: TypeName) =>
    `${name}(${RELAYER_MESSAGE_TYPES[name].map((f) => `${f.type} ${f.name}`).join(",")})`;

  // Only the types the primary type *transitively references*, sorted alphabetically. Listing every
  // type in the schema instead would be wrong for a leaf like `Call`, which references nothing.
  const referenced = new Set<TypeName>();
  const visit = (name: TypeName) => {
    for (const field of RELAYER_MESSAGE_TYPES[name]) {
      const base = field.type.replace(/\[\d*\]$/, "") as TypeName;
      if (base in RELAYER_MESSAGE_TYPES && !referenced.has(base) && base !== primary) {
        referenced.add(base);
        visit(base);
      }
    }
  };
  visit(primary);

  return [render(primary), ...[...referenced].sort().map(render)].join("");
}

describe("ArbitrageRouter EIP-712 schema", () => {
  const relayer = source("base/SelfCallRelayer.sol");
  const router = source("ArbitrageRouter.sol");

  it("derives the same RelayerMessage type string the contract hashes", () => {
    expect(encodeType("RelayerMessage")).toBe(keccakLiteral(relayer, "RELAYER_MESSAGE_TYPEHASH"));
  });

  it("derives the same Call type string the contract hashes", () => {
    expect(encodeType("Call")).toBe(keccakLiteral(relayer, "CALL_TYPEHASH"));
  });

  it("uses the router's own domain name and version", () => {
    // A domain mismatch is the same silent failure: a valid signature over the wrong separator.
    const constant = (name: string) => {
      const match = router.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
      if (!match) throw new Error(`could not find ${name}`);
      return match[1];
    };
    expect(ARBITRAGE_ROUTER_EIP712_NAME).toBe(constant("NAME"));
    expect(ARBITRAGE_ROUTER_EIP712_VERSION).toBe(constant("VERSION"));
  });

  // The authority. The two tests above compare type *strings*, which is a good diagnostic but still
  // goes through this file's own `encodeType`. This one rebuilds the digest the way the contract
  // does — from the literals in the Solidity source — and compares it to what viem will actually
  // sign. Any disagreement in schema, field order, domain or encoding shows up here.
  it("produces the same digest the contract verifies", () => {
    const message = {
      calls: [
        { data: "0xdeadbeef" as const, value: 0n },
        { data: "0xfeed" as const, value: 7n },
      ],
      deadline: 1_800_000_000n,
    };
    const chainId = 31337;
    const verifyingContract = "0x1111111111111111111111111111111111111111" as const;

    // `_hashTypedDataV4`'s domain separator, per OpenZeppelin's EIP712.
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [
          keccak256(
            toHex(
              "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
            )
          ),
          keccak256(toHex(ARBITRAGE_ROUTER_EIP712_NAME)),
          keccak256(toHex(ARBITRAGE_ROUTER_EIP712_VERSION)),
          BigInt(chainId),
          verifyingContract,
        ]
      )
    );

    // `_hashCall` — `data` is dynamic, so its contents are hashed.
    const callTypeHash = keccak256(toHex(keccakLiteral(relayer, "CALL_TYPEHASH")));
    const callHashes = message.calls.map((call) =>
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
          [callTypeHash, keccak256(call.data), call.value]
        )
      )
    );

    // `_hashRelayerMessage_signing` — the `Call[]` member is the keccak of the concatenated hashes.
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [
          keccak256(toHex(keccakLiteral(relayer, "RELAYER_MESSAGE_TYPEHASH"))),
          keccak256(concat(callHashes)),
          message.deadline,
        ]
      )
    );

    const fromContract = keccak256(concat(["0x1901", domainSeparator, structHash]));

    expect(
      hashTypedData({
        domain: arbitrageRouterDomain({ chainId, verifyingContract }),
        types: RELAYER_MESSAGE_TYPES,
        primaryType: "RelayerMessage",
        message,
      })
    ).toBe(fromContract);
  });

  it("binds a digest to one chain and one router", () => {
    // The only replay protection the scheme has — `SelfCallRelayer` carries no nonce — so a digest
    // that ignored either would make one signature valid on every deployment.
    const message = {
      calls: [{ data: "0xdeadbeef" as const, value: 0n }],
      deadline: 1_800_000_000n,
    };
    const digest = (chainId: number, verifyingContract: `0x${string}`) =>
      hashTypedData({
        domain: arbitrageRouterDomain({ chainId, verifyingContract }),
        types: RELAYER_MESSAGE_TYPES,
        primaryType: "RelayerMessage",
        message,
      });

    const a = "0x1111111111111111111111111111111111111111" as const;
    const b = "0x2222222222222222222222222222222222222222" as const;
    expect(digest(1, a)).not.toBe(digest(2, a));
    expect(digest(1, a)).not.toBe(digest(1, b));
    expect(digest(1, a)).toBe(digest(1, a));
  });
});
