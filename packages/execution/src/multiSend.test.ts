import { type Hex, decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  MULTI_SEND_CALL_ONLY,
  buildMultiSendCall,
  encodeCall,
  isMultiSendCallOnly,
  multiSendCallOnlyAbi,
} from "./index";

const WBTC = "0x549A9C66B3d310A0cb706B8Efacf46bb13Abf210" as const;
const SPENDER = "0xA5f877cEfEAA7534460f19d7fc8b76CdE820a92A" as const;
const approveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);

describe("buildMultiSendCall", () => {
  it("packs each call as operation, to, value, data length, data", () => {
    const call = buildMultiSendCall([
      { address: WBTC, abi: approveAbi, functionName: "approve", args: [SPENDER, 5n] },
      { address: WBTC, abi: approveAbi, functionName: "approve", args: [SPENDER, 0n] },
    ]);
    const { data } = encodeCall(call);
    const { args } = decodeFunctionData({ abi: multiSendCallOnlyAbi, data });
    const packed = (args[0] as Hex).slice(2);

    // Written out by hand from MultiSend's documented layout, independent of the encoder.
    const word = (n: number) => n.toString(16).padStart(64, "0");
    const approveData = (amount: number) =>
      `095ea7b3${"0".repeat(24)}${SPENDER.slice(2).toLowerCase()}${word(amount)}`;
    const entry = (amount: number) =>
      `00${WBTC.slice(2).toLowerCase()}${word(0)}${word(68)}${approveData(amount)}`;
    expect(packed).toBe(entry(5) + entry(0));
    expect(call.address).toBe(MULTI_SEND_CALL_ONLY);
  });

  it("refuses an empty batch", () => {
    expect(() => buildMultiSendCall([])).toThrow(/at least one call/);
  });
});

describe("isMultiSendCallOnly", () => {
  it("matches the pinned address in any letter case, and nothing else", () => {
    expect(isMultiSendCallOnly(MULTI_SEND_CALL_ONLY.toLowerCase() as Hex)).toBe(true);
    expect(isMultiSendCallOnly("0x9641d764fc13c8B624c04430C7356C1C7C8102e2")).toBe(false);
  });
});
