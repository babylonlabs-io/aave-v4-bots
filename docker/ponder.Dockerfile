# ============================================
# Ponder Indexer (unified) - Multi-stage Dockerfile
# ============================================
# One image for both services. The index mode (liquidation / arbitrage / both) is
# derived at runtime from which addresses the env provides; PONDER_PORT selects the
# port. See services/ponder/README.md.

# Stage 1: Build dependencies
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json ./

# Copy package.json files for the ponder and its workspace deps
COPY packages/abis/package.json ./packages/abis/
COPY packages/logger/package.json ./packages/logger/
COPY packages/secrets/package.json ./packages/secrets/
COPY services/ponder/package.json ./services/ponder/

# Install runtime dependencies for Ponder and every workspace package it
# imports. Without the trailing ellipsis pnpm links @repo/* packages but omits
# their external dependencies, so @repo/secrets cannot load the AWS SDK.
RUN pnpm install --frozen-lockfile --prod --filter @services/ponder...

# Copy ponder source code + config and its workspace deps
COPY packages/abis/ ./packages/abis/
COPY packages/logger/ ./packages/logger/
COPY packages/secrets/ ./packages/secrets/
COPY services/ponder/ ./services/ponder/

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine AS runner

# Upgrade base packages for fixed OpenSSL builds and install wget for the
# healthcheck. Ponder's installed executable is invoked directly, so remove
# npm/Corepack and their unused package-management dependencies.
RUN apk upgrade --no-cache && \
    apk add --no-cache wget=~1.25 && \
    rm -rf /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx \
      /root/.cache/node/corepack

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 ponder

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/ponder ./services/ponder

# Set ownership
RUN chown -R ponder:nodejs /app

USER ponder

WORKDIR /app/services/ponder

# Expose Ponder API port (default; the actual port is set via PONDER_PORT)
EXPOSE 42069

# Mode-agnostic health check (the GraphQL root is served in every mode).
# docker-compose overrides this per instance with a mode-specific endpoint.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider "http://localhost:${PONDER_PORT:-42069}/" || exit 1

# Default command: start production mode without a runtime package manager.
CMD ["sh", "-c", "exec ./node_modules/.bin/ponder start --port \"${PONDER_PORT:-42069}\""]
