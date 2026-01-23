import type { Address, Hex } from "viem";

export interface LiquidatablePosition {
  proxyAddress: Address;
  healthFactor: string;
  totalCollateralValue: string;
  totalDebtValue: string;
  suppliedShares: string;
}

export interface PonderResponse {
  liquidatable: LiquidatablePosition[];
  total: number;
  checked: number;
}

export interface Config {
  // Liquidator
  liquidatorPrivateKey: Hex;

  // Polling
  pollingIntervalMs: number;

  // URLs
  ponderUrl: string;
  rpcUrl: string;

  // Contract addresses
  controllerAddress: Address;
  vaultSwapAddress: Address;
  debtTokenAddresses: Address[];
  wbtcAddress: Address;
}
