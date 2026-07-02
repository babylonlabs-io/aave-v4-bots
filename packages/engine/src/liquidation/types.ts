import type { Address } from "viem";

export interface LiquidatablePosition {
  proxyAddress: Address;
  borrower: Address;
  amounts: string[];
  vaults: string[];
  suppliedShares: string;
}

export interface PonderResponse {
  liquidatable: LiquidatablePosition[];
  total: number;
  checked: number;
}
