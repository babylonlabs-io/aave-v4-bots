import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";

describe("createLogger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.stubEnv("LOG_LEVEL", ""); // treated as unset -> defaults to info
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prefixes every message and forwards extra args", () => {
    const log = createLogger({ prefix: "[Bot] " });
    const err = new Error("boom");
    log.info("started", 1, 2);
    log.error("failed", err);

    expect(console.log).toHaveBeenCalledWith("[Bot] started", 1, 2);
    expect(console.error).toHaveBeenCalledWith("[Bot] failed", err);
  });

  it("maps info to console.log and the rest to their console method", () => {
    const log = createLogger({ level: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(console.debug).toHaveBeenCalledWith("d");
    expect(console.log).toHaveBeenCalledWith("i");
    expect(console.warn).toHaveBeenCalledWith("w");
    expect(console.error).toHaveBeenCalledWith("e");
  });

  it("drops messages below the configured level", () => {
    const log = createLogger({ level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("w");
  });

  it("defaults to info level (debug suppressed) when nothing is configured", () => {
    const log = createLogger();
    log.debug("d");
    log.info("i");

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("i");
  });

  it("honors the LOG_LEVEL env var", () => {
    vi.stubEnv("LOG_LEVEL", "error");
    const log = createLogger();
    log.warn("w");
    log.error("e");

    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("e");
  });
});
