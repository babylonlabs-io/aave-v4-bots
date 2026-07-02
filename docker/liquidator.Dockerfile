# ============================================
# Liquidator - Multi-stage Dockerfile
# ============================================

# Stage 1: Build dependencies
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy package.json files for all required workspace packages
COPY packages/abis/package.json ./packages/abis/
COPY packages/capital/package.json ./packages/capital/
COPY packages/chain/package.json ./packages/chain/
COPY packages/config/package.json ./packages/config/
COPY packages/domain/package.json ./packages/domain/
COPY packages/engine/package.json ./packages/engine/
COPY packages/execution/package.json ./packages/execution/
COPY packages/logger/package.json ./packages/logger/
COPY packages/metrics/package.json ./packages/metrics/
COPY packages/observability/package.json ./packages/observability/
COPY services/liquidator/package.json ./services/liquidator/

# Install dependencies (workspace-aware)
RUN pnpm install --frozen-lockfile --filter @services/liquidator...

# Copy source code
COPY packages/abis/ ./packages/abis/
COPY packages/capital/ ./packages/capital/
COPY packages/chain/ ./packages/chain/
COPY packages/config/ ./packages/config/
COPY packages/domain/ ./packages/domain/
COPY packages/engine/ ./packages/engine/
COPY packages/execution/ ./packages/execution/
COPY packages/logger/ ./packages/logger/
COPY packages/metrics/ ./packages/metrics/
COPY packages/observability/ ./packages/observability/
COPY services/liquidator/ ./services/liquidator/

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine AS runner

# Install pnpm for running tsx and wget for healthchecks
RUN apk add --no-cache wget=~1.25 && \
    corepack enable && corepack prepare pnpm@9.13.2 --activate

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 liquidator

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/liquidator ./services/liquidator

# Set ownership
RUN chown -R liquidator:nodejs /app

USER liquidator

WORKDIR /app/services/liquidator

# Health check for metrics server
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9090/health || exit 1

# Default command: start polling mode
CMD ["pnpm", "start"]
