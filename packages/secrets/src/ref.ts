// What a secret *ref* may look like, and what an error is allowed to say about one.
//
// A ref names a secret; it is never the secret. That distinction is one environment variable apart
// — `SIGNER_KEY_REF=BOT_KEY` sits directly above `BOT_KEY=0x…` in every example file — so putting
// the value where the name belongs is an ordinary copy-paste error rather than an exotic one. When
// it happens the lookup fails and the ref travels into the error, the fatal boot log, and from
// there into whatever aggregates logs. Logs are replicated and retained far more widely than a
// process environment, which is the whole of the harm.

/**
 * Characters a secret name can use: an environment-variable name, an AWS secret name, or a
 * path-style id like `prod/bot/signer`, up to 128 characters.
 */
const REF_CHARS = /^[A-Za-z_][A-Za-z0-9_./+=@-]{0,127}$/;

/** A Secrets Manager ARN, which carries `:` that `REF_CHARS` does not allow. */
const SECRET_ARN =
  /^arn:aws(-[a-z]+)*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;

/**
 * Shapes that are secrets, not names: a hex key or token (with or without `0x`) and a JWT. A
 * random token of another shape still passes; `describeRef` never echoes a ref, so the only
 * exposure left for it is an AWS lookup.
 */
const SECRET_SHAPES = [/^(0x)?[0-9a-fA-F]{32,}$/, /^eyJ[\w-]*\.[\w-]*\./];

/** Can this be the name of a secret, as opposed to the secret itself? */
export function isUsableRef(ref: string): boolean {
  return (REF_CHARS.test(ref) || SECRET_ARN.test(ref)) && !SECRET_SHAPES.some((re) => re.test(ref));
}

/**
 * How a ref may appear in an error: its length only, never its text. A ref that passes
 * `isUsableRef` can still be a secret of an unlisted shape, and the setting's label already tells
 * the operator what to fix.
 */
export function describeRef(ref: string): string {
  return `<${ref.length} chars>`;
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
  if (isUsableRef(ref)) return;
  throw new Error(
    `${label} is not the name of a secret (${describeRef(ref)}) — it looks like a secret value. Set it to the NAME of the environment variable or AWS secret that holds the value, not to the value itself.`
  );
}
