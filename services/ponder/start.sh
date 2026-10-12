#!/bin/sh
# Starts the indexer in production mode. scripts/indexerSchema.mjs keeps DATABASE_SCHEMA when it is
# set and derives one from the build and its config when it is not, so a new build or a new
# contract address re-syncs into a fresh schema instead of failing on the old one.
set -eu
cd "$(dirname "$0")"
DATABASE_SCHEMA=$(node scripts/indexerSchema.mjs)
export DATABASE_SCHEMA
exec node_modules/.bin/ponder start --port "${PONDER_PORT:-42069}"
