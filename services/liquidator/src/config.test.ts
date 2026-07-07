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

    it("should use default values for optional fields", async () => {
      process.env = { ...validEnv };

      const { loadConfig } = await import("./config");
      const config = loadConfig();

      expect(config.pollingIntervalMs).toBe(12000);
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
