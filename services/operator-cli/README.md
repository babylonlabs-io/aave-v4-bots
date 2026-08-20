# @services/operator-cli

The human side of **MANUAL** execution mode. A keyless liquidator/arbitrageur running with
`EXECUTION_MODE=MANUAL` never signs — instead it writes a content-hashed **proposal** (a
`TxIntent`) to the crash-safety store and notifies an operator. This CLI reads that same store,
verifies each proposal against the chain, and lets an operator claim, sign, and broadcast it —
or record a transaction signed externally (e.g. on a hardware wallet or through a Safe).

One command per invocation; it wires the store + chain + operator signer, then dispatches to the
unit-tested operations in `src/operations.ts`.

## Commands

```
operator-cli <command> [id] [flags]
  list [--action <a>]        proposals awaiting an operator
  show <id>                  verify + render a proposal (read-only)
  claim <id>                 claim it (fixes the Safe envelope); prints the hash to sign
  broadcast <id>             claim (if needed) + sign + send + record   [needs keys]
  confirm <id> --tx <hash>   record an externally-signed tx (claim it first) after verifying it matches
  release <id>               revert a claim back to proposed
  fail <id> [--reason <r>]   give up on an intent, reviving its subject
```

`broadcast` needs signing keys in the process (`OPERATOR_KEY_REF`, or `SAFE_OWNER_KEY_REFS` for a
Safe). The fully keyless flow is `claim` → sign the printed hash elsewhere → `confirm --tx <hash>`.

## Custody

`MANUAL_EXECUTOR_KIND` (must match the bot's) selects how proposals are claimed/verified/executed:

- **`eoa`** — a plain account (hardware wallet or a local key). The proposal is the raw tx.
- **`safe`** — a Safe{Wallet} multisig. Claiming fixes the Safe execution envelope (nonce, hashes);
  `broadcast` collects owner signatures and calls `execTransaction`.

## Recovering a claim with no transaction hash

A row left `claimed` with no `txHash` usually means nobody sent anything — but not always. If
`broadcast` was interrupted between putting the transaction on the wire and recording its hash,
the action is live on chain and nothing in the store points at it.

**Check before you `release`.** Releasing returns the row to `proposed`, from which it can be
claimed and broadcast again — a second transaction for an action that may already be executing.

1. Look at `MANUAL_EXECUTOR_ADDRESS` on a block explorer for a recent transaction to the proposal's
   target (`show <id>` prints it).
2. If there is one, record it: `confirm <id> --tx <hash>`. That is the right command here; it
   verifies the transaction matches the payload before it accepts it.
3. Only if there is none, `release <id>`.

Under `safe` custody the CLI does this for you — `release` scans the Safe for the reserved
`safeTxHash` and refuses if it already executed. Under `eoa` custody it cannot: a plain transaction
has no identifier until it is signed, so there is nothing to have reserved and scan for. Comparing
the account nonce instead would not answer the question, because the same wallet signs the
operator's other transactions.

The exposure if this is got wrong is smaller than it sounds: a re-broadcast action whose subject is
already gone reverts (`PositionNotLiquidatable`, or a vault that has left escrow), so the cost is
gas rather than a second execution. A liquidation that was only *partial* the first time is the
exception — the position is still unhealthy, so a second one can execute. The adapter caps each
repayment at the debt actually outstanding and refunds unspent inputs, so it is a real liquidation
rather than a double spend, but it is one nobody asked for.

## Configuration

Set the same store and custody the bot uses. Secrets are resolved as *references* via `@repo/secrets`
(never inline keys); with `SECRETS_PROVIDER=env` a ref names another env var, with `=aws` it is a
Secrets Manager id.

| Variable | Required | Description |
| --- | --- | --- |
| `CLIENT_RPC_URL` | yes | RPC endpoint (verification + broadcast) |
| `DATABASE_URL` | yes | Postgres store the bot wrote proposals to (must be the same DB) |
| `PERSISTENCE_SCHEMA` | no | schema isolating the bot's tables (default `bot`) |
| `MANUAL_EXECUTOR_ADDRESS` | yes | the address the operator signs as (the Safe itself, in `safe` custody) |
| `MANUAL_EXECUTOR_KIND` | yes | `eoa` or `safe` (must match the bot) |
| `OPERATOR_KEY_REF` | for `broadcast` | ref to the EOA / Safe-owner key; omit for the keyless `confirm` flow |
| `SAFE_OWNER_KEY_REFS` | `safe` broadcast | comma-separated owner key refs |

| `SECRETS_PROVIDER` | no | `env` (default) or `aws` |
| `AWS_REGION` | no | region for AWS Secrets Manager |

## Run

```bash
pnpm --filter @services/operator-cli operator-cli list
pnpm --filter @services/operator-cli operator-cli show <id>
pnpm --filter @services/operator-cli operator-cli broadcast <id>
```

The e2e suites `manual-arbitrageur` and `manual-safe-arbitrageur` drive this CLI end to end (see
`scripts/e2e-local.sh` and `test/e2e/scripts/operator-confirm.sh`).
