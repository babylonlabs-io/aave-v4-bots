# @services/ponder

Unified Ponder indexer for both the liquidator and arbitrageur.

Index modes are derived from which addresses are configured (`src/flags.ts`):

- **Liquidation** — set `ADAPTER_ADDRESS` + `SPOKE_ADDRESS` (indexes `Spoke` +
  `Adapter`; serves `/liquidatable-positions`, `/positions`).
- **Arbitrage** — set `VAULT_SWAP_ADDRESS` (indexes `VaultSwap`; serves
  `/escrowed-vaults`, `/escrowed-vaults-raw`).

Set one, the other, or both. At least one is required. Operators can run a single
shared instance (both modes) or one instance per service (only that service's
addresses); `PONDER_PORT` selects the port.

## Database authentication

`DB_AUTH` selects how Ponder's connections to `DATABASE_URL` authenticate:

- `password` (default): the password is part of `DATABASE_URL`.
- `iam`: Amazon RDS IAM database authentication. `DATABASE_URL` carries no
  password; every new connection presents a 15-minute token minted locally with
  the process's AWS credentials (on EKS the ServiceAccount's IAM role, allowed
  `rds-db:connect` as this database user). Checked at boot: no password in the
  URL and no `PGPASSWORD` in the environment (either would override the token);
  no `NODE_TLS_REJECT_UNAUTHORIZED=0` (it turns off the certificate check and
  the token would reach an unverified server); a port in the URL whenever
  `PGPORT` is set (the driver takes the port from `PGPORT` when the URL has
  none, and the token is signed for one port);
  `sslmode=verify-full&sslrootcert=<path>` pointing at
  `certs/rds-global-bundle.pem` (`/app/services/ponder/certs/rds-global-bundle.pem`
  in the image); AWS credentials and a region the SDK can resolve (`AWS_REGION`).
  One token is minted at boot so a missing role, region or credential fails the
  start rather than the first query. The hook is installed from
  `ponder.config.ts`; `src/dbAuth.ts` explains why it has to be a driver default.
