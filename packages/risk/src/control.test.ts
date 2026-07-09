import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { createControlRoutes, resolveControlToken } from "./control";
import { createRiskGate } from "./gate";

const TOKEN = "s3cret-token";

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(body?: string) {
      res.body = body ?? "";
    },
  };
  return res as unknown as ServerResponse & typeof res;
}

const req = (method: string, url: string, token?: string) =>
  ({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as IncomingMessage;

const call = (
  method: string,
  pathname: string,
  opts: { token?: string; reason?: string; rawUrl?: string } = {}
) => {
  const gate = createRiskGate();
  const res = fakeRes();
  const params = new URLSearchParams(opts.reason ? { reason: opts.reason } : {});
  const route = createControlRoutes({ gate, token: TOKEN });
  // The server passes the *normalized* pathname; `rawUrl` is what the client literally sent.
  const rawUrl = opts.rawUrl ?? (opts.reason ? `${pathname}?reason=${opts.reason}` : pathname);
  const handled = route(req(method, rawUrl, opts.token), res, pathname, params);
  return { gate, res, handled, body: res.body ? JSON.parse(res.body) : undefined };
};

describe("@repo/risk kill-switch control routes", () => {
  it("does not claim non-control paths", () => {
    expect(call("GET", "/metrics").handled).toBe(false);
    expect(call("GET", "/health").handled).toBe(false);
  });

  describe("authentication", () => {
    it("rejects a missing token with 401 and does not halt", () => {
      const { res, gate, handled } = call("POST", "/halt");
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(gate.state()).toBe("RUNNING");
    });

    it("rejects a wrong token of the same length", () => {
      const wrong = "x".repeat(TOKEN.length);
      const { res, gate } = call("POST", "/halt", { token: wrong });
      expect(res.statusCode).toBe(401);
      expect(gate.state()).toBe("RUNNING");
    });

    it("rejects a token that is a prefix of the real one", () => {
      expect(call("POST", "/halt", { token: TOKEN.slice(0, -1) }).res.statusCode).toBe(401);
    });

    it("rejects a non-Bearer authorization header", () => {
      const gate = createRiskGate();
      const res = fakeRes();
      const raw = {
        method: "POST",
        url: "/halt",
        headers: { authorization: TOKEN },
      } as unknown as IncomingMessage;
      createControlRoutes({ gate, token: TOKEN })(raw, res, "/halt", new URLSearchParams());
      expect(res.statusCode).toBe(401);
    });

    it("never echoes the supplied token in the response", () => {
      const { res } = call("POST", "/halt", { token: "guess-me" });
      expect(res.body).not.toContain("guess-me");
      expect(res.body).not.toContain(TOKEN);
    });
  });

  // WHATWG URL collapses dot segments, so `/foo/../halt` reaches the router as `/halt`. Bearer
  // auth still applies, but a reverse proxy ACL on the literal `/halt` would forward these — so
  // only serve a control route when the client asked for it literally.
  describe("path normalization", () => {
    it.each(["/foo/../halt", "/%2e%2e/halt", "/./halt"])(
      "does not claim %s even though it normalizes to /halt",
      (rawUrl) => {
        const { handled, gate } = call("POST", "/halt", { token: TOKEN, rawUrl });
        expect(handled).toBe(false);
        expect(gate.state()).toBe("RUNNING");
      }
    );

    it("still serves the literal path with a query string", () => {
      const { handled, gate } = call("POST", "/halt", {
        token: TOKEN,
        rawUrl: "/halt?reason=incident",
      });
      expect(handled).toBe(true);
      expect(gate.state()).toBe("HALTED");
    });
  });

  describe("method enforcement", () => {
    // A GET /halt would let a preloaded link or an <img> tag stop the bot.
    it("rejects GET /halt with 405 and does not halt", () => {
      const { res, gate } = call("GET", "/halt", { token: TOKEN });
      expect(res.statusCode).toBe(405);
      expect(gate.state()).toBe("RUNNING");
    });

    it("rejects POST /status with 405", () => {
      expect(call("POST", "/status", { token: TOKEN }).res.statusCode).toBe(405);
    });
  });

  describe("actions", () => {
    it("POST /halt trips the kill-switch and reports the reason", () => {
      const { res, gate, body } = call("POST", "/halt", { token: TOKEN, reason: "oracle drift" });
      expect(res.statusCode).toBe(200);
      expect(gate.state()).toBe("HALTED");
      expect(body).toEqual({ state: "HALTED", reason: "oracle drift" });
    });

    it("POST /halt defaults the reason when none is given", () => {
      expect(call("POST", "/halt", { token: TOKEN }).body.reason).toBe(
        "manual halt via control endpoint"
      );
    });

    it("POST /resume clears the kill-switch", () => {
      const gate = createRiskGate();
      gate.halt("earlier");
      const res = fakeRes();
      createControlRoutes({ gate, token: TOKEN })(
        req("POST", "/resume", TOKEN),
        res,
        "/resume",
        new URLSearchParams()
      );
      expect(res.statusCode).toBe(200);
      expect(gate.state()).toBe("RUNNING");
    });

    it("GET /status reports state and live exposure", () => {
      expect(call("GET", "/status", { token: TOKEN }).body).toEqual({
        state: "RUNNING",
        inFlight: 0,
      });
    });

    it("emits an audit event for halt, resume and rejection", () => {
      const events: string[] = [];
      const gate = createRiskGate();
      const route = createControlRoutes({ gate, token: TOKEN, onEvent: (m) => events.push(m) });
      const params = new URLSearchParams();

      route(req("POST", "/halt", "wrong-token"), fakeRes(), "/halt", params);
      route(req("POST", "/halt", TOKEN), fakeRes(), "/halt", params);
      route(req("POST", "/resume", TOKEN), fakeRes(), "/resume", params);

      expect(events[0]).toContain("Rejected unauthenticated");
      expect(events[1]).toContain("HALTED");
      expect(events[2]).toContain("RESUMED");
      expect(events.join(" ")).not.toContain(TOKEN); // the audit log is not an oracle either
    });
  });
});

describe("resolveControlToken", () => {
  it("returns undefined when no ref is configured (kill switch unmounted)", async () => {
    expect(await resolveControlToken(undefined, async () => "x")).toBeUndefined();
  });

  it("resolves the ref through the secrets provider", async () => {
    expect(await resolveControlToken("MY_REF", async (ref) => `value-of-${ref}`)).toBe(
      "value-of-MY_REF"
    );
  });

  // Fail closed: an empty token would authenticate every request.
  it("throws when the secret resolves empty", async () => {
    await expect(resolveControlToken("MY_REF", async () => "")).rejects.toThrow("empty token");
  });
});
