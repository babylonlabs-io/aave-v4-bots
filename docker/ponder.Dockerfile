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
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy package.json files for the ponder and its workspace deps
COPY packages/abis/package.json ./packages/abis/
COPY services/ponder/package.json ./services/ponder/

# Install dependencies (workspace-aware)
RUN pnpm install --frozen-lockfile --filter @services/ponder

# Copy ponder source code + config and its workspace deps
COPY packages/abis/ ./packages/abis/
COPY services/ponder/ ./services/ponder/

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine AS runner

# Install pnpm for running ponder and wget for healthchecks
RUN apk add --no-cache wget=~1.25 && \
    corepack enable && corepack prepare pnpm@9.13.2 --activate

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 ponder

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/pnpm-workspace.yaml ./
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

# Default command: start production mode
CMD ["pnpm", "start"]
