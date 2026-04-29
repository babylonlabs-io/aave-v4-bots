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
    LIQUIDATOR_PRIVATE_KEY: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    PONDER_URL: "http://localhost:42069",
    CLIENT_RPC_URL: "http://localhost:8545",
    ADAPTER_ADDRESS: "0x1234567890123456789012345678901234567890",
    LENS_ADDRESS: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
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

    it("should throw when CLIENT_RPC_URL is missing", async () => {
      process.env = { ...validEnv };
      process.env.CLIENT_RPC_URL = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Missing required environment variable: CLIENT_RPC_URL");
    });

    it("should throw when ADAPTER_ADDRESS is missing", async () => {
      process.env = { ...validEnv };
      process.env.ADAPTER_ADDRESS = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Missing required environment variable: ADAPTER_ADDRESS");
    });

    it("should throw when LENS_ADDRESS is missing", async () => {
      process.env = { ...validEnv };
      process.env.LENS_ADDRESS = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Missing required environment variable: LENS_ADDRESS");
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
      expect(config.rpcUrl).toBe(validEnv.CLIENT_RPC_URL);
      expect(config.adapterAddress).toBe(validEnv.ADAPTER_ADDRESS);
      expect(config.lensAddress).toBe(validEnv.LENS_ADDRESS);
      expect(config.wbtcAddress).toBe(validEnv.WBTC_ADDRESS);
    });

    it("should use default values for optional fields", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.pollingIntervalMs).toBe(10000);
      expect(config.btcRedeemKey).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
      expect(config.metricsPort).toBe(9090);
      expect(config.isDirectRedemption).toBe(false);
      expect(config.debtTokenAddresses).toBeUndefined();
      expect(config.txReceiptTimeoutMs).toBe(120000);
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

    it("should parse custom TX_RECEIPT_TIMEOUT_MS", async () => {
      process.env = { ...validEnv, TX_RECEIPT_TIMEOUT_MS: "45000" };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.txReceiptTimeoutMs).toBe(45000);
    });

    it("should parse custom BTC_REDEEM_KEY", async () => {
      const customKey = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      process.env = { ...validEnv, BTC_REDEEM_KEY: customKey };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.btcRedeemKey).toBe(customKey);
    });

    it("should default BTC_REDEEM_KEY to bytes32(0) when not set", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.btcRedeemKey).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
    });

    it("should throw for invalid BTC_REDEEM_KEY format", async () => {
      process.env = { ...validEnv, BTC_REDEEM_KEY: "not-a-hex" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Invalid BTC_REDEEM_KEY: must be 0x-prefixed 32-byte hex");
    });

    it("should throw for short BTC_REDEEM_KEY", async () => {
      process.env = { ...validEnv, BTC_REDEEM_KEY: "0x1234" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("Invalid BTC_REDEEM_KEY: must be 0x-prefixed 32-byte hex");
    });

    it("should throw for invalid ADAPTER_ADDRESS", async () => {
      process.env = { ...validEnv, ADAPTER_ADDRESS: "not-an-address" };
      const { loadConfig } = await import("./config");
      expect(() => loadConfig()).toThrow(
        "Invalid ADAPTER_ADDRESS: must be a 0x-prefixed 20-byte hex address"
      );
    });

    it("should throw for invalid private key format", async () => {
      process.env = { ...validEnv, LIQUIDATOR_PRIVATE_KEY: "0x1234" };
      const { loadConfig } = await import("./config");
      expect(() => loadConfig()).toThrow(
        "Invalid LIQUIDATOR_PRIVATE_KEY: must be 0x-prefixed 32-byte hex"
      );
    });

    it("should throw for invalid TX_RECEIPT_TIMEOUT_MS", async () => {
      process.env = { ...validEnv, TX_RECEIPT_TIMEOUT_MS: "0" };
      const { loadConfig } = await import("./config");
      expect(() => loadConfig()).toThrow(
        "Invalid TX_RECEIPT_TIMEOUT_MS: must be a positive integer"
      );
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
