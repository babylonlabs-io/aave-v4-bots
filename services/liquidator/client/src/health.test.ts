import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HealthCheckDependencies, runHealthChecks, updateLastPollTime } from "./health";

describe("health checks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runHealthChecks", () => {
    it("should return healthy when all dependencies are up", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("healthy");
      expect(result.ponderReachable).toBe(true);
      expect(result.rpcReachable).toBe(true);
      expect(result.latestBlockNumber).toBe("12345");
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    it("should return degraded when only Ponder is up", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      const mockPublicClient = {
        getBlockNumber: vi.fn().mockRejectedValue(new Error("RPC down")),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("degraded");
      expect(result.ponderReachable).toBe(true);
      expect(result.rpcReachable).toBe(false);
      expect(result.latestBlockNumber).toBeNull();
    });

    it("should return degraded when only RPC is up", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Ponder down"));

      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
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
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.status).toBe("unhealthy");
      expect(result.ponderReachable).toBe(false);
      expect(result.rpcReachable).toBe(false);
    });

    it("should return degraded when publicClient is null", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
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
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.ponderReachable).toBe(false);
      expect(result.rpcReachable).toBe(true);
      expect(result.status).toBe("degraded");
    });

    it("should include lastPollAt when poll has occurred", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      updateLastPollTime();

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await runHealthChecks(deps);

      expect(result.lastPollAt).toBeDefined();
      expect(result.lastPollAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });

    it("should return null lastPollAt when no poll has occurred yet", async () => {
      // Reset module to clear lastPollTime state
      vi.resetModules();
      const { runHealthChecks: freshRunHealthChecks } = await import("./health");

      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      const mockPublicClient = {
        getBlockNumber: vi.fn().mockResolvedValue(12345n),
      };

      const deps: HealthCheckDependencies = {
        ponderUrl: "http://localhost:42069",
        ponderHealthEndpoint: "/positions",
        publicClient: mockPublicClient as unknown as HealthCheckDependencies["publicClient"],
      };

      const result = await freshRunHealthChecks(deps);

      expect(result.lastPollAt).toBeNull();
    });
  });
});
