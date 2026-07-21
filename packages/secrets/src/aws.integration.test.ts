import { describe, expect, it } from "vitest";
import { createAwsSecrets } from "./aws";

// Opt-in integration test that hits **real AWS Secrets Manager** (the unit test in
// `aws.test.ts` uses a mock). It runs only when a real secret is configured; otherwise the
// whole block is skipped, so `pnpm test` stays offline by default.
//
// To run against a real secret:
//   export SECRETS_E2E_SECRET_ID=prod/example/secret   # a Secrets Manager name or ARN
//   export SECRETS_E2E_EXPECTED=the-expected-value      # (optional) exact-match assertion
//   export AWS_REGION=us-east-1                          # (or rely on SDK resolution)
//   # plus AWS credentials the SDK can find (env / profile / instance role)
//   pnpm --filter @repo/secrets test aws.integration

const SECRET_ID = process.env.SECRETS_E2E_SECRET_ID;
const EXPECTED = process.env.SECRETS_E2E_EXPECTED;
const REGION = process.env.AWS_REGION;
const TIMEOUT = 30_000;

describe.runIf(!!SECRET_ID)("createAwsSecrets (integration — real AWS Secrets Manager)", () => {
  it(
    "resolves the secret to a non-empty value",
    async () => {
      const secrets = createAwsSecrets({ region: REGION });
      const value = await secrets.get(SECRET_ID as string);

      expect(value.length).toBeGreaterThan(0);
      if (EXPECTED !== undefined) expect(value).toBe(EXPECTED);
    },
    TIMEOUT
  );

  it(
    "wraps a not-found error with the ref (never the value)",
    async () => {
      const secrets = createAwsSecrets({ region: REGION });
      const missing = `does-not-exist-${Date.now()}`;
      await expect(secrets.get(missing)).rejects.toThrow(
        new RegExp(`failed to fetch secret "${missing}"`)
      );
    },
    TIMEOUT
  );
});
