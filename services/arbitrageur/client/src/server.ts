import type { PublicClient } from "viem";

import {
  setPublicClient as sharedSetPublicClient,
  startMetricsServer as sharedStartMetricsServer,
} from "@repo/shared";
import { getMetrics, getMetricsContentType } from "./metrics";

export interface MetricsServerConfig {
  port: number;
  ponderUrl: string;
}

/**
 * Update the public client reference for health checks
 */
export function setPublicClient(client: PublicClient): void {
  sharedSetPublicClient(client);
}

/**
 * Start the metrics and health check HTTP server
 */
export function startMetricsServer(config: MetricsServerConfig): void {
  sharedStartMetricsServer({
    port: config.port,
    ponderUrl: config.ponderUrl,
    ponderHealthEndpoint: "/escrowed-vaults",
    getMetrics,
    getMetricsContentType,
  });
}
