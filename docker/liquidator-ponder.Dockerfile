# ============================================
# Liquidator Ponder Indexer - Multi-stage Dockerfile
# ============================================

# Stage 1: Build dependencies
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy ponder package.json
COPY services/liquidator/ponder/package.json ./services/liquidator/ponder/

# Install dependencies (workspace-aware)
RUN pnpm install --frozen-lockfile --filter @services/liquidator-ponder

# Copy ponder source code and config
COPY services/liquidator/ponder/ ./services/liquidator/ponder/

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine AS runner

# Install pnpm for running ponder and wget for healthchecks
RUN apk add --no-cache wget && \
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
COPY --from=builder /app/services/liquidator/ponder ./services/liquidator/ponder

# Set ownership
RUN chown -R ponder:nodejs /app

USER ponder

WORKDIR /app/services/liquidator/ponder

# Expose Ponder API port
EXPOSE 42069

# Health check for Ponder API
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:42069/positions || exit 1

# Default command: start production mode
CMD ["pnpm", "start"]
