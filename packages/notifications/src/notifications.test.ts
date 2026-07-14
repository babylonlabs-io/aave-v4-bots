import type { Logger } from "@repo/logger";
import { describe, expect, it, vi } from "vitest";

import {
  type NotificationEvent,
  type NotifierSettings,
  buildNotifier,
  createNotifier,
  createSlackNotifier,
  describeEvent,
  riskEventSink,
  severityOf,
} from "./index";

const HALTED: NotificationEvent = { kind: "risk-halted", reason: "breaker tripped" };
const RESUMED: NotificationEvent = { kind: "risk-resumed" };
const MANUAL: NotificationEvent = {
  kind: "manual-intent",
  intentId: "id-1",
  action: "liquidation",
  subject: "0xborrower",
  target: "0xadapter",
  payloadHash: "0xdeadbeef",
};

function fakeLogger(): Logger & { infos: string[]; warns: string[]; errors: unknown[][] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: unknown[][] = [];
  return {
    infos,
    warns,
    errors,
    debug: vi.fn(),
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
    error: (...a: unknown[]) => errors.push(a),
  };
}

describe("createNotifier", () => {
  it("logs every event even with no delivery backend (`none`)", async () => {
    const logger = fakeLogger();
    const notifier = createNotifier({ source: "none", logger });

    await notifier.notify(MANUAL);
    await notifier.notify(HALTED);

    // The log is the guaranteed channel — an unconfigured deployment is not a blind one.
    expect(logger.infos).toContain(describeEvent(MANUAL));
    expect(logger.warns).toContain(describeEvent(HALTED));
  });

  it("logs at the event's severity", async () => {
    const logger = fakeLogger();
    const notifier = createNotifier({ source: "none", logger });

    await notifier.notify(RESUMED); // info
    await notifier.notify(HALTED); // warn

    expect(logger.infos).toContain(describeEvent(RESUMED));
    expect(logger.warns).toContain(describeEvent(HALTED));
    expect(logger.warns).not.toContain(describeEvent(RESUMED));
  });

  it("delivers to the backend after logging", async () => {
    const logger = fakeLogger();
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = createNotifier({
      source: "slack",
      webhookUrl: "https://hooks.example/x",
      logger,
      slack: { fetch: fetchStub },
    });

    await notifier.notify(MANUAL);

    expect(logger.infos).toContain(describeEvent(MANUAL)); // logged...
    expect(fetchStub).toHaveBeenCalledOnce(); // ...and delivered
  });

  it("NEVER propagates a delivery failure — a dropped alert must not break a poll cycle", async () => {
    const logger = fakeLogger();
    const fetchStub = vi.fn(async () => {
      throw new Error("network down");
    });
    const notifier = createNotifier({
      source: "slack",
      webhookUrl: "https://hooks.example/x",
      logger,
      slack: { fetch: fetchStub },
    });

    // The whole point: this resolves, it does not reject.
    await expect(notifier.notify(HALTED)).resolves.toBeUndefined();
    // ...and the failure is logged, not swallowed silently.
    expect(logger.errors.length).toBe(1);
  });

  it("rejects `slack` with no resolved webhook at build time, not at first alert", () => {
    const logger = fakeLogger();
    expect(() => createNotifier({ source: "slack", logger })).toThrow(/no webhook URL/);
  });

  it("does not reject even if the logger itself throws", async () => {
    // `notify` is awaited inside a poll cycle, so a broken logger must not be able to fail it — the
    // whole body is guarded, not just delivery.
    const brokenLogger = {
      debug: vi.fn(),
      info: () => {
        throw new Error("logger exploded");
      },
      warn: () => {
        throw new Error("logger exploded");
      },
      error: vi.fn(),
    } as unknown as Logger;
    const notifier = createNotifier({ source: "none", logger: brokenLogger });

    await expect(notifier.notify(MANUAL)).resolves.toBeUndefined();
  });
});

describe("createSlackNotifier", () => {
  it("posts a formatted message and resolves on 2xx", async () => {
    let captured: { url: unknown; init: RequestInit | undefined } | undefined;
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url, init };
      return new Response(null, { status: 200 });
    });
    const slack = createSlackNotifier({ webhookUrl: "https://hooks.example/x", fetch: fetchStub });

    await slack.notify(MANUAL);

    expect(captured?.url).toBe("https://hooks.example/x");
    const body = JSON.parse(captured?.init?.body as string);
    expect(body.text).toBe(describeEvent(MANUAL));
    // The payload hash MUST reach the operator here — it is the out-of-band channel that makes the
    // hash tamper-evident (the operator checks it against what operator-cli recomputes).
    expect(JSON.stringify(body)).toContain("0xdeadbeef");
  });

  it("throws on a non-2xx webhook response", async () => {
    const fetchStub = vi.fn(async () => new Response("invalid_token", { status: 403 }));
    const slack = createSlackNotifier({ webhookUrl: "https://hooks.example/x", fetch: fetchStub });

    await expect(slack.notify(HALTED)).rejects.toThrow(/403/);
  });
});

describe("buildNotifier", () => {
  it("resolves the slack webhook from its secret reference", async () => {
    const logger = fakeLogger();
    const getSecret = vi.fn(async () => "https://hooks.example/resolved");
    const settings: NotifierSettings = { source: "slack", webhookRef: "SLACK_WEBHOOK_URL" };

    // Building the notifier resolves the ref. We do NOT call `notify` here — `buildNotifier` wires
    // a real Slack adapter (no fetch seam), so a `notify` would attempt real network I/O. The Slack
    // adapter's own tests cover delivery with an injected fetch; here we only assert resolution.
    const notifier = await buildNotifier(settings, logger, getSecret);

    // The webhook is pulled from the secrets provider by reference — never a plaintext config field.
    expect(getSecret).toHaveBeenCalledWith("SLACK_WEBHOOK_URL");
    expect(notifier).toBeDefined();
  });

  it("builds a log-only notifier for `none` and resolves no secret", async () => {
    const logger = fakeLogger();
    const getSecret = vi.fn();
    const notifier = await buildNotifier({ source: "none" }, logger, getSecret);

    await notifier.notify(HALTED);

    expect(getSecret).not.toHaveBeenCalled();
    expect(logger.warns).toContain(describeEvent(HALTED));
  });
});

describe("riskEventSink", () => {
  it("maps the gate's halt/resume events onto notifications", () => {
    const events: NotificationEvent[] = [];
    const notifier = { notify: async (e: NotificationEvent) => void events.push(e) };
    const sink = riskEventSink(notifier);

    sink({ kind: "halted", reason: "boom" });
    sink({ kind: "resumed" });

    expect(events).toEqual([{ kind: "risk-halted", reason: "boom" }, { kind: "risk-resumed" }]);
  });

  it("does not throw even if the notifier rejects (fire-and-forget from a sync halt)", () => {
    const notifier = {
      notify: async () => {
        throw new Error("should be swallowed");
      },
    };
    const sink = riskEventSink(notifier);
    // The gate calls this synchronously from halt(); it must not throw and must not leave an
    // unhandled rejection (notify already swallows, so the promise resolves).
    expect(() => sink({ kind: "halted", reason: "x" })).not.toThrow();
  });
});

describe("severityOf", () => {
  it("flags halts and stuck intents as warnings, the rest as info", () => {
    expect(severityOf(HALTED)).toBe("warn");
    expect(severityOf({ kind: "intent-stuck", intentId: "i", subject: "s", ageMs: 1 })).toBe(
      "warn"
    );
    expect(severityOf(RESUMED)).toBe("info");
    expect(severityOf(MANUAL)).toBe("info");
  });
});
