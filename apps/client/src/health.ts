import type { PublicClient } from "viem";

export interface HealthCheckResult {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  lastPollAt: string | null;
  ponderReachable: boolean;
  rpcReachable: boolean;
  latestBlockNumber: string | null;
}

export interface HealthCheckDependencies {
  ponderUrl: string;
  publicClient: PublicClient | null;
}

// Track when the process started
const startTime = Date.now();

// Track last poll attempt (updated externally after each poll cycle)
let lastPollTime: Date | null = null;

/**
 * Update the last poll timestamp
 */
export function updateLastPollTime(): void {
  lastPollTime = new Date();
}

/**
 * Check if Ponder API is reachable
 */
async function checkPonderHealth(ponderUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${ponderUrl}/positions`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

interface RpcHealthResult {
  reachable: boolean;
  blockNumber: bigint | null;
}

/**
 * Check if RPC is reachable and return latest block number
 */
async function checkRpcHealth(publicClient: PublicClient | null): Promise<RpcHealthResult> {
  if (!publicClient) {
    return { reachable: false, blockNumber: null };
  }

  try {
    const blockNumber = await publicClient.getBlockNumber();
    return { reachable: true, blockNumber };
  } catch {
    return { reachable: false, blockNumber: null };
  }
}

/**
 * Run all health checks
 */
export async function runHealthChecks(deps: HealthCheckDependencies): Promise<HealthCheckResult> {
  const [ponderReachable, rpcHealth] = await Promise.all([
    checkPonderHealth(deps.ponderUrl),
    checkRpcHealth(deps.publicClient),
  ]);

  let status: HealthCheckResult["status"];
  if (ponderReachable && rpcHealth.reachable) {
    status = "healthy";
  } else if (ponderReachable || rpcHealth.reachable) {
    status = "degraded";
  } else {
    status = "unhealthy";
  }

  return {
    status,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastPollAt: lastPollTime?.toISOString() ?? null,
    ponderReachable,
    rpcReachable: rpcHealth.reachable,
    latestBlockNumber: rpcHealth.blockNumber?.toString() ?? null,
  };
}
