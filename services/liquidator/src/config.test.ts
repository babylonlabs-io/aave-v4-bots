import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config validation", () => {
  const originalEnv = process.env;
  // loadConfig fails fast via process.exit(1) (parseEnv); make that observable.
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
    PONDER_URL: "http://localhost:42069",
    CLIENT_RPC_URL: "http://localhost:8545",
    ADAPTER_ADDRESS: "0x1234567890123456789012345678901234567890",
    LENS_ADDRESS: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    WBTC_ADDRESS: "0x0000000000000000000000000000000000000001",
  };

  describe("required fields", () => {
    for (const key of [
      "PONDER_URL",
      "CLIENT_RPC_URL",
      "ADAPTER_ADDRESS",
      "LENS_ADDRESS",
      "WBTC_ADDRESS",
    ] as const) {
      it(`should fail when ${key} is missing`, async () => {
        process.env = { ...validEnv };
        process.env[key] = undefined;

        const { loadConfig } = await import("./config");

        expect(() => loadConfig()).toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
      });
    }
  });

  describe("format validation", () => {
    const badCases: Array<[string, string]> = [
      ["ADAPTER_ADDRESS", "not-an-address"],
      ["BTC_REDEEM_KEY", "not-a-hex"],
      ["BTC_REDEEM_KEY", "0x1234"],
      ["TX_RECEIPT_TIMEOUT_MS", "0"],
      ["PONDER_URL", "not-a-url"],
      // Malformed numbers must be rejected, not silently truncated by parseInt.
      ["POLLING_INTERVAL_MS", "1abc"],
      ["METRICS_PORT", "1.5"],
      // Basis points, not a multiplier: past 10000 the on-chain profit floor this feeds underflows
      // to zero, which is the permissive direction and looks like nothing at all downstream.
      ["FLASH_MAX_SLIPPAGE_BPS", "10001"],
      ["FLASH_MAX_SLIPPAGE_BPS", "100000"],
    ];

    for (const [key, value] of badCases) {
      it(`should fail when ${key} = ${value}`, async () => {
        process.env = { ...validEnv, [key]: value };

        const { loadConfig } = await import("./config");

        expect(() => loadConfig()).toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
      });
    }
  });

  describe("successful config loading", () => {
    it("should return config with all required fields", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.ponderUrl).toBe(validEnv.PONDER_URL);
      expect(config.rpcUrl).toBe(validEnv.CLIENT_RPC_URL);
      expect(config.adapterAddress).toBe(validEnv.ADAPTER_ADDRESS);
      expect(config.lensAddress).toBe(validEnv.LENS_ADDRESS);
      expect(config.wbtcAddress).toBe(validEnv.WBTC_ADDRESS);
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

    it("should treat empty-string optional vars as unset (apply defaults)", async () => {
      process.env = {
        ...validEnv,
        BTC_REDEEM_KEY: "",
        POLLING_INTERVAL_MS: "",
        METRICS_PORT: "",
      };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.btcRedeemKey).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
      expect(config.pollingIntervalMs).toBe(12000);
      expect(config.metricsPort).toBe(9090);
    });
  });

  describe("signer / secrets source selection", () => {
    it("defaults to local signer + env secrets with the conventional key ref", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.secrets).toEqual({ source: "env", region: undefined });
      expect(config.signer).toEqual({ source: "local", keyRef: "LIQUIDATOR_PRIVATE_KEY" });
    });

    it("honors a custom local key ref", async () => {
      process.env = { ...validEnv, SIGNER_KEY_REF: "CUSTOM_KEY_SECRET" };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.signer).toEqual({ source: "local", keyRef: "CUSTOM_KEY_SECRET" });
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

      // buildSignerConfig throws; loadConfig lets it propagate (fail-fast at boot).
      expect(() => loadConfig()).toThrow(/SIGNER_SOURCE=aws requires KMS_KEY_ID/);
    });

    it("rejects an invalid SIGNER_SOURCE", async () => {
      process.env = { ...validEnv, SIGNER_SOURCE: "gcp" };

      const { loadConfig } = await import("./config");

      expect(() => loadConfig()).toThrow("process.exit called");
    });
  });
});

describe("flash funding config", () => {
  // No process.exit spy here: the suite above already installs one for the whole module, and
  // re-spying would detach the reference its assertions check.
  const originalEnv = process.env;

  const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  const base = {
    PONDER_URL: "http://localhost:42069",
    CLIENT_RPC_URL: "http://localhost:8545",
    ADAPTER_ADDRESS: "0x1234567890123456789012345678901234567890",
    LENS_ADDRESS: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    WBTC_ADDRESS: WBTC,
  };

  const flashEnv = {
    ...base,
    LIQUIDATION_FUNDING: "flash",
    LIQUIDATION_ROUTER_ADDRESS: "0x9999999999999999999999999999999999999999",
    FLASH_SWAP_VENUE_ADDRESS: "0x1111111111111111111111111111111111111111",
    FLASH_SWAP_POOLS: `${USDC}:${WBTC}:${USDC}:3000:60`,
    WBTC_FLASH_LOAN_ADDRESS: "0x2222222222222222222222222222222222222222",
  };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to inventory funding", async () => {
    process.env = { ...originalEnv, ...base };
    const { loadConfig } = await import("./config");
    expect(loadConfig().funding).toEqual({ mode: "inventory" });
  });

  it("builds a venue registry from FLASH_SWAP_POOLS", async () => {
    process.env = { ...originalEnv, ...flashEnv };
    const { loadConfig } = await import("./config");
    const funding = loadConfig().funding;

    expect(funding).toMatchObject({ mode: "flash", maxSlippageBps: 2000 });
    if (funding?.mode !== "flash") throw new Error("expected flash");
    expect(funding.venues.flashSwaps[0].poolKey).toMatchObject({
      currency0: WBTC,
      currency1: USDC,
      fee: 3000,
      tickSpacing: 60,
    });
  });

  it("refuses a half-configured flash setup instead of falling back to inventory", async () => {
    // Silently falling back would use inventory the operator may never have funded.
    process.env = { ...originalEnv, ...flashEnv, FLASH_SWAP_POOLS: undefined } as NodeJS.ProcessEnv;
    const { loadConfig } = await import("./config");
    expect(() => loadConfig()).toThrow(/FLASH_SWAP_POOLS/);
  });

  it("rejects a pool that is not WBTC/<token> at boot", async () => {
    // Would otherwise surface as an unrepayable debt deep inside a venue callback (I3).
    process.env = {
      ...originalEnv,
      ...flashEnv,
      FLASH_SWAP_POOLS: `${USDC}:${USDC}:0x3333333333333333333333333333333333333333:3000:60`,
    };
    const { loadConfig } = await import("./config");
    expect(() => loadConfig()).toThrow(/^I3/);
  });

  it("allows RISK_MIN_PROFIT under flash funding", async () => {
    // Inventory funding cannot price its actions so the floor is rejected; flash mode probes and can,
    // which is exactly the case the old guard would have wrongly refused.
    process.env = { ...originalEnv, ...flashEnv, RISK_MIN_PROFIT: "1000" };
    const { loadConfig } = await import("./config");
    expect(() => loadConfig()).not.toThrow();
  });

  it("defaults the indexer retry to a ceiling below the poll interval", async () => {
    // 5s, not @repo/chain's 30s: at a 12s poll a backoff chain allowed to reach 30s would still be
    // sleeping when the next cycle was due, turning one slow read into several skipped ones.
    process.env = { ...originalEnv, ...base };
    const { loadConfig } = await import("./config");
    expect(loadConfig().retryConfig).toEqual({
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    });
  });

  it("lets an operator tune the indexer retry", async () => {
    process.env = { ...originalEnv, ...base, RETRY_MAX_ATTEMPTS: "5", RETRY_MAX_DELAY_MS: "2000" };
    const { loadConfig } = await import("./config");
    expect(loadConfig().retryConfig).toMatchObject({ maxAttempts: 5, maxDelayMs: 2000 });
  });

  it("refuses a complete flash setup with the mode flag left off", async () => {
    // The dangerous direction: every address is right, so nothing looks wrong, but the mode flag is
    // what selects flash and the bot would quietly repay from its own inventory instead.
    process.env = {
      ...originalEnv,
      ...flashEnv,
      LIQUIDATION_FUNDING: undefined,
    } as NodeJS.ProcessEnv;
    const { loadConfig } = await import("./config");
    expect(() => loadConfig()).toThrow(/would be ignored/);
  });

  it("still accepts a plain inventory setup with no flash variables", async () => {
    process.env = { ...originalEnv, ...base };
    const { loadConfig } = await import("./config");
    expect(loadConfig().funding).toEqual({ mode: "inventory" });
  });

  it("requires a WBTC flash-loan venue", async () => {
    // Most liquidations seize a vault worth more than the debt and owe the remainder back as the
    // WBTC fairness payment, so a flash setup without this venue would decline most of its work.
    process.env = {
      ...originalEnv,
      ...flashEnv,
      WBTC_FLASH_LOAN_ADDRESS: undefined,
    } as NodeJS.ProcessEnv;
    const { loadConfig } = await import("./config");
    expect(() => loadConfig()).toThrow(/WBTC_FLASH_LOAN_ADDRESS/);
  });

  it("still rejects RISK_MIN_PROFIT under inventory funding", async () => {
    process.env = { ...originalEnv, ...base, RISK_MIN_PROFIT: "1000" };
    const { loadConfig } = await import("./config");
    expect(() => loadConfig()).toThrow(/RISK_MIN_PROFIT/);
  });
});
