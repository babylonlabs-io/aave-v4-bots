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

  // The signing key is a secret (@repo/secrets), no longer a config field.
  const validEnv = {
    PONDER_URL: "http://localhost:42070",
    CLIENT_RPC_URL: "http://localhost:8545",
    VAULT_SWAP_ADDRESS: "0x1234567890123456789012345678901234567890",
    WBTC_ADDRESS: "0x1234567890123456789012345678901234567890",
  };

  describe("required fields", () => {
    it("should fail when PONDER_URL is missing", async () => {
      process.env = { ...validEnv };
      process.env.PONDER_URL = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail when CLIENT_RPC_URL is missing", async () => {
      process.env = { ...validEnv };
      process.env.CLIENT_RPC_URL = undefined;

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("format validation", () => {
    it("should fail with invalid address format", async () => {
      process.env = { ...validEnv, VAULT_SWAP_ADDRESS: "not-an-address" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
    });

    it("should fail with address too short", async () => {
      process.env = { ...validEnv, WBTC_ADDRESS: "0x1234" };

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

      expect(config.ponderUrl).toBe(validEnv.PONDER_URL);
      expect(config.rpcUrl).toBe(validEnv.CLIENT_RPC_URL);
      expect(config.vaultSwapAddress).toBe(validEnv.VAULT_SWAP_ADDRESS);
      expect(config.wbtcAddress).toBe(validEnv.WBTC_ADDRESS);
    });

    it("should use default values for optional fields", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.pollingIntervalMs).toBe(30000);
      expect(config.vaultProcessingDelayMs).toBe(0);
      expect(config.maxSlippageBps).toBe(100);
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
        METRICS_PORT: "3000",
        RETRY_MAX_ATTEMPTS: "5",
        TX_RECEIPT_TIMEOUT_MS: "60000",
      };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.pollingIntervalMs).toBe(60000);
      expect(config.maxSlippageBps).toBe(200);
      expect(config.metricsPort).toBe(3000);
      expect(config.retryMaxAttempts).toBe(5);
      expect(config.txReceiptTimeoutMs).toBe(60000);
    });
  });

  describe("signer / secrets source selection", () => {
    it("defaults to local signer + env secrets with the conventional key ref", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.secrets).toEqual({ source: "env", region: undefined });
      expect(config.signer).toEqual({ source: "local", keyRef: "ARBITRAGEUR_PRIVATE_KEY" });
    });

    it("selects aws signer + aws secrets when configured", async () => {
      process.env = {
        ...validEnv,
        SECRETS_PROVIDER: "aws",
        SIGNER_SOURCE: "aws",
        KMS_KEY_ID: "arn:aws:kms:us-east-1:0:key/abc",
        AWS_REGION: "us-east-1",
      };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.secrets).toEqual({ source: "aws", region: "us-east-1" });
      expect(config.signer).toEqual({
        source: "aws",
        keyId: "arn:aws:kms:us-east-1:0:key/abc",
        address: undefined,
        region: "us-east-1",
      });
    });

    it("fails when SIGNER_SOURCE=aws but KMS_KEY_ID is missing", async () => {
      process.env = { ...validEnv, SIGNER_SOURCE: "aws" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow(/SIGNER_SOURCE=aws requires KMS_KEY_ID/);
    });

    it("shares one signer across both engines (dual-engine mode)", async () => {
      process.env = {
        ...validEnv,
        ADAPTER_ADDRESS: "0x1111111111111111111111111111111111111111",
        LENS_ADDRESS: "0x2222222222222222222222222222222222222222",
      };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      // The liquidation engine has no signer of its own — index.ts wires the single
      // `config.signer` into both engines' shared wallet client.
      expect(config.liquidation).toBeDefined();
      expect(config.signer).toEqual({ source: "local", keyRef: "ARBITRAGEUR_PRIVATE_KEY" });
    });
  });

  describe("liquidation mode (opt-in dual engine)", () => {
    const adapter = "0x1111111111111111111111111111111111111111";
    const lens = "0x2222222222222222222222222222222222222222";

    it("leaves liquidation undefined when ADAPTER/LENS are unset (arbitrage-only)", async () => {
      process.env = { ...validEnv };
      const { loadConfig } = await import("./config");
      expect(loadConfig().liquidation).toBeUndefined();
    });

    it("populates liquidation when ADAPTER_ADDRESS + LENS_ADDRESS are both set", async () => {
      process.env = { ...validEnv, ADAPTER_ADDRESS: adapter, LENS_ADDRESS: lens };
      const { loadConfig } = await import("./config");
      const liq = loadConfig().liquidation;

      expect(liq).toBeDefined();
      expect(liq?.adapterAddress).toBe(adapter);
      expect(liq?.lensAddress).toBe(lens);
      expect(liq?.wbtcAddress).toBe(validEnv.WBTC_ADDRESS); // shared with arbitrage
      expect(liq?.ponderUrl).toBe(validEnv.PONDER_URL); // shared
      expect(liq?.pollingIntervalMs).toBe(12000); // default
    });

    it("throws on a half-configured liquidation mode (only ADAPTER_ADDRESS)", async () => {
      process.env = { ...validEnv, ADAPTER_ADDRESS: adapter };
      const { loadConfig } = await import("./config");
      expect(() => loadConfig()).toThrow(/BOTH ADAPTER_ADDRESS and LENS_ADDRESS/);
    });

    it("throws on a half-configured liquidation mode (only LENS_ADDRESS)", async () => {
      process.env = { ...validEnv, LENS_ADDRESS: lens };
      const { loadConfig } = await import("./config");
      expect(() => loadConfig()).toThrow(/BOTH ADAPTER_ADDRESS and LENS_ADDRESS/);
    });

    describe("funding", () => {
      const wbtc = validEnv.WBTC_ADDRESS;
      const usdc = "0x4444444444444444444444444444444444444444";
      const liqEnv = { ADAPTER_ADDRESS: adapter, LENS_ADDRESS: lens };
      const flashEnv = {
        LIQUIDATION_FUNDING: "flash",
        LIQUIDATION_ROUTER_ADDRESS: "0x5555555555555555555555555555555555555555",
        FLASH_SWAP_VENUE_ADDRESS: "0x6666666666666666666666666666666666666666",
        FLASH_SWAP_POOLS: `${usdc}:${wbtc}:${usdc}:3000:60`,
        WBTC_FLASH_LOAN_ADDRESS: "0x7777777777777777777777777777777777777777",
      };

      it("defaults the liquidation engine to inventory funding", async () => {
        process.env = { ...validEnv, ...liqEnv };
        const { loadConfig } = await import("./config");
        expect(loadConfig().liquidation?.funding).toEqual({ mode: "inventory" });
      });

      it("threads flash funding into the liquidation engine", async () => {
        process.env = { ...validEnv, ...liqEnv, ...flashEnv };
        const { loadConfig } = await import("./config");
        expect(loadConfig().liquidation?.funding).toMatchObject({
          mode: "flash",
          routerAddress: flashEnv.LIQUIDATION_ROUTER_ADDRESS,
        });
      });

      it("refuses a complete flash setup with the mode flag left off", async () => {
        process.env = {
          ...validEnv,
          ...liqEnv,
          ...flashEnv,
          LIQUIDATION_FUNDING: undefined,
        } as NodeJS.ProcessEnv;
        const { loadConfig } = await import("./config");
        expect(() => loadConfig()).toThrow(/would be ignored/);
      });

      it("requires a WBTC flash-loan venue", async () => {
        process.env = {
          ...validEnv,
          ...liqEnv,
          ...flashEnv,
          WBTC_FLASH_LOAN_ADDRESS: undefined,
        } as NodeJS.ProcessEnv;
        const { loadConfig } = await import("./config");
        expect(() => loadConfig()).toThrow(/WBTC_FLASH_LOAN_ADDRESS/);
      });

      it("rejects flash funding without the liquidation engine", async () => {
        // The vars would otherwise parse cleanly and do nothing at all.
        process.env = { ...validEnv, ...flashEnv };
        const { loadConfig } = await import("./config");
        expect(() => loadConfig()).toThrow(/has no effect without the liquidation engine/);
      });

      it("allows RISK_MIN_PROFIT when the liquidation engine is flash-funded", async () => {
        // Both engines can price themselves in this combination, so the floor gates everything.
        process.env = { ...validEnv, ...liqEnv, ...flashEnv, RISK_MIN_PROFIT: "1000" };
        const { loadConfig } = await import("./config");
        expect(() => loadConfig()).not.toThrow();
      });

      it("still rejects RISK_MIN_PROFIT when the liquidation engine is inventory-funded", async () => {
        process.env = { ...validEnv, ...liqEnv, RISK_MIN_PROFIT: "1000" };
        const { loadConfig } = await import("./config");
        expect(() => loadConfig()).toThrow(/RISK_MIN_PROFIT/);
      });
    });
  });
});
