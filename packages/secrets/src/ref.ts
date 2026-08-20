// What a secret *ref* may look like, and what an error is allowed to say about one.
//
// A ref names a secret; it is never the secret. That distinction is one environment variable apart
// — `SIGNER_KEY_REF=BOT_KEY` sits directly above `BOT_KEY=0x…` in every example file — so putting
// the value where the name belongs is an ordinary copy-paste error rather than an exotic one. When
// it happens the lookup fails and the ref travels into the error, the fatal boot log, and from
// there into whatever aggregates logs. Logs are replicated and retained far more widely than a
// process environment, which is the whole of the harm.

/**
 * Refs this module is willing to repeat back.
 *
 * Deliberately narrow: an environment-variable name, an AWS secret name, or a path-style id like
 * `prod/bot/signer`. Nothing here can be a private key (`0x` + hex fails the leading character), a
 * webhook URL (`:` and `/` in that combination fail), or a long opaque token (the length bound).
 * Anything outside it is treated as material, whatever it actually is.
 */
const SAFE_REF = /^[A-Za-z_][A-Za-z0-9_./+=@-]{0,127}$/;

/** A private key or a URL, spelled where a name was expected. Rejected before any lookup. */
const OBVIOUS_SECRET = [/^0x[0-9a-fA-F]{40,}$/, /:\/\//];

export function isSafeToEcho(ref: string): boolean {
  return SAFE_REF.test(ref) && !OBVIOUS_SECRET.some((re) => re.test(ref));
}

/**
 * How a ref may appear in an error: itself when it is plainly a name, otherwise its length alone.
 *
 * The length is enough for an operator to recognise what they did — 66 characters is a private key,
 * and they will know it — without the message carrying the value into a log.
 */
export function describeRef(ref: string): string {
  return isSafeToEcho(ref) ? `"${ref}"` : `<redacted, ${ref.length} chars>`;
}

/**
 * Refuse a ref that looks like the secret it was supposed to name, before anything is done with it.
 *
 * Checked ahead of the lookup rather than when the lookup fails, because on the AWS path the ref
 * becomes the `SecretId` of a `GetSecretValue` call — a request that is itself logged, in
 * CloudTrail, outside anything this process can redact. Not sending it is the only way to keep it
 * out of there.
 *
 * @param label The configuration field the ref came from (`SIGNER_KEY_REF`, …). Always safe to
 *        print, and the thing the operator has to go and fix.
 */
export function assertUsableRef(ref: string, label: string): void {
  if (isSafeToEcho(ref)) return;
  throw new Error(
    `${label} is not the name of a secret (${describeRef(ref)}) — it looks like a secret value. Set it to the NAME of the environment variable or AWS secret that holds the value, not to the value itself.`
  );
}
