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
