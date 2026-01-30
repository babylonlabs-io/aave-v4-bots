import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to test the validation logic, so we'll import the schema parts
// and test them directly rather than calling loadConfig which exits on failure

describe("config validation", () => {
  const originalEnv = process.env;
  const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    mockExit.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const validEnv = {
    ARBITRAGEUR_PRIVATE_KEY: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    PONDER_URL: "http://localhost:42070",
    RPC_URL: "http://localhost:8545",
    CONTROLLER_ADDRESS: "0x1234567890123456789012345678901234567890",
    VAULT_SWAP_ADDRESS: "0x1234567890123456789012345678901234567890",
    WBTC_ADDRESS: "0x1234567890123456789012345678901234567890",
  };

  describe("required fields", () => {
    it("should fail when ARBITRAGEUR_PRIVATE_KEY is missing", async () => {
      process.env = { ...validEnv };
      process.env.ARBITRAGEUR_PRIVATE_KEY = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail when PONDER_URL is missing", async () => {
      process.env = { ...validEnv };
      process.env.PONDER_URL = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail when RPC_URL is missing", async () => {
      process.env = { ...validEnv };
      process.env.RPC_URL = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail when CONTROLLER_ADDRESS is missing", async () => {
      process.env = { ...validEnv };
      process.env.CONTROLLER_ADDRESS = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("format validation", () => {
    it("should fail with invalid private key format", async () => {
      process.env = { ...validEnv, ARBITRAGEUR_PRIVATE_KEY: "not-a-hex" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
    });

    it("should fail with private key too short", async () => {
      process.env = { ...validEnv, ARBITRAGEUR_PRIVATE_KEY: "0x1234" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
    });

    it("should fail with invalid address format", async () => {
      process.env = { ...validEnv, CONTROLLER_ADDRESS: "not-an-address" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
    });

    it("should fail with address too short", async () => {
      process.env = { ...validEnv, CONTROLLER_ADDRESS: "0x1234" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
    });

    it("should fail with invalid URL format", async () => {
      process.env = { ...validEnv, PONDER_URL: "not-a-url" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
    });
  });

  describe("successful validation", () => {
    it("should return config with all required fields", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.arbitrageurPrivateKey).toBe(validEnv.ARBITRAGEUR_PRIVATE_KEY);
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

      expect(config.pollingIntervalMs).toBe(30000);
      expect(config.vaultProcessingDelayMs).toBe(5000);
      expect(config.maxSlippageBps).toBe(100);
      expect(config.autoRedeem).toBe(true);
      expect(config.metricsPort).toBe(9091);
      expect(config.retryMaxAttempts).toBe(3);
      expect(config.retryInitialDelayMs).toBe(1000);
      expect(config.retryMaxDelayMs).toBe(30000);
      expect(config.txReceiptTimeoutMs).toBe(120000);
    });

    it("should parse custom optional values", async () => {
      process.env = {
        ...validEnv,
        POLLING_INTERVAL_MS: "60000",
        MAX_SLIPPAGE_BPS: "200",
        AUTO_REDEEM: "false",
        METRICS_PORT: "3000",
        RETRY_MAX_ATTEMPTS: "5",
        TX_RECEIPT_TIMEOUT_MS: "60000",
      };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.pollingIntervalMs).toBe(60000);
      expect(config.maxSlippageBps).toBe(200);
      expect(config.autoRedeem).toBe(false);
      expect(config.metricsPort).toBe(3000);
      expect(config.retryMaxAttempts).toBe(5);
      expect(config.txReceiptTimeoutMs).toBe(60000);
    });
  });
});
