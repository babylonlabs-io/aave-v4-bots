// The `Notifier` port + the events a bot reports. One external seam — an outbound message — and
// nothing else. Adapters (`./slack`) implement this; callers depend only on these types.
//
// Notifications are an **advisory** channel. The durable record is always somewhere else: a
// persisted intent, the risk gate's own state, the logs. Nothing here is load-bearing, which is
// what lets delivery be best-effort (see `index.ts`).

/** Something an operator would want to know about, right now. */
export type NotificationEvent =
  /** MANUAL mode: a transaction is waiting for a human to sign and broadcast it. */
  | {
      kind: "manual-intent";
      intentId: string;
      /** e.g. "liquidation", "vault-acquisition", "approval". */
      action: string;
      /** Position proxy / vault id / token — whatever the action acts on. */
      subject: string;
      /** The contract the proposed tx calls. */
      target: string;
      /**
       * keccak256 of the canonical payload. Carried here **deliberately**: the persisted payload
       * and its hash share one mutable row, so the hash only proves anything when the operator
       * received it out-of-band. This message is that channel — `operator-cli` recomputes the hash
       * from the payload and the operator checks it against the one they read here.
       */
      payloadHash: string;
      /** ms epoch, if the proposal expires. */
      expiresAt?: number;
    }
  /** The gate stopped trading: kill-switch, tripped breaker, or a code-hash mismatch. */
  | { kind: "risk-halted"; reason: string }
  | { kind: "risk-resumed" }
  /** An in-flight intent the chain has not resolved for suspiciously long. */
  | { kind: "intent-stuck"; intentId: string; subject: string; ageMs: number };

export interface Notifier {
  /**
   * Report `event`. Resolves once delivery has been attempted — **not** once an operator has read
   * it. Implementations may throw; callers are not expected to catch, because `createNotifier`
   * already wraps every adapter so a delivery failure can never reach the caller.
   */
  notify(event: NotificationEvent): Promise<void>;
}

/** Severity, used to pick the log level and (for Slack) the message's colour. */
export function severityOf(event: NotificationEvent): "info" | "warn" {
  switch (event.kind) {
    case "risk-halted":
    case "intent-stuck":
      return "warn";
    case "manual-intent":
    case "risk-resumed":
      return "info";
    default: {
      // Exhaustiveness guard — a new event kind must be assigned a severity here, not silently
      // defaulted to `info`.
      const unknown: never = event;
      void unknown;
      return "info";
    }
  }
}

/**
 * One-line human summary. Shared by the log line and the Slack message on purpose: an operator who
 * sees both should not have to reconcile two different wordings of the same event.
 */
export function describeEvent(event: NotificationEvent): string {
  switch (event.kind) {
    case "manual-intent":
      return (
        `Action awaiting signature: ${event.action} on ${event.subject} ` +
        `(target ${event.target}, payload ${event.payloadHash}, intent ${event.intentId})`
      );
    case "risk-halted":
      return `Risk gate HALTED — trading stopped: ${event.reason}`;
    case "risk-resumed":
      return "Risk gate resumed — trading enabled";
    case "intent-stuck":
      return (
        `Intent stuck in flight for ${Math.round(event.ageMs / 1000)}s: ` +
        `${event.subject} (intent ${event.intentId})`
      );
    default: {
      // Exhaustiveness guard — a new event kind must be given a description here.
      const unknown: never = event;
      return `Unknown notification: ${JSON.stringify(unknown)}`;
    }
  }
}
