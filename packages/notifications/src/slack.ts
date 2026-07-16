import { type NotificationEvent, type Notifier, describeEvent, severityOf } from "./types";

// Slack incoming-webhook adapter. A pure transport: it formats, it posts, and it throws on failure.
// The log-always / never-throw-at-the-caller discipline lives in `createNotifier` (see `index.ts`),
// so every adapter gets it identically and none of them has to remember it.

export interface SlackConfig {
  /**
   * Incoming-webhook URL — a **credential**, not a setting: anyone holding it can post as the bot.
   * Services resolve it from a secret *reference* through `@repo/secrets`, exactly as they resolve
   * the signing key and the kill-switch token; it is never a plain config field.
   */
  webhookUrl: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Abandon a post that has not completed in this long. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Slack renders these as the colour stripe beside the message. */
const COLOR = { info: "#2eb886", warn: "#daa038" } as const;

export function createSlackNotifier(config: SlackConfig): Notifier {
  const post = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async notify(event: NotificationEvent): Promise<void> {
      // A hung webhook must not stall a poll cycle — even though the caller cannot see this throw,
      // it still awaits it. The timeout bounds how long "best effort" can take.
      const response = await post(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackMessage(event)),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        // Slack answers a bad webhook with 4xx and a plain-text body ("invalid_token", …). Surface
        // it: `createNotifier` logs it, and a silently-dropped alert is worse than a noisy one.
        throw new Error(`Slack webhook failed: ${response.status} ${await safeText(response)}`);
      }
    },
  };
}

/**
 * The message body. `text` is set alongside the attachment so Slack has something to show in a
 * notification preview and in clients that do not render attachments.
 */
function slackMessage(event: NotificationEvent) {
  const summary = describeEvent(event);
  return {
    text: summary,
    attachments: [{ color: COLOR[severityOf(event)], text: summary, fields: fieldsOf(event) }],
  };
}

function fieldsOf(
  event: NotificationEvent
): Array<{ title: string; value: string; short: boolean }> {
  switch (event.kind) {
    case "manual-intent":
      return [
        { title: "Action", value: event.action, short: true },
        { title: "Subject", value: event.subject, short: true },
        { title: "Target", value: event.target, short: true },
        // The reason this event exists in Slack at all: the operator verifies the hash they see
        // HERE against the one `operator-cli` recomputes from the persisted payload.
        { title: "Payload hash", value: event.payloadHash, short: false },
        ...(event.expiresAt === undefined
          ? []
          : [{ title: "Expires", value: new Date(event.expiresAt).toISOString(), short: true }]),
      ];
    case "intent-stuck":
      return [
        { title: "Subject", value: event.subject, short: true },
        { title: "Age", value: `${Math.round(event.ageMs / 1000)}s`, short: true },
      ];
    // `risk-halted` / `risk-resumed` carry their whole story in the summary line — no extra fields.
    case "risk-halted":
    case "risk-resumed":
      return [];
    default: {
      // Exhaustiveness guard — a new event kind must decide its fields here, not silently render
      // with none.
      const unknown: never = event;
      void unknown;
      return [];
    }
  }
}

/** Reading the body must never be what fails the error path. */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}
