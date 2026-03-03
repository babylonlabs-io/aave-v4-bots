import type { Address, Hex } from "viem";

export interface LiquidatablePosition {
  proxyAddress: Address;
  borrower: Address;
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
  lensAddress: Address;
  wbtcAddress: Address;

  // Optional: override auto-discovered debt tokens from Spoke
  debtTokenAddresses?: Address[];

  // BTC redeem key (default: bytes32(0) for WBTC payout via VaultSwap)
  btcRedeemKey: Hex;

  // Monitoring
  metricsPort: number;

  // Transaction timeout
  txReceiptTimeoutMs: number;
}
