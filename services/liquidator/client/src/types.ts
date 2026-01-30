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
  wbtcAddress: Address;

  // Optional: override auto-discovered debt tokens from Spoke
  debtTokenAddresses?: Address[];

  // Auto-swap seized vaults for WBTC (default: true)
  autoSwap: boolean;

  // Monitoring
  metricsPort: number;
}
