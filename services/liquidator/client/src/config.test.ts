import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const validEnv = {
    LIQUIDATOR_PRIVATE_KEY: "0xpriv_key",
    PONDER_URL: "http://localhost:42069",
    RPC_URL: "http://localhost:8545",
    CONTROLLER_ADDRESS: "0x1234567890123456789012345678901234567890",
    VAULT_SWAP_ADDRESS: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    WBTC_ADDRESS: "0x0000000000000000000000000000000000000001",
  };

  describe("required fields", () => {
    it("should throw when LIQUIDATOR_PRIVATE_KEY is missing", async () => {
      process.env = { ...validEnv };
      process.env.LIQUIDATOR_PRIVATE_KEY = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow(
        "Missing required environment variable: LIQUIDATOR_PRIVATE_KEY"
      );
    });

    it("should throw when PONDER_URL is missing", async () => {
      process.env = { ...validEnv };
      process.env.PONDER_URL = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Missing required environment variable: PONDER_URL");
    });

    it("should throw when RPC_URL is missing", async () => {
      process.env = { ...validEnv };
      process.env.RPC_URL = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Missing required environment variable: RPC_URL");
    });

    it("should throw when CONTROLLER_ADDRESS is missing", async () => {
      process.env = { ...validEnv };
      process.env.CONTROLLER_ADDRESS = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow(
        "Missing required environment variable: CONTROLLER_ADDRESS"
      );
    });

    it("should throw when VAULT_SWAP_ADDRESS is missing", async () => {
      process.env = { ...validEnv };
      process.env.VAULT_SWAP_ADDRESS = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow(
        "Missing required environment variable: VAULT_SWAP_ADDRESS"
      );
    });

    it("should throw when WBTC_ADDRESS is missing", async () => {
      process.env = { ...validEnv };
      process.env.WBTC_ADDRESS = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Missing required environment variable: WBTC_ADDRESS");
    });
  });

  describe("successful config loading", () => {
    it("should return config with all required fields", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.liquidatorPrivateKey).toBe(validEnv.LIQUIDATOR_PRIVATE_KEY);
      expect(config.ponderUrl).toBe(validEnv.PONDER_URL);
      expect(config.rpcUrl).toBe(validEnv.RPC_URL);
      expect(config.controllerAddress).toBe(validEnv.CONTROLLER_ADDRESS);
      expect(config.vaultSwapAddress).toBe(validEnv.VAULT_SWAP_ADDRESS);
      expect(config.wbtcAddress).toBe(validEnv.WBTC_ADDRESS);
    });

    it("should use default values for optional fields", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.pollingIntervalMs).toBe(10000);
      expect(config.autoSwap).toBe(true);
      expect(config.metricsPort).toBe(9090);
      expect(config.debtTokenAddresses).toBeUndefined();
    });

    it("should parse custom polling interval", async () => {
      process.env = { ...validEnv, POLLING_INTERVAL_MS: "30000" };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.pollingIntervalMs).toBe(30000);
    });

    it("should parse custom metrics port", async () => {
      process.env = { ...validEnv, METRICS_PORT: "3000" };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.metricsPort).toBe(3000);
    });

    it("should parse AUTO_SWAP=false", async () => {
      process.env = { ...validEnv, AUTO_SWAP: "false" };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.autoSwap).toBe(false);
    });

    it("should parse AUTO_SWAP=FALSE (case insensitive)", async () => {
      process.env = { ...validEnv, AUTO_SWAP: "FALSE" };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.autoSwap).toBe(false);
    });

    it("should default AUTO_SWAP to true when not set", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.autoSwap).toBe(true);
    });
  });

  describe("debt token addresses", () => {
    it("should parse comma-separated debt token addresses", async () => {
      process.env = {
        ...validEnv,
        DEBT_TOKEN_ADDRESSES:
          "0xaaaa000000000000000000000000000000000001,0xbbbb000000000000000000000000000000000002",
      };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.debtTokenAddresses).toHaveLength(2);
      expect(config.debtTokenAddresses![0]).toBe("0xaaaa000000000000000000000000000000000001");
      expect(config.debtTokenAddresses![1]).toBe("0xbbbb000000000000000000000000000000000002");
    });

    it("should trim whitespace from debt token addresses", async () => {
      process.env = {
        ...validEnv,
        DEBT_TOKEN_ADDRESSES:
          " 0xaaaa000000000000000000000000000000000001 , 0xbbbb000000000000000000000000000000000002 ",
      };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.debtTokenAddresses).toHaveLength(2);
      expect(config.debtTokenAddresses![0]).toBe("0xaaaa000000000000000000000000000000000001");
      expect(config.debtTokenAddresses![1]).toBe("0xbbbb000000000000000000000000000000000002");
    });

    it("should set debtTokenAddresses to undefined when empty string", async () => {
      process.env = { ...validEnv, DEBT_TOKEN_ADDRESSES: "" };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.debtTokenAddresses).toBeUndefined();
    });

    it("should set debtTokenAddresses to undefined when not provided", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.debtTokenAddresses).toBeUndefined();
    });
  });
});
