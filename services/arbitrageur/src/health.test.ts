import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HealthCheckDependencies,
  getLastPollTime,
  runHealthChecks,
  updateLastPollTime,
} from "./health";

describe("health checks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("updateLastPollTime / getLastPollTime", () => {
    it("should update and return last poll time", () => {
      const before = getLastPollTime();

      updateLastPollTime();

      const after = getLastPollTime();
      expect(after).toBeInstanceOf(Date);
      expect(after).not.toBe(before);
    });
  });

  describe("runHealthChecks", () => {
    it("should return healthy when all dependencies are up", async () => {
      // Mock fetch for Ponder API
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
      });

      // Mock public client
      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42070",
        ponderHealthEndpoint: "/escrowed-vaults",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("healthy");
      expect(result.ponderReachable).toBe(true);
      expect(result.rpcReachable).toBe(true);
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    it("should return degraded when only Ponder is up", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
      });

      const mockPublicClient = {
        getBlockNumber: vi.fn().mockRejectedValue(new Error("RPC down")),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42070",
        ponderHealthEndpoint: "/escrowed-vaults",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("degraded");
      expect(result.ponderReachable).toBe(true);
      expect(result.rpcReachable).toBe(false);
    });

    it("should return degraded when only RPC is up", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Ponder down"));

      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42070",
        ponderHealthEndpoint: "/escrowed-vaults",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("degraded");
      expect(result.ponderReachable).toBe(false);
      expect(result.rpcReachable).toBe(true);
    });

    it("should return unhealthy when all dependencies are down", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Ponder down"));

      const mockPublicClient = {
        getBlockNumber: vi.fn().mockRejectedValue(new Error("RPC down")),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42070",
        ponderHealthEndpoint: "/escrowed-vaults",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("unhealthy");
      expect(result.ponderReachable).toBe(false);
      expect(result.rpcReachable).toBe(false);
    });

    it("should return unhealthy when publicClient is null", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42070",
        ponderHealthEndpoint: "/escrowed-vaults",
        publicClient: null,
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("degraded");
      expect(result.ponderReachable).toBe(true);
      expect(result.rpcReachable).toBe(false);
    });

    it("should handle Ponder returning non-ok response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42070",
        ponderHealthEndpoint: "/escrowed-vaults",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.ponderReachable).toBe(false);
    });

    it("should include lastPollAt when poll has occurred", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      updateLastPollTime();

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42070",
        ponderHealthEndpoint: "/escrowed-vaults",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.lastPollAt).toBeDefined();
      expect(result.lastPollAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });
  });
});
