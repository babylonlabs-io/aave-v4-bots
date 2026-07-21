import type { Logger } from "@repo/logger";

import { type SlackConfig, createSlackNotifier } from "./slack";
import { type NotificationEvent, type Notifier, describeEvent, severityOf } from "./types";

// `@repo/notifications` — the outbound-alert seam: the `Notifier` port (`./types`), the `./slack`
// adapter, and the composition-root selector below. It depends on `@repo/logger` and `fetch`, and
// nothing else depends on it except composition roots.

export {
  type NotificationEvent,
  type Notifier,
  describeEvent,
  severityOf,
} from "./types";
export { type SlackConfig, createSlackNotifier } from "./slack";

/** The notification backends a service can select at boot. */
export const NOTIFIERS = ["none", "slack"] as const;
export type NotifierSource = (typeof NOTIFIERS)[number];

export interface NotifierConfig {
  /** Which backend delivers events. Defaults to `none` at the config layer. */
  source: NotifierSource;
  /** The resolved webhook URL (only used by `slack`) — a secret value, not a reference. */
  webhookUrl?: string;
  /** Every event is logged through this, whatever the backend. */
  logger: Logger;
  /** Passed through to the Slack adapter. */
  slack?: Omit<SlackConfig, "webhookUrl">;
}

/** What a service's config projects to (from `@repo/config`'s `buildNotifierConfig`). */
export interface NotifierSettings {
  source: NotifierSource;
  /** Secret reference for the webhook URL (only for `slack`). */
  webhookRef?: string;
}

/**
 * Composition-root helper: resolve `settings` into a live `Notifier`, pulling the Slack webhook out
 * of the secrets provider exactly as the signing key and the kill-switch token are resolved. Both
 * services do this identically, so it lives here rather than in each `index.ts`.
 */
export async function buildNotifier(
  settings: NotifierSettings,
  logger: Logger,
  getSecret: (ref: string) => Promise<string>
): Promise<Notifier> {
  const webhookUrl =
    settings.source === "slack" && settings.webhookRef
      ? await getSecret(settings.webhookRef)
      : undefined;
  return createNotifier({ source: settings.source, webhookUrl, logger });
}

/**
 * Build the `Notifier` a service's config asks for, wrapped so that **the log is the guaranteed
 * channel and delivery is best effort**.
 *
 * Two properties, and both are the point:
 *
 * - **Log first, then deliver.** An event that reaches nobody's Slack is still in the journal. This
 *   is what lets an unconfigured deployment (`none`) be a real, supported configuration rather than
 *   a blind one.
 * - **A delivery failure never reaches the caller.** `notify` is called from the middle of a poll
 *   cycle, next to code that moves money; Slack being down must not fail a liquidation or abort a
 *   reconcile. The durable record always lives elsewhere (a persisted intent, the gate's own state),
 *   so a dropped message costs an operator a glance at the queue — never correctness.
 *
 * That is the exact inverse of `markPending`, which *must* throw: there the record is the safety
 * property. Here it is a courtesy.
 */
export function createNotifier(config: NotifierConfig): Notifier {
  const delivery = selectAdapter(config);
  const { logger } = config;

  return {
    async notify(event: NotificationEvent): Promise<void> {
      // The whole body is guarded, not just delivery: `notify` is awaited from inside a poll cycle,
      // so nothing here — not even a misbehaving `logger` or a throw before `delivery` is reached —
      // may reject and fail the cycle. The one thing that must always happen (the log) is attempted
      // first; if even that throws, there is nowhere left to report it, so it dies here.
      try {
        const summary = describeEvent(event);
        if (severityOf(event) === "warn") logger.warn(summary);
        else logger.info(summary);

        if (delivery) await delivery.notify(event);
      } catch (error) {
        try {
          logger.error(`Failed to deliver notification (${event.kind}):`, error);
        } catch {
          // The logger itself is broken; swallow rather than reject an awaiting caller.
        }
      }
    },
  };
}

/** `undefined` ⇒ log-only. */
function selectAdapter(config: NotifierConfig): Notifier | undefined {
  switch (config.source) {
    case "none":
      return undefined;
    case "slack": {
      if (!config.webhookUrl) {
        // Fail at boot, not at the first alert: a bot that thinks it is alerting and is not is
        // worse than one that never claimed to.
        throw new Error("notifier source is 'slack' but no webhook URL was resolved");
      }
      return createSlackNotifier({ ...config.slack, webhookUrl: config.webhookUrl });
    }
    default: {
      // Exhaustiveness guard — unreachable once `source` is a validated enum.
      const unknown: never = config.source;
      throw new Error(`unknown notifier source: ${String(unknown)}`);
    }
  }
}

/**
 * Adapt a `Notifier` to `@repo/risk`'s `onEvent` sink.
 *
 * The indirection is deliberate: `@repo/risk` must not depend on this package (it stays
 * dependency-free, taking plain callbacks — the same reason it takes `read: CodeHashReader` rather
 * than importing `@repo/chain`). So the gate emits a bare event and the composition root maps it,
 * here, structurally. Neither package learns the other exists.
 *
 * Fire-and-forget: the gate calls this synchronously from `halt()`, which must not become async.
 * A `createNotifier` notifier already swallows delivery failures, but this attaches its own
 * `.catch()` regardless — the sink must be safe with *any* `Notifier`, so a rejecting one can never
 * surface as an unhandled rejection out of a synchronous `halt()`.
 */
export function riskEventSink(
  notifier: Notifier
): (event: { kind: "halted"; reason: string } | { kind: "resumed" }) => void {
  return (event) => {
    notifier
      .notify(
        event.kind === "halted"
          ? { kind: "risk-halted", reason: event.reason }
          : { kind: "risk-resumed" }
      )
      .catch(() => {
        // Unreachable for a `createNotifier` notifier (it never rejects); the guard is for any
        // other `Notifier` implementation, so a synchronous `halt()` can never leak a rejection.
      });
  };
}
